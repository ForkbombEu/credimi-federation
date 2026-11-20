/**
 * Environment configuration. Every value the service publishes about its own
 * identity derives from FEDERATION_ENTITY_ID; nothing is taken from request
 * headers.
 */

/**
 * Where the private federation signing key comes from: a file on a
 * persistent volume, or a secret environment variable holding the JWK.
 */
export type SigningKeySource =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "env"; readonly variable: string; readonly value: string };

export interface AppConfig {
  /** Normalized Entity Identifier: an https origin without a trailing slash. */
  readonly entityId: string;
  readonly port: number;
  readonly signingKey: SigningKeySource;
  readonly subordinatesPath: string;
  readonly federationName: string;
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

const DEFAULT_PORT = 3000;
const DEFAULT_FEDERATION_NAME = "OpenID Federation Trust Anchor";
const KEY_PATH_VARIABLE = "FEDERATION_SIGNING_KEY_PATH";
const KEY_VARIABLE = "FEDERATION_SIGNING_KEY";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    entityId: parseEntityId(requireEnv(env, "FEDERATION_ENTITY_ID")),
    port: parsePort(env["PORT"]),
    signingKey: signingKeySource(env),
    subordinatesPath: requireEnv(env, "FEDERATION_SUBORDINATES_PATH"),
    federationName: optionalEnv(env, "FEDERATION_NAME") ?? DEFAULT_FEDERATION_NAME,
  };
}

/**
 * Exactly one of FEDERATION_SIGNING_KEY_PATH and FEDERATION_SIGNING_KEY must
 * be set. Both set is an error rather than a precedence rule, so a stale
 * variable can never silently decide which identity the service uses.
 */
export function signingKeySource(env: NodeJS.ProcessEnv): SigningKeySource {
  const path = optionalEnv(env, KEY_PATH_VARIABLE);
  const value = optionalEnv(env, KEY_VARIABLE);
  if (path !== undefined && value !== undefined) {
    throw new ConfigError(
      `Set either ${KEY_PATH_VARIABLE} or ${KEY_VARIABLE}, not both: they are two sources for the same signing key.`,
    );
  }
  if (path !== undefined) {
    return { kind: "file", path };
  }
  if (value !== undefined) {
    return { kind: "env", variable: KEY_VARIABLE, value };
  }
  throw new ConfigError(
    `Set ${KEY_PATH_VARIABLE} to the signing key file, or ${KEY_VARIABLE} to the private JWK JSON.`,
  );
}

export function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = optionalEnv(env, name);
  if (value === undefined) {
    throw new ConfigError(`${name} is required but not set.`);
  }
  return value;
}

function optionalEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

/**
 * Accepts an https URL with a host and no path, query, fragment or
 * credentials (OpenID Federation 1.0 §1.2, §9). A single trailing "/" is
 * removed, as §9 requires before appending the well-known path. Paths are
 * rejected because every route of this service is served from the origin.
 */
export function parseEntityId(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`FEDERATION_ENTITY_ID is not a valid URL: ${value}`);
  }
  if (url.protocol !== "https:") {
    throw new ConfigError("FEDERATION_ENTITY_ID must use the https scheme.");
  }
  if (url.username !== "" || url.password !== "") {
    throw new ConfigError("FEDERATION_ENTITY_ID must not contain credentials.");
  }
  if (url.search !== "" || value.includes("?")) {
    throw new ConfigError("FEDERATION_ENTITY_ID must not contain a query component.");
  }
  if (url.hash !== "" || value.includes("#")) {
    throw new ConfigError("FEDERATION_ENTITY_ID must not contain a fragment component.");
  }
  if (url.pathname !== "/") {
    throw new ConfigError(
      "FEDERATION_ENTITY_ID must be an origin without a path, for example https://federation.example.org",
    );
  }
  return url.origin;
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value.trim() === "") {
    return DEFAULT_PORT;
  }
  if (!/^\d+$/.test(value.trim())) {
    throw new ConfigError(`PORT must be an integer between 1 and 65535, got "${value}".`);
  }
  const port = Number(value);
  if (port < 1 || port > 65535) {
    throw new ConfigError(`PORT must be an integer between 1 and 65535, got "${value}".`);
  }
  return port;
}
