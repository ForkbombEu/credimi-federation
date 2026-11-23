/**
 * CLI commands. Kept separate from the executable wrapper so tests can run
 * them in-process with their own environment and output streams.
 */
import { ConfigError, loadConfig, requireEnv, signingKeySource } from "./config.js";
import type { Fetch } from "./keycheck.js";
import { generateFederationKey, KeyError, loadFederationKey, publicJwks } from "./keys.js";
import { loadRegistries, Registry, type RegistrySource } from "./registry.js";
import { SubordinateConfigError } from "./subordinates.js";
import { validateRegistry } from "./validate.js";

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export interface CliOptions {
  /** Used by `validate --live`; tests inject a stub. */
  readonly fetch?: Fetch;
}

export const BANNER = String.raw`
  ___ ___ ___ ___ ___ __  __ ___
 / __| _ \ __|   \_ _|  \/  |_ _|   credimi-federation
| (__|   / _|| |) | || |\/| || |    OpenID Federation 1.0
 \___|_|_\___|___/___|_|  |_|___|   Trust Anchor
`;

const VALIDATE_ARGUMENTS = "<registry-dir> <trust-anchor.json> [--live <member-file>...]";

const USAGE = `Usage: credimi-federation <command>

Commands:
  init      Generate the federation signing key at FEDERATION_SIGNING_KEY_PATH.
            Refuses to overwrite an existing key.
  check     Validate the signing key and both registries exactly as startup does.
  jwks      Print the public federation JWK Set (JSON) to standard output.
  validate  ${VALIDATE_ARGUMENTS}
            Validate a GitHub registry without any key; with --live, every
            listed enabled member must pass every live key check. Prints a
            Markdown report.
  help      Show this message.

The signing key is read from FEDERATION_SIGNING_KEY_PATH (a file) or from
FEDERATION_SIGNING_KEY (the private JWK JSON); set exactly one of them.
`;

/** Runs one command and returns the process exit code. */
export async function runCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  io: CliIo,
  options: CliOptions = {},
): Promise<number> {
  // The banner goes to stderr so `jwks` and `validate` output stays clean.
  io.stderr(BANNER);
  const [command, ...rest] = argv;
  if (command !== "validate" && rest.length > 0) {
    io.stderr(`Unexpected arguments: ${rest.join(" ")}\n\n${USAGE}`);
    return 2;
  }
  try {
    switch (command) {
      case "init": {
        const path = requireEnv(env, "FEDERATION_SIGNING_KEY_PATH");
        const key = await generateFederationKey(path);
        io.stderr(
          `Created ES256 federation signing key\n  path: ${path}\n  kid:  ${key.kid}\n` +
            "Back up this file now; it is the federation's identity.\n" +
            "To supply it as the FEDERATION_SIGNING_KEY secret instead, use the file's content on one line:\n" +
            `  tr -d ' \\n' < ${path}\n`,
        );
        return 0;
      }
      case "check": {
        const config = loadConfig(env);
        const key = await loadFederationKey(config.signingKey);
        const registry = await Registry.create(
          { entityId: config.entityId, key, path: config.subordinatesPath },
          await loadRegistries(config, key),
        );
        const count = (source: RegistrySource): number =>
          registry.members.filter((member) => member.source === source).length;
        const overridden = registry.members.filter((member) => member.overridden).length;
        io.stderr(
          `Configuration is valid\n  entity id:    ${config.entityId}\n  kid:          ${key.kid}\n` +
            `  GitHub:       ${count("github")} registered\n` +
            `  local:        ${count("local")} registered, ${overridden} overridden by GitHub\n` +
            `  admin area:   ${config.adminPassword === undefined ? "off" : "on"}\n`,
        );
        return 0;
      }
      case "validate": {
        const [registryDir, descriptorPath, flag, ...liveFiles] = rest;
        if (
          registryDir === undefined ||
          descriptorPath === undefined ||
          (flag !== undefined && flag !== "--live")
        ) {
          io.stderr(`Usage: credimi-federation validate ${VALIDATE_ARGUMENTS}\n`);
          return 2;
        }
        return await validateRegistry(
          {
            registryDir,
            descriptorPath,
            ...(flag === undefined ? {} : { liveFiles }),
            fetch: options.fetch ?? fetch,
          },
          io.stdout,
        );
      }
      case "jwks": {
        const key = await loadFederationKey(signingKeySource(env));
        io.stdout(`${JSON.stringify(publicJwks(key), null, 2)}\n`);
        return 0;
      }
      case "help":
      case "--help":
      case "-h":
        io.stdout(USAGE);
        return 0;
      default:
        io.stderr(command === undefined ? USAGE : `Unknown command "${command}"\n\n${USAGE}`);
        return 2;
    }
  } catch (error) {
    if (
      error instanceof ConfigError ||
      error instanceof KeyError ||
      error instanceof SubordinateConfigError
    ) {
      io.stderr(`Error: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}
