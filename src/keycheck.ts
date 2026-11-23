/**
 * "Check live keys": fetches a subordinate's Entity Configuration and
 * compares it with the keys the operator pinned. It reports; it never
 * changes the registry. Pinning keys taken from this response would let
 * whoever answers at the URL join the federation, which is exactly what
 * out-of-band pinning prevents.
 */
import {
  calculateJwkThumbprint,
  compactVerify,
  decodeJwt,
  decodeProtectedHeader,
  importJWK,
  type JWK,
  type JWTPayload,
  type ProtectedHeaderParameters,
} from "jose";
import type { Subordinate } from "./subordinates.js";

export const FETCH_TIMEOUT_MS = 5000;
export const MAX_ENTITY_CONFIGURATION_BYTES = 256 * 1024;

/** The subset of the WHATWG fetch signature the check needs; injectable for tests. */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface KeyCheck {
  readonly label: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface KeyCheckReport {
  readonly url: string;
  readonly checks: readonly KeyCheck[];
}

/** OpenID Federation 1.0 §9: the well-known path is appended after removing a trailing "/". */
export function entityConfigurationUrl(entityId: string): string {
  return `${entityId.replace(/\/$/, "")}/.well-known/openid-federation`;
}

/**
 * `attempts` above 1 retries a request that failed or got a 5xx answer, each
 * attempt with its own timeout; unattended checks use it so a single network
 * hiccup does not report a member as broken.
 */
export async function checkLiveKeys(
  subordinate: Subordinate,
  trustAnchorId: string,
  fetchFn: Fetch,
  attempts = 1,
): Promise<KeyCheckReport> {
  const url = entityConfigurationUrl(subordinate.entityId);
  const checks: KeyCheck[] = [];
  const reachable = "Entity Configuration is reachable";

  let fetched = await fetchStatement(url, fetchFn);
  for (
    let attempt = 1;
    attempt < attempts && typeof fetched !== "string" && fetched.transient;
    attempt += 1
  ) {
    fetched = await fetchStatement(url, fetchFn);
  }
  if (typeof fetched !== "string") {
    checks.push({ label: reachable, ok: false, detail: fetched.error });
    return { url, checks };
  }
  let header: ProtectedHeaderParameters;
  let payload: JWTPayload;
  try {
    header = decodeProtectedHeader(fetched);
    payload = decodeJwt(fetched);
  } catch {
    checks.push({ label: reachable, ok: false, detail: "The response is not a signed JWT." });
    return { url, checks };
  }
  checks.push({ label: reachable, ok: true, detail: `${url} answered with a signed JWT.` });

  checks.push(identityCheck(subordinate.entityId, payload));
  checks.push(await signatureCheck(subordinate, fetched, header));
  checks.push(await publishedKeysCheck(subordinate, payload));
  checks.push(authorityHintsCheck(trustAnchorId, payload));
  checks.push(expiryCheck(payload, Date.now()));
  return { url, checks };
}

/** The compact JWT, or why it could not be fetched; `transient` failures are worth retrying. */
async function fetchStatement(
  url: string,
  fetchFn: Fetch,
): Promise<string | { error: string; transient: boolean }> {
  let response: Response;
  try {
    response = await fetchFn(url, {
      redirect: "error",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: "application/entity-statement+jwt" },
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      return { error: `No response within ${FETCH_TIMEOUT_MS / 1000} seconds.`, transient: true };
    }
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
    return {
      error: `The request failed: ${cause instanceof Error ? cause.message : "unknown"}.`,
      transient: true,
    };
  }
  if (response.status !== 200) {
    return {
      error: `The server answered HTTP ${response.status}.`,
      transient: response.status >= 500,
    };
  }
  const body = await response.text();
  if (body.length > MAX_ENTITY_CONFIGURATION_BYTES) {
    return {
      error: `The response is larger than ${MAX_ENTITY_CONFIGURATION_BYTES} bytes.`,
      transient: false,
    };
  }
  return body.trim();
}

function identityCheck(entityId: string, payload: JWTPayload): KeyCheck {
  const expected = withoutTrailingSlash(entityId);
  const ok =
    typeof payload.iss === "string" &&
    payload.iss === payload.sub &&
    withoutTrailingSlash(payload.iss) === expected;
  return {
    label: "Issued by the subordinate about itself",
    ok,
    detail: `iss ${String(payload.iss)}, sub ${String(payload.sub)}; expected both to be ${expected}.`,
  };
}

async function signatureCheck(
  subordinate: Subordinate,
  jwt: string,
  header: ProtectedHeaderParameters,
): Promise<KeyCheck> {
  const label = "Signed with a pinned key";
  if (header.kid === undefined || typeof header.alg !== "string") {
    return { label, ok: false, detail: "The JWS header has no kid or no alg." };
  }
  const pinned = subordinate.jwks.keys.find((key) => key.kid === header.kid);
  if (pinned === undefined) {
    return {
      label,
      ok: false,
      detail: `Signed with kid ${header.kid}, which is not pinned. Trust Chain validation will fail.`,
    };
  }
  try {
    await compactVerify(jwt, await importJWK(pinned, header.alg));
    return { label, ok: true, detail: `The signature verifies with pinned key ${header.kid}.` };
  } catch {
    return {
      label,
      ok: false,
      detail: `The signature does not verify with pinned key ${header.kid} (${header.alg}).`,
    };
  }
}

async function publishedKeysCheck(
  subordinate: Subordinate,
  payload: JWTPayload,
): Promise<KeyCheck> {
  const label = "Published keys match the pinned keys";
  const jwks = payload["jwks"];
  const keys =
    typeof jwks === "object" && jwks !== null && "keys" in jwks && Array.isArray(jwks.keys)
      ? (jwks.keys as unknown[])
      : undefined;
  if (keys === undefined) {
    return { label, ok: false, detail: "The Entity Configuration has no jwks.keys array." };
  }

  const published = new Map<string, string | undefined>();
  for (const key of keys) {
    if (typeof key === "object" && key !== null && "kid" in key && typeof key.kid === "string") {
      published.set(key.kid, await thumbprint(key as JWK));
    }
  }
  const problems: string[] = [];
  for (const key of subordinate.jwks.keys) {
    const kid = key.kid ?? "";
    if (!published.has(kid)) {
      problems.push(`pinned ${kid} is not published`);
    } else if (published.get(kid) !== (await thumbprint(key))) {
      problems.push(`${kid} is published with different key material`);
    }
  }
  const pinnedKids = new Set(subordinate.jwks.keys.map((key) => key.kid));
  for (const kid of published.keys()) {
    if (!pinnedKids.has(kid)) {
      problems.push(`published ${kid} is not pinned`);
    }
  }
  return problems.length === 0
    ? { label, ok: true, detail: `All ${published.size} published key(s) are pinned unchanged.` }
    : { label, ok: false, detail: `${problems.join("; ")}.` };
}

function authorityHintsCheck(trustAnchorId: string, payload: JWTPayload): KeyCheck {
  const hints = payload["authority_hints"];
  const list = Array.isArray(hints) ? hints.filter((hint) => typeof hint === "string") : [];
  const ok = list.some((hint) => withoutTrailingSlash(hint) === trustAnchorId);
  return {
    label: "authority_hints names this Trust Anchor",
    ok,
    detail:
      list.length === 0
        ? "The Entity Configuration has no authority_hints."
        : `authority_hints: ${list.join(", ")}.`,
  };
}

function expiryCheck(payload: JWTPayload, nowMs: number): KeyCheck {
  const ok = typeof payload.exp === "number" && payload.exp * 1000 > nowMs;
  return {
    label: "Not expired",
    ok,
    detail:
      typeof payload.exp === "number"
        ? `exp ${new Date(payload.exp * 1000).toISOString()}.`
        : "The Entity Configuration has no exp.",
  };
}

async function thumbprint(key: JWK): Promise<string | undefined> {
  try {
    return await calculateJwkThumbprint(key, "sha256");
  } catch {
    return undefined;
  }
}

function withoutTrailingSlash(value: string): string {
  return value.replace(/\/$/, "");
}
