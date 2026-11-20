/**
 * Admin authentication: one shared password, random in-memory sessions and a
 * per-session CSRF token. Sessions are lost on restart, which only means
 * signing in again; nothing else depends on them.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** `__Host-` binds the cookie to this origin, path `/`, and HTTPS. */
export const SESSION_COOKIE = "__Host-federation-admin";
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
export const LOGIN_FAILURE_LIMIT = 10;
export const LOGIN_FAILURE_WINDOW_MS = 60 * 1000;

export interface AdminSession {
  readonly id: string;
  readonly csrfToken: string;
  readonly expiresAt: number;
}

export type LoginResult =
  | { readonly ok: true; readonly session: AdminSession }
  | { readonly ok: false; readonly reason: "invalid" | "throttled" };

export class AdminSessions {
  readonly #passwordDigest: Buffer;
  readonly #sessions = new Map<string, AdminSession>();
  #failures: number[] = [];

  constructor(
    password: string,
    private readonly now: () => number = Date.now,
  ) {
    this.#passwordDigest = digest(password);
  }

  /**
   * Checks the password and starts a session. Failed attempts are counted
   * for the whole service, because behind a proxy every client shares one
   * address; once the limit is reached even the right password is refused
   * until the oldest failure leaves the window.
   */
  login(candidate: string): LoginResult {
    const now = this.now();
    this.#failures = this.#failures.filter((at) => now - at < LOGIN_FAILURE_WINDOW_MS);
    if (this.#failures.length >= LOGIN_FAILURE_LIMIT) {
      return { ok: false, reason: "throttled" };
    }
    if (!timingSafeEqual(digest(candidate), this.#passwordDigest)) {
      this.#failures.push(now);
      return { ok: false, reason: "invalid" };
    }
    for (const [id, session] of this.#sessions) {
      if (session.expiresAt <= now) {
        this.#sessions.delete(id);
      }
    }
    const session: AdminSession = {
      id: randomToken(),
      csrfToken: randomToken(),
      expiresAt: now + SESSION_TTL_MS,
    };
    this.#sessions.set(session.id, session);
    return { ok: true, session };
  }

  /** The live session for a cookie value, if any. */
  get(id: string | undefined): AdminSession | undefined {
    if (id === undefined) {
      return undefined;
    }
    const session = this.#sessions.get(id);
    if (session !== undefined && session.expiresAt <= this.now()) {
      this.#sessions.delete(id);
      return undefined;
    }
    return session;
  }

  end(id: string): void {
    this.#sessions.delete(id);
  }
}

export function csrfTokenMatches(session: AdminSession, candidate: string | null): boolean {
  return candidate !== null && timingSafeEqual(digest(candidate), digest(session.csrfToken));
}

/** The session id from a Cookie request header. */
export function sessionIdFromCookies(header: string | undefined): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator !== -1 && part.slice(0, separator).trim() === SESSION_COOKIE) {
      return part.slice(separator + 1).trim();
    }
  }
  return undefined;
}

export function sessionCookie(session: AdminSession): string {
  return `${SESSION_COOKIE}=${session.id}; ${cookieAttributes(SESSION_TTL_MS / 1000)}`;
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; ${cookieAttributes(0)}`;
}

function cookieAttributes(maxAgeSeconds: number): string {
  return `Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Strict`;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}
