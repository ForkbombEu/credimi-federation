/**
 * `credimi-federation validate`: checks a GitHub registry directory without
 * the Trust Anchor's private key, for pull request CI. The Trust Anchor is
 * described by a committed file holding its Entity Identifier and public
 * JWKS. With `--live`, each named member file whose entry is enabled must
 * also pass every live key check. The report is Markdown on standard output,
 * so CI can show it as a job summary.
 */
import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { z } from "zod";
import { ConfigError, parseEntityId } from "./config.js";
import { checkLiveKeys, type Fetch } from "./keycheck.js";
import {
  loadRegistryDirectory,
  registryFileName,
  SubordinateConfigError,
  type RegistryOwner,
} from "./subordinates.js";

const PRIVATE_JWK_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "oth", "k"];

const DescriptorSchema = z.strictObject({
  entity_id: z.string(),
  jwks: z.strictObject({
    keys: z.array(z.looseObject({ kty: z.string(), kid: z.string().min(1) })).min(1),
  }),
});

/** Reads `{"entity_id": …, "jwks": {"keys": [...]}}`, the Trust Anchor's public identity. */
export async function loadTrustAnchorDescriptor(path: string): Promise<RegistryOwner> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new ConfigError(`${path} is missing or not valid JSON.`);
  }
  const parsed = DescriptorSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(
      `${path} must be {"entity_id": "...", "jwks": {"keys": [...]}}: ${z.prettifyError(parsed.error)}`,
    );
  }
  for (const key of parsed.data.jwks.keys) {
    if (PRIVATE_JWK_MEMBERS.some((member) => member in key)) {
      throw new ConfigError(`${path} contains private key material; publish only public keys.`);
    }
  }
  return {
    entityId: parseEntityId(parsed.data.entity_id),
    publicKeys: parsed.data.jwks.keys,
  };
}

export interface ValidateOptions {
  readonly registryDir: string;
  readonly descriptorPath: string;
  /** Member files to live-check; undefined skips the live check. */
  readonly liveFiles?: readonly string[];
  readonly fetch: Fetch;
}

/** Returns the exit code; writes the Markdown report through `write`. */
export async function validateRegistry(
  options: ValidateOptions,
  write: (text: string) => void,
): Promise<number> {
  const owner = await loadTrustAnchorDescriptor(options.descriptorPath);
  write("## GitHub registry\n\n");
  let subordinates;
  try {
    subordinates = await loadRegistryDirectory(options.registryDir, owner);
  } catch (error) {
    if (!(error instanceof SubordinateConfigError)) {
      throw error;
    }
    write(`**Invalid.** Fix these problems in \`${options.registryDir}\`:\n\n`);
    write(`${error.issues.map((issue) => `- ${issue.replace(/\n/g, " ")}`).join("\n")}\n`);
    return 1;
  }
  const enabled = subordinates.filter((entry) => entry.enabled).length;
  write(
    `Valid: ${subordinates.length} subordinate(s), ${enabled} enabled, checked against ` +
      `${owner.entityId}.\n`,
  );

  if (options.liveFiles === undefined) {
    return 0;
  }
  write("\n## Live key checks\n\n");
  if (options.liveFiles.length === 0) {
    write("No added or modified member files.\n");
    return 0;
  }
  let failed = false;
  const directory = resolve(options.registryDir);
  for (const file of options.liveFiles) {
    const name = basename(file);
    const subordinate =
      dirname(resolve(file)) === directory
        ? subordinates.find((entry) => registryFileName(entry.entityId) === name)
        : undefined;
    if (subordinate === undefined) {
      write(`### \`${file}\`\n\nFAIL: not a member file of \`${options.registryDir}\`.\n\n`);
      failed = true;
      continue;
    }
    write(`### ${subordinate.entityId} (\`${name}\`)\n\n`);
    if (!subordinate.enabled) {
      write("Skipped: the entry is disabled, so it is not served.\n\n");
      continue;
    }
    const report = await checkLiveKeys(subordinate, owner.entityId, options.fetch);
    for (const check of report.checks) {
      write(`- ${check.ok ? "PASS" : "FAIL"} ${check.label}: ${check.detail}\n`);
    }
    write("\n");
    failed ||= !report.checks.every((check) => check.ok);
  }
  write(failed ? "**Some live checks failed.**\n" : "All live checks passed.\n");
  return failed ? 1 : 0;
}
