import { describe, expect, it } from "vitest";
import {
  AdminSessions,
  clearedSessionCookie,
  csrfTokenMatches,
  LOGIN_FAILURE_LIMIT,
  LOGIN_FAILURE_WINDOW_MS,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  sessionCookie,
  sessionIdFromCookies,
  type AdminSession,
} from "../src/sessions.js";

const PASSWORD = "correct horse battery staple";

function clock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function signIn(sessions: AdminSessions): AdminSession {
  const result = sessions.login(PASSWORD);
  if (!result.ok) {
    throw new Error(`login failed: ${result.reason}`);
  }
  return result.session;
}

describe("AdminSessions", () => {
  it("starts a session only for the configured password", () => {
    const sessions = new AdminSessions(PASSWORD);
    expect(sessions.login("correct horse battery stapl")).toEqual({
      ok: false,
      reason: "invalid",
    });
    const session = signIn(sessions);
    expect(sessions.get(session.id)).toEqual(session);
    expect(session.id).not.toBe(session.csrfToken);
    expect(sessions.get("forged")).toBeUndefined();
  });

  it("refuses every login after too many failures, then recovers", () => {
    const time = clock();
    const sessions = new AdminSessions(PASSWORD, time.now);
    for (let attempt = 0; attempt < LOGIN_FAILURE_LIMIT; attempt += 1) {
      expect(sessions.login("wrong")).toMatchObject({ reason: "invalid" });
    }
    expect(sessions.login(PASSWORD)).toEqual({ ok: false, reason: "throttled" });

    time.advance(LOGIN_FAILURE_WINDOW_MS);
    expect(sessions.login(PASSWORD).ok).toBe(true);
  });

  it("expires sessions after their lifetime and ends them on logout", () => {
    const time = clock();
    const sessions = new AdminSessions(PASSWORD, time.now);
    const expiring = signIn(sessions);
    const ended = signIn(sessions);

    sessions.end(ended.id);
    expect(sessions.get(ended.id)).toBeUndefined();

    time.advance(SESSION_TTL_MS - 1);
    expect(sessions.get(expiring.id)).toBeDefined();
    time.advance(1);
    expect(sessions.get(expiring.id)).toBeUndefined();
  });

  it("accepts only the session's own CSRF token", () => {
    const sessions = new AdminSessions(PASSWORD);
    const first = signIn(sessions);
    const second = signIn(sessions);
    expect(csrfTokenMatches(first, first.csrfToken)).toBe(true);
    expect(csrfTokenMatches(first, second.csrfToken)).toBe(false);
    expect(csrfTokenMatches(first, null)).toBe(false);
    expect(csrfTokenMatches(first, "")).toBe(false);
  });
});

describe("session cookie", () => {
  it("is host-only, HTTPS-only, script-proof and same-site", () => {
    const session = signIn(new AdminSessions(PASSWORD));
    const cookie = sessionCookie(session);
    expect(cookie.startsWith(`${SESSION_COOKIE}=${session.id};`)).toBe(true);
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).not.toMatch(/Domain=/i);
    expect(clearedSessionCookie()).toContain("Max-Age=0");
  });

  it("is found among other cookies", () => {
    expect(sessionIdFromCookies(`a=1; ${SESSION_COOKIE}=abc; b=2`)).toBe("abc");
    expect(sessionIdFromCookies(`x${SESSION_COOKIE}=abc`)).toBeUndefined();
    expect(sessionIdFromCookies(undefined)).toBeUndefined();
  });
});
