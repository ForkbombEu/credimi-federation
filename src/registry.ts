/**
 * The live subordinate registry: the GitHub registry (read-only at runtime),
 * the local registry (changed by the admin area) and the TrustAnchor that
 * serves their union, replaced together after every admin change.
 *
 * The served registry is every GitHub entry plus every local entry whose
 * Entity Identifier the GitHub registry does not hold: GitHub wins. A local
 * entry that GitHub overrides stays in the local file but is not served.
 *
 * A change is applied in a fixed order, one change at a time: validate the
 * whole new local registry exactly as startup does, build a new TrustAnchor,
 * write the file atomically, and only then swap the in-memory state. A change
 * that fails at any step leaves both the file and the served statements as
 * they were.
 */
import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { TrustAnchor } from "@oidfed/authority";
import type { AppConfig } from "./config.js";
import { createTrustAnchor } from "./federation.js";
import type { FederationKey } from "./keys.js";
import {
  loadRegistryDirectory,
  loadSubordinates,
  parseSubordinates,
  serializeSubordinates,
  toRegistryEntry,
  type RegistryEntry,
  type RegistryOwner,
  type Subordinate,
} from "./subordinates.js";

export interface RegistryOptions {
  readonly entityId: string;
  readonly key: FederationKey;
  /** The local registry file written by every change. */
  readonly path: string;
}

export interface RegistrySources {
  readonly local: readonly Subordinate[];
  readonly github: readonly Subordinate[];
}

export type RegistrySource = "github" | "local";

/** One registry entry as the admin area shows it. */
export interface RegistryMember {
  readonly subordinate: Subordinate;
  readonly source: RegistrySource;
  /** A local entry whose Entity Identifier the GitHub registry also holds; not served. */
  readonly overridden: boolean;
}

/** The registry could not be persisted; nothing was changed. */
export class RegistryWriteError extends Error {
  override readonly name = "RegistryWriteError";
  constructor(
    readonly path: string,
    readonly code: string,
  ) {
    super(
      `Could not write the subordinate registry ${path} (${code}). The service must be able to ` +
        "create files in its directory: mount a writable volume directory there. A single-file " +
        "bind mount, such as a Coolify File Mount, cannot be replaced.",
    );
  }
}

/** A change named a subordinate that is not (or no longer) in the local registry. */
export class UnknownSubordinateError extends Error {
  override readonly name = "UnknownSubordinateError";
  constructor(readonly entityId: string) {
    super(`No subordinate ${entityId} is registered.`);
  }
}

/** A change would give a local entry an Entity Identifier the GitHub registry holds. */
export class GitHubManagedError extends Error {
  override readonly name = "GitHubManagedError";
  constructor(readonly entityId: string) {
    super(
      `${entityId} is managed in the GitHub registry. Change it with a pull request to ` +
        "registry/ instead.",
    );
  }
}

/** The Trust Anchor identity registries are validated against. */
export function registryOwner(entityId: string, key: FederationKey): RegistryOwner {
  return { entityId, publicKeys: [key.publicJwk] };
}

/**
 * Loads both registries as startup does. A missing local file is an empty
 * local registry when the admin area can create it or when the GitHub
 * registry is in use.
 */
export async function loadRegistries(
  config: AppConfig,
  key: FederationKey,
): Promise<RegistrySources> {
  const owner = registryOwner(config.entityId, key);
  const local = await loadSubordinates(config.subordinatesPath, owner, {
    missingIsEmpty: config.adminPassword !== undefined || config.registryDir !== undefined,
  });
  const github =
    config.registryDir === undefined ? [] : await loadRegistryDirectory(config.registryDir, owner);
  return { local, github };
}

interface State {
  readonly local: readonly Subordinate[];
  readonly members: readonly RegistryMember[];
  readonly served: readonly Subordinate[];
  readonly trustAnchor: TrustAnchor;
}

export class Registry {
  readonly #github: readonly Subordinate[];
  readonly #githubIds: ReadonlySet<string>;
  #state: State;
  #queue: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly options: RegistryOptions,
    github: readonly Subordinate[],
    state: State,
  ) {
    this.#github = github;
    this.#githubIds = new Set(github.map((entry) => normalize(entry.entityId)));
    this.#state = state;
  }

  /** Wraps already-validated registries; does not touch the file. */
  static async create(options: RegistryOptions, sources: RegistrySources): Promise<Registry> {
    const githubIds = new Set(sources.github.map((entry) => normalize(entry.entityId)));
    const state = await buildState(options, sources.github, githubIds, sources.local);
    return new Registry(options, sources.github, state);
  }

  /** The served subordinates: GitHub entries, then local entries GitHub does not override. */
  get subordinates(): readonly Subordinate[] {
    return this.#state.served;
  }

  /** Every entry of both registries, including overridden local ones. */
  get members(): readonly RegistryMember[] {
    return this.#state.members;
  }

  /** The local registry, which the admin area may change. */
  get local(): readonly Subordinate[] {
    return this.#state.local;
  }

  get trustAnchor(): TrustAnchor {
    return this.#state.trustAnchor;
  }

  isGitHubManaged(entityId: string): boolean {
    return this.#githubIds.has(normalize(entityId));
  }

  /**
   * Applies `change` to the local entries, then validates, persists and
   * swaps. Changes are serialized, so `change` always sees the result of the
   * previous one. A change may keep an existing override but never create
   * one. Throws SubordinateConfigError for an invalid result,
   * GitHubManagedError for a new override, RegistryWriteError if the file
   * cannot be written, and whatever `change` throws (UnknownSubordinateError
   * for a vanished entry).
   */
  update(change: (entries: RegistryEntry[]) => RegistryEntry[]): Promise<void> {
    const run = async (): Promise<void> => {
      const before = new Set(
        this.#state.local
          .map((entry) => normalize(entry.entityId))
          .filter((id) => this.#githubIds.has(id)),
      );
      const next = change(this.#state.local.map(toRegistryEntry));
      const created = next.find(
        (entry) =>
          this.#githubIds.has(normalize(entry.entity_id)) &&
          !before.has(normalize(entry.entity_id)),
      );
      if (created !== undefined) {
        throw new GitHubManagedError(created.entity_id);
      }
      const owner = registryOwner(this.options.entityId, this.options.key);
      const local = await parseSubordinates({ subordinates: next }, owner, this.options.path);
      const state = await buildState(this.options, this.#github, this.#githubIds, local);
      await writeAtomically(this.options.path, serializeSubordinates(local));
      this.#state = state;
    };
    const result = this.#queue.then(run, run);
    this.#queue = result.catch(() => undefined);
    return result;
  }
}

async function buildState(
  options: RegistryOptions,
  github: readonly Subordinate[],
  githubIds: ReadonlySet<string>,
  local: readonly Subordinate[],
): Promise<State> {
  const members: RegistryMember[] = [
    ...github.map((subordinate) => ({ subordinate, source: "github" as const, overridden: false })),
    ...local.map((subordinate) => ({
      subordinate,
      source: "local" as const,
      overridden: githubIds.has(normalize(subordinate.entityId)),
    })),
  ];
  const served = members.filter((member) => !member.overridden).map((member) => member.subordinate);
  const trustAnchor = await createTrustAnchor({
    entityId: options.entityId,
    key: options.key,
    subordinates: served,
  });
  return { local, members, served, trustAnchor };
}

function normalize(entityId: string): string {
  return entityId.replace(/\/$/, "");
}

/**
 * Writes `content` to a temporary file next to `path`, flushes it to disk and
 * renames it over `path`, so a reader or a crash sees either the old or the
 * new registry, never a partial one.
 */
async function writeAtomically(path: string, content: string): Promise<void> {
  const directory = dirname(path);
  const temporary = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await mkdir(directory, { recursive: true });
    const handle = await open(temporary, "wx", 0o644);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    const code =
      error instanceof Error && "code" in error && typeof error.code === "string"
        ? error.code
        : "unknown error";
    throw new RegistryWriteError(path, code);
  }
}
