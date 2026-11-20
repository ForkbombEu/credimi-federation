/**
 * The live subordinate registry: the validated subordinates and the
 * TrustAnchor that serves them, replaced together after every admin change.
 *
 * A change is applied in a fixed order, one change at a time: validate the
 * whole new registry exactly as startup does, build a new TrustAnchor, write
 * the file atomically, and only then swap the in-memory state. A change that
 * fails at any step leaves both the file and the served statements as they
 * were.
 */
import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { TrustAnchor } from "@oidfed/authority";
import { createTrustAnchor } from "./federation.js";
import type { FederationKey } from "./keys.js";
import {
  parseSubordinates,
  serializeSubordinates,
  toRegistryEntry,
  type RegistryEntry,
  type Subordinate,
} from "./subordinates.js";

export interface RegistryOptions {
  readonly entityId: string;
  readonly key: FederationKey;
  /** The registry file written by every change. */
  readonly path: string;
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

/** A change named a subordinate that is not (or no longer) registered. */
export class UnknownSubordinateError extends Error {
  override readonly name = "UnknownSubordinateError";
  constructor(readonly entityId: string) {
    super(`No subordinate ${entityId} is registered.`);
  }
}

interface State {
  readonly subordinates: readonly Subordinate[];
  readonly trustAnchor: TrustAnchor;
}

export class Registry {
  #state: State;
  #queue: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly options: RegistryOptions,
    state: State,
  ) {
    this.#state = state;
  }

  /** Wraps already-validated subordinates; does not touch the file. */
  static async create(
    options: RegistryOptions,
    subordinates: readonly Subordinate[],
  ): Promise<Registry> {
    const trustAnchor = await createTrustAnchor({
      entityId: options.entityId,
      key: options.key,
      subordinates,
    });
    return new Registry(options, { subordinates, trustAnchor });
  }

  get subordinates(): readonly Subordinate[] {
    return this.#state.subordinates;
  }

  get trustAnchor(): TrustAnchor {
    return this.#state.trustAnchor;
  }

  /** Index of the subordinate with this Entity Identifier, or -1. */
  indexOf(entityId: string): number {
    return this.#state.subordinates.findIndex((entry) => entry.entityId === entityId);
  }

  /**
   * Applies `change` to the current entries, then validates, persists and
   * swaps. Changes are serialized, so `change` always sees the result of the
   * previous one. Throws SubordinateConfigError for an invalid result,
   * RegistryWriteError if the file cannot be written, and whatever `change`
   * throws (UnknownSubordinateError for a vanished entry).
   */
  update(change: (entries: RegistryEntry[]) => RegistryEntry[]): Promise<void> {
    const run = async (): Promise<void> => {
      const next = change(this.#state.subordinates.map(toRegistryEntry));
      const owner = { entityId: this.options.entityId, key: this.options.key };
      const subordinates = await parseSubordinates(
        { subordinates: next },
        owner,
        this.options.path,
      );
      const trustAnchor = await createTrustAnchor({
        entityId: this.options.entityId,
        key: this.options.key,
        subordinates,
      });
      await writeAtomically(this.options.path, serializeSubordinates(subordinates));
      this.#state = { subordinates, trustAnchor };
    };
    const result = this.#queue.then(run, run);
    this.#queue = result.catch(() => undefined);
    return result;
  }
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
