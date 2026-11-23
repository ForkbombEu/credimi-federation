import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JWK } from "jose";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/commands.js";
import type { Fetch } from "../src/keycheck.js";
import { registryFileName } from "../src/subordinates.js";
import {
  createFixture,
  ENTITY_ID,
  signEntityConfiguration,
  subordinateKey,
  tempDir,
  type SubordinateKey,
} from "./helpers.js";

const ISSUER = "https://issuer.test.example/issuers/pid";

interface Setup {
  readonly registryDir: string;
  readonly descriptor: string;
  /** The Trust Anchor's public key, as published in the descriptor. */
  readonly trustAnchorJwk: JWK;
}

/** A GitHub registry with the given member files and a Trust Anchor descriptor. */
async function setup(members: Record<string, unknown>): Promise<Setup> {
  const { key } = await createFixture();
  const dir = await tempDir();
  const registryDir = join(dir, "registry");
  await mkdir(registryDir);
  for (const [name, content] of Object.entries(members)) {
    await writeFile(join(registryDir, name), JSON.stringify(content));
  }
  const descriptor = join(dir, "trust-anchor.json");
  await writeFile(
    descriptor,
    JSON.stringify({ entity_id: ENTITY_ID, jwks: { keys: [key.publicJwk] } }),
  );
  return { registryDir, descriptor, trustAnchorJwk: key.publicJwk };
}

function member(key: SubordinateKey, enabled = true) {
  return {
    entity_id: ISSUER,
    enabled,
    entity_types: ["openid_credential_issuer"],
    jwks: { keys: [key.publicJwk] },
  };
}

async function validate(args: string[], fetch?: Fetch) {
  let stdout = "";
  let stderr = "";
  const code = await runCli(
    ["validate", ...args],
    {},
    { stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) },
    fetch === undefined ? {} : { fetch },
  );
  return { code, stdout, stderr };
}

const serving =
  (jwt: string): Fetch =>
  () =>
    Promise.resolve(new Response(jwt, { status: 200 }));

describe("credimi-federation validate", () => {
  it("accepts a valid registry without any private key or environment", async () => {
    const key = await subordinateKey();
    const { registryDir, descriptor } = await setup({ [registryFileName(ISSUER)]: member(key) });
    const { code, stdout } = await validate([registryDir, descriptor]);
    expect(code).toBe(0);
    expect(stdout).toContain(`Valid: 1 subordinate(s), 1 enabled, checked against ${ENTITY_ID}.`);
    expect(stdout).not.toContain("Live key checks");
  });

  it("rejects a misnamed member file and reports it as Markdown", async () => {
    const { registryDir, descriptor } = await setup({
      "issuer.json": member(await subordinateKey()),
    });
    const { code, stdout } = await validate([registryDir, descriptor]);
    expect(code).toBe(1);
    expect(stdout).toContain("**Invalid.**");
    expect(stdout).toContain(`- issuer.json: must be named ${registryFileName(ISSUER)}`);
  });

  it("rejects a member that reuses the Trust Anchor's key from the descriptor", async () => {
    const { registryDir, descriptor, trustAnchorJwk } = await setup({});
    await writeFile(
      join(registryDir, registryFileName(ISSUER)),
      JSON.stringify({ ...member(await subordinateKey()), jwks: { keys: [trustAnchorJwk] } }),
    );
    const { code, stdout } = await validate([registryDir, descriptor]);
    expect(code).toBe(1);
    expect(stdout).toContain("Trust Anchor's own federation key");
  });

  it("passes the live check when the member's Entity Configuration matches its file", async () => {
    const key = await subordinateKey();
    const { registryDir, descriptor } = await setup({ [registryFileName(ISSUER)]: member(key) });
    const jwt = await signEntityConfiguration(key, ISSUER, [key.publicJwk]);
    const file = join(registryDir, registryFileName(ISSUER));
    const { code, stdout } = await validate(
      [registryDir, descriptor, "--live", file],
      serving(jwt),
    );
    expect(stdout).not.toContain("FAIL");
    expect(stdout).toContain("- PASS Signed with a pinned key");
    expect(stdout).toContain("All live checks passed.");
    expect(code).toBe(0);
  });

  it("fails the live check when the Entity Configuration is signed with another key", async () => {
    const pinned = await subordinateKey();
    const other = await subordinateKey();
    const { registryDir, descriptor } = await setup({
      [registryFileName(ISSUER)]: member(pinned),
    });
    const jwt = await signEntityConfiguration(other, ISSUER, [other.publicJwk]);
    const file = join(registryDir, registryFileName(ISSUER));
    const { code, stdout } = await validate(
      [registryDir, descriptor, "--live", file],
      serving(jwt),
    );
    expect(code).toBe(1);
    expect(stdout).toContain("- FAIL Signed with a pinned key");
    expect(stdout).toContain("**Some live checks failed.**");
  });

  it("fails the live check when the member is unreachable", async () => {
    const { registryDir, descriptor } = await setup({
      [registryFileName(ISSUER)]: member(await subordinateKey()),
    });
    const offline: Fetch = () => Promise.reject(new Error("getaddrinfo ENOTFOUND"));
    const file = join(registryDir, registryFileName(ISSUER));
    const { code, stdout } = await validate([registryDir, descriptor, "--live", file], offline);
    expect(code).toBe(1);
    expect(stdout).toContain("- FAIL Entity Configuration is reachable");
  });

  it("retries a transient failure once before reporting the member", async () => {
    const key = await subordinateKey();
    const { registryDir, descriptor } = await setup({ [registryFileName(ISSUER)]: member(key) });
    const jwt = await signEntityConfiguration(key, ISSUER, [key.publicJwk]);
    let calls = 0;
    const flaky: Fetch = () => {
      calls += 1;
      return calls === 1
        ? Promise.resolve(new Response("busy", { status: 503 }))
        : Promise.resolve(new Response(jwt, { status: 200 }));
    };
    const file = join(registryDir, registryFileName(ISSUER));
    const { code, stdout } = await validate([registryDir, descriptor, "--live", file], flaky);
    expect(calls).toBe(2);
    expect(stdout).toContain("All live checks passed.");
    expect(code).toBe(0);
  });

  it("does not retry a definitive answer such as 404", async () => {
    const { registryDir, descriptor } = await setup({
      [registryFileName(ISSUER)]: member(await subordinateKey()),
    });
    let calls = 0;
    const missing: Fetch = () => {
      calls += 1;
      return Promise.resolve(new Response("not found", { status: 404 }));
    };
    const file = join(registryDir, registryFileName(ISSUER));
    const { code, stdout } = await validate([registryDir, descriptor, "--live", file], missing);
    expect(calls).toBe(1);
    expect(stdout).toContain("The server answered HTTP 404.");
    expect(code).toBe(1);
  });

  it("skips disabled members, which are not served", async () => {
    const { registryDir, descriptor } = await setup({
      [registryFileName(ISSUER)]: member(await subordinateKey(), false),
    });
    const neverCalled: Fetch = () => Promise.reject(new Error("must not fetch"));
    const file = join(registryDir, registryFileName(ISSUER));
    const { code, stdout } = await validate([registryDir, descriptor, "--live", file], neverCalled);
    expect(code).toBe(0);
    expect(stdout).toContain("Skipped: the entry is disabled");
  });

  it("fails for a live-check file that is not a member file of the registry", async () => {
    const { registryDir, descriptor } = await setup({});
    const { code, stdout } = await validate([
      registryDir,
      descriptor,
      "--live",
      join(registryDir, "..", "elsewhere.json"),
    ]);
    expect(code).toBe(1);
    expect(stdout).toContain("FAIL: not a member file");
  });

  it("refuses a descriptor that contains private key material", async () => {
    const { key } = await createFixture();
    const { registryDir, descriptor } = await setup({});
    await writeFile(
      descriptor,
      JSON.stringify({ entity_id: ENTITY_ID, jwks: { keys: [key.privateJwk] } }),
    );
    const { code, stderr } = await validate([registryDir, descriptor]);
    expect(code).toBe(1);
    expect(stderr).toContain("contains private key material");
  });

  it("prints usage for missing arguments", async () => {
    expect((await validate([])).code).toBe(2);
    expect((await validate(["registry", "ta.json", "--offline"])).code).toBe(2);
  });
});
