import { readFile } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { SignJWT, type JWK } from "jose";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { Fetch } from "../src/keycheck.js";
import { LOGIN_FAILURE_LIMIT, SESSION_COOKIE } from "../src/sessions.js";
import {
  createFixture,
  ENTITY_ID,
  nowSeconds,
  subordinateKey,
  type SubordinateKey,
} from "./helpers.js";

const PASSWORD = "admin password for the tests";
const ISSUER = "https://issuer.test.example/issuers/a";
const FORM = "application/x-www-form-urlencoded";

const unreachable: Fetch = () => Promise.reject(new Error("no network in tests"));

async function adminSite(fetch: Fetch = unreachable) {
  const fixture = await createFixture({ adminPassword: PASSWORD });
  // No registry file exists yet: the admin area starts from an empty registry.
  const app = await buildApp(
    { config: fixture.config, key: fixture.key, subordinates: [] },
    { fetch },
  );
  return { app, path: fixture.config.subordinatesPath };
}

interface Session {
  readonly cookie: string;
  readonly csrf: string;
}

async function signIn(app: FastifyInstance): Promise<Session> {
  const response = await post(app, "/admin/login", { password: PASSWORD });
  expect(response.statusCode).toBe(303);
  const setCookie = String(response.headers["set-cookie"]);
  const cookie = setCookie.split(";")[0] ?? "";
  const page = await app.inject({ method: "GET", url: "/admin", headers: { cookie } });
  const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)?.[1] ?? "";
  expect(csrf).not.toBe("");
  return { cookie, csrf };
}

function post(
  app: FastifyInstance,
  url: string,
  fields: Record<string, string>,
  session?: Session,
) {
  return app.inject({
    method: "POST",
    url,
    headers: { "content-type": FORM, ...(session === undefined ? {} : { cookie: session.cookie }) },
    payload: new URLSearchParams({
      ...(session === undefined ? {} : { csrf: session.csrf }),
      ...fields,
    }).toString(),
  });
}

function get(app: FastifyInstance, url: string, session?: Session) {
  return app.inject({
    method: "GET",
    url,
    headers: session === undefined ? {} : { cookie: session.cookie },
  });
}

function entryFields(key: SubordinateKey, overrides: Record<string, string> = {}) {
  return {
    entity_id: ISSUER,
    entity_types: "openid_credential_issuer",
    jwks: JSON.stringify({ keys: [key.publicJwk] }),
    enabled: "on",
    metadata_policy: "",
    constraints: '{"max_path_length": 0}',
    ...overrides,
  };
}

async function fetchStatus(app: FastifyInstance, sub: string): Promise<number> {
  return (await get(app, `/federation_fetch?sub=${encodeURIComponent(sub)}`)).statusCode;
}

describe("admin area availability", () => {
  it("does not exist without FEDERATION_ADMIN_PASSWORD", async () => {
    const { config, key } = await createFixture();
    const app = await buildApp({ config, key, subordinates: [] });
    for (const url of ["/admin", "/admin/login"]) {
      const response = await get(app, url);
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: "not_found" });
    }
  });

  it("is not linked from the public pages", async () => {
    const { app } = await adminSite();
    expect((await get(app, "/")).body).not.toContain("/admin");
  });
});

describe("admin sign-in", () => {
  it("sends anonymous visitors to the login page and changes nothing for them", async () => {
    const { app, path } = await adminSite();
    const page = await get(app, "/admin");
    expect(page.statusCode).toBe(303);
    expect(page.headers.location).toBe("/admin/login");

    const key = await subordinateKey();
    const write = await post(app, "/admin/new", entryFields(key));
    expect(write.statusCode).toBe(303);
    expect(write.headers.location).toBe("/admin/login");
    await expect(readFile(path)).rejects.toThrow();
    expect(await fetchStatus(app, ISSUER)).toBe(404);
  });

  it("refuses a wrong password without starting a session", async () => {
    const { app } = await adminSite();
    const response = await post(app, "/admin/login", { password: "not the admin password" });
    expect(response.statusCode).toBe(401);
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.body).toContain("The password is not correct.");
  });

  it("sets a hardened session cookie and serves admin pages with a noindex, same-origin CSP", async () => {
    const { app } = await adminSite();
    const login = await post(app, "/admin/login", { password: PASSWORD });
    expect(String(login.headers["set-cookie"])).toMatch(
      new RegExp(`^${SESSION_COOKIE}=[^;]+; .*HttpOnly; Secure; SameSite=Strict`),
    );
    const session = await signIn(app);
    const page = await get(app, "/admin", session);
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-security-policy"]).toMatch(/form-action 'self'/);
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.body).toContain('<meta name="robots" content="noindex, nofollow" />');
    expect(page.body).toContain('class="credimi-extras-bar"');
  });

  it("throttles password guessing, even for the right password", async () => {
    const { app } = await adminSite();
    for (let attempt = 0; attempt < LOGIN_FAILURE_LIMIT; attempt += 1) {
      await post(app, "/admin/login", { password: `guess number ${attempt} xxxxxxx` });
    }
    const response = await post(app, "/admin/login", { password: PASSWORD });
    expect(response.statusCode).toBe(429);
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("ends the session on sign-out", async () => {
    const { app } = await adminSite();
    const session = await signIn(app);
    const logout = await post(app, "/admin/logout", {}, session);
    expect(logout.statusCode).toBe(303);
    expect(String(logout.headers["set-cookie"])).toContain("Max-Age=0");
    expect((await get(app, "/admin", session)).statusCode).toBe(303);
  });
});

describe("admin registry changes", () => {
  it("adds a subordinate that is served at once and persisted", async () => {
    const { app, path } = await adminSite();
    const session = await signIn(app);
    const key = await subordinateKey();

    const response = await post(app, "/admin/new", entryFields(key), session);
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe(`/admin?done=added&sub=${encodeURIComponent(ISSUER)}`);

    expect(await fetchStatus(app, ISSUER)).toBe(200);
    const list = (await get(app, "/federation_list")).json<string[]>();
    expect(list).toEqual([ISSUER]);
    const stored = JSON.parse(await readFile(path, "utf8")) as { subordinates: unknown[] };
    expect(stored.subordinates).toEqual([
      {
        entity_id: ISSUER,
        enabled: true,
        entity_types: ["openid_credential_issuer"],
        jwks: { keys: [key.publicJwk] },
        constraints: { max_path_length: 0 },
      },
    ]);
    const dashboard = await get(app, response.headers.location ?? "", session);
    expect(dashboard.body).toContain("Added <code>");
    expect(dashboard.body).toContain("The change is live.");
  });

  it("accepts a single pasted JWK as well as a JWK Set", async () => {
    const { app } = await adminSite();
    const session = await signIn(app);
    const key = await subordinateKey();
    const response = await post(
      app,
      "/admin/new",
      entryFields(key, { jwks: JSON.stringify(key.publicJwk) }),
      session,
    );
    expect(response.statusCode).toBe(303);
    expect(await fetchStatus(app, ISSUER)).toBe(200);
  });

  it("refuses a change without the session's CSRF token", async () => {
    const { app, path } = await adminSite();
    const session = await signIn(app);
    const key = await subordinateKey();
    const response = await post(app, "/admin/new", entryFields(key), {
      cookie: session.cookie,
      csrf: "forged",
    });
    expect(response.statusCode).toBe(403);
    await expect(readFile(path)).rejects.toThrow();
  });

  it("shows validation problems on the form and saves nothing", async () => {
    const { app, path } = await adminSite();
    const session = await signIn(app);
    const key = await subordinateKey();
    const leaked: JWK = { ...key.publicJwk, d: "private-material" };

    const response = await post(
      app,
      "/admin/new",
      entryFields(key, { jwks: JSON.stringify({ keys: [leaked] }) }),
      session,
    );
    expect(response.statusCode).toBe(422);
    expect(response.body).toContain("Nothing was saved.");
    expect(response.body).toContain("contains private key material (d)");
    expect(response.body).not.toContain("subordinates[0]");
    // The operator's input is kept so it can be corrected.
    expect(response.body).toContain(ISSUER);
    await expect(readFile(path)).rejects.toThrow();

    const syntax = await post(app, "/admin/new", entryFields(key, { jwks: "{" }), session);
    expect(syntax.statusCode).toBe(422);
    expect(syntax.body).toContain("Public federation keys are not valid JSON.");
  });

  it("edits, disables and deletes a subordinate", async () => {
    const { app } = await adminSite();
    const session = await signIn(app);
    const key = await subordinateKey();
    await post(app, "/admin/new", entryFields(key), session);

    const form = await get(app, `/admin/edit?sub=${encodeURIComponent(ISSUER)}`, session);
    expect(form.statusCode).toBe(200);
    expect(form.body).toContain(key.publicJwk.kid ?? "missing kid");

    const edited = await post(
      app,
      `/admin/edit?sub=${encodeURIComponent(ISSUER)}`,
      entryFields(key, { entity_types: "openid_credential_issuer, openid_wallet_provider" }),
      session,
    );
    expect(edited.statusCode).toBe(303);
    const filtered = await get(app, "/federation_list?entity_type=openid_wallet_provider");
    expect(filtered.json()).toEqual([ISSUER]);

    const disabled = await post(app, "/admin/status", { sub: ISSUER, enabled: "false" }, session);
    expect(disabled.statusCode).toBe(303);
    expect(await fetchStatus(app, ISSUER)).toBe(404);
    expect((await get(app, "/")).body).toContain("0 enabled of 1 registered");

    const confirm = await get(app, `/admin/delete?sub=${encodeURIComponent(ISSUER)}`, session);
    expect(confirm.body).toContain("btn-destructive");
    const deleted = await post(app, `/admin/delete?sub=${encodeURIComponent(ISSUER)}`, {}, session);
    expect(deleted.statusCode).toBe(303);
    expect((await get(app, "/")).body).toContain("0 enabled of 0 registered");
  });

  it("answers 404 for a subordinate that is not registered", async () => {
    const { app } = await adminSite();
    const session = await signIn(app);
    const missing = encodeURIComponent("https://missing.test.example");
    expect((await get(app, `/admin/edit?sub=${missing}`, session)).statusCode).toBe(404);
    expect((await post(app, `/admin/delete?sub=${missing}`, {}, session)).statusCode).toBe(404);
  });
});

describe("check live keys", () => {
  async function entityConfiguration(signer: SubordinateKey, published: JWK[]): Promise<string> {
    return new SignJWT({
      jwks: { keys: published },
      authority_hints: [ENTITY_ID],
      metadata: { federation_entity: {} },
    })
      .setProtectedHeader({
        alg: "ES256",
        typ: "entity-statement+jwt",
        kid: signer.publicJwk.kid ?? "",
      })
      .setIssuer(ISSUER)
      .setSubject(ISSUER)
      .setIssuedAt(nowSeconds())
      .setExpirationTime(nowSeconds() + 3600)
      .sign(signer.privateKey);
  }

  async function check(jwt: string, pinned: SubordinateKey) {
    const requested: string[] = [];
    const fetch: Fetch = (url) => {
      requested.push(url);
      return Promise.resolve(new Response(jwt, { status: 200 }));
    };
    const { app, path } = await adminSite(fetch);
    const session = await signIn(app);
    await post(app, "/admin/new", entryFields(pinned, { enabled: "" }), session);
    const before = await readFile(path, "utf8");
    const page = await get(app, `/admin/check?sub=${encodeURIComponent(ISSUER)}`, session);
    expect(page.statusCode).toBe(200);
    expect(await readFile(path, "utf8")).toBe(before);
    expect(requested).toEqual([`${ISSUER}/.well-known/openid-federation`]);
    return page.body;
  }

  it("passes when the live Entity Configuration is signed with the pinned key", async () => {
    const key = await subordinateKey();
    const body = await check(await entityConfiguration(key, [key.publicJwk]), key);
    expect(body).toContain("All checks passed.");
    expect(body).not.toContain("status-fail");
  });

  it("flags an Entity Configuration signed with a key that was not pinned", async () => {
    const pinned = await subordinateKey();
    const rotated = await subordinateKey();
    const body = await check(await entityConfiguration(rotated, [rotated.publicJwk]), pinned);
    expect(body).toContain(`Signed with kid ${rotated.publicJwk.kid ?? ""}, which is not pinned`);
    expect(body).toContain(`published ${rotated.publicJwk.kid ?? ""} is not pinned`);
    expect(body).toContain("status-fail");
  });

  it("reports an unreachable subordinate without failing the page", async () => {
    const { app } = await adminSite();
    const session = await signIn(app);
    await post(app, "/admin/new", entryFields(await subordinateKey(), { enabled: "" }), session);
    const page = await get(app, `/admin/check?sub=${encodeURIComponent(ISSUER)}`, session);
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("The request failed: no network in tests.");
  });
});
