import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeJwt } from "jose";
import { describe, expect, it } from "vitest";
import {
  GitHubManagedError,
  Registry,
  RegistryWriteError,
  UnknownSubordinateError,
} from "../src/registry.js";
import {
  loadRegistryDirectory,
  loadSubordinates,
  parseSubordinates,
  registryFileName,
  SubordinateConfigError,
  type RegistryEntry,
  type RegistryOwner,
} from "../src/subordinates.js";
import { createFixture, ENTITY_ID, subordinateKey, tempDir } from "./helpers.js";

const ISSUER = "https://issuer.test.example";
const VERIFIER = "https://verifier.test.example";

async function entry(entityId: string, enabled = true): Promise<RegistryEntry> {
  return {
    entity_id: entityId,
    enabled,
    entity_types: ["openid_credential_issuer"],
    jwks: { keys: [(await subordinateKey()).publicJwk] },
  };
}

async function emptyRegistry(path?: string) {
  const fixture = await createFixture();
  const registryPath = path ?? fixture.config.subordinatesPath;
  const registry = await Registry.create(
    { entityId: ENTITY_ID, key: fixture.key, path: registryPath },
    { local: [], github: [] },
  );
  return { ...fixture, registry, registryPath };
}

async function fetchStatus(registry: Registry, sub: string): Promise<number> {
  const url = new URL(`/federation_fetch?sub=${encodeURIComponent(sub)}`, ENTITY_ID);
  return (await registry.trustAnchor.handleRequest(new Request(url))).status;
}

describe("Registry.update", () => {
  it("persists the change and serves it without a restart", async () => {
    const { registry, registryPath, key } = await emptyRegistry();
    expect(await fetchStatus(registry, ISSUER)).toBe(404);

    const added = await entry(ISSUER);
    await registry.update((entries) => [...entries, added]);

    expect(await fetchStatus(registry, ISSUER)).toBe(200);
    const reloaded = await loadSubordinates(registryPath, {
      entityId: ENTITY_ID,
      publicKeys: [key.publicJwk],
    });
    expect(reloaded).toEqual(registry.subordinates);
    expect(reloaded[0]?.entityId).toBe(ISSUER);
  });

  it("stops serving a subordinate once it is disabled", async () => {
    const { registry } = await emptyRegistry();
    const added = await entry(ISSUER);
    await registry.update((entries) => [...entries, added]);
    expect(await fetchStatus(registry, ISSUER)).toBe(200);

    await registry.update((entries) =>
      entries.map((value) => (value.entity_id === ISSUER ? { ...value, enabled: false } : value)),
    );
    expect(await fetchStatus(registry, ISSUER)).toBe(404);
    expect(registry.subordinates[0]?.enabled).toBe(false);
  });

  it("rejects an invalid registry and leaves file and statements untouched", async () => {
    const { registry, registryPath } = await emptyRegistry();
    await registry.update((entries) => [...entries]); // creates the file
    const before = await readFile(registryPath, "utf8");
    const bad = { ...(await entry(ISSUER)), jwks: { keys: [{ kty: "EC", kid: "x" }] } };

    await expect(registry.update((entries) => [...entries, bad])).rejects.toBeInstanceOf(
      SubordinateConfigError,
    );
    expect(await readFile(registryPath, "utf8")).toBe(before);
    expect(registry.subordinates).toEqual([]);
    expect(await fetchStatus(registry, ISSUER)).toBe(404);
  });

  it("reports an unwritable path without changing the served registry", async () => {
    const { dir } = await createFixture();
    const occupied = join(dir, "registry-dir");
    await mkdir(occupied);
    const { registry } = await emptyRegistry(occupied);
    const added = await entry(ISSUER);

    const failure = registry.update((entries) => [...entries, added]);
    await expect(failure).rejects.toBeInstanceOf(RegistryWriteError);
    await expect(failure).rejects.toThrow(/writable volume directory/);
    expect(registry.subordinates).toEqual([]);
    expect(await fetchStatus(registry, ISSUER)).toBe(404);
    expect((await readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("applies concurrent changes one after the other without losing either", async () => {
    const { registry, registryPath, key } = await emptyRegistry();
    const [issuer, verifier] = await Promise.all([entry(ISSUER), entry(VERIFIER)]);

    await Promise.all([
      registry.update((entries) => [...entries, issuer]),
      registry.update((entries) => [...entries, verifier]),
    ]);

    const ids = (
      await loadSubordinates(registryPath, { entityId: ENTITY_ID, publicKeys: [key.publicJwk] })
    ).map((subordinate) => subordinate.entityId);
    expect(ids).toEqual([ISSUER, VERIFIER]);
  });

  it("keeps working after a failed change", async () => {
    const { registry } = await emptyRegistry();
    await expect(
      registry.update(() => {
        throw new UnknownSubordinateError(ISSUER);
      }),
    ).rejects.toBeInstanceOf(UnknownSubordinateError);

    const added = await entry(ISSUER);
    await registry.update((entries) => [...entries, added]);
    expect(await fetchStatus(registry, ISSUER)).toBe(200);
  });
});

describe("loadSubordinates with missingIsEmpty", () => {
  it("treats a missing file as an empty registry only when asked", async () => {
    const { config, key } = await createFixture();
    const owner = { entityId: ENTITY_ID, publicKeys: [key.publicJwk] };
    await expect(loadSubordinates(config.subordinatesPath, owner)).rejects.toThrow(
      /file not found/,
    );
    expect(
      await loadSubordinates(config.subordinatesPath, owner, { missingIsEmpty: true }),
    ).toEqual([]);

    await writeFile(config.subordinatesPath, "not json");
    await expect(
      loadSubordinates(config.subordinatesPath, owner, { missingIsEmpty: true }),
    ).rejects.toThrow(/not valid JSON/);
  });
});

describe("GitHub and local registries together", () => {
  async function registries(github: RegistryEntry[], local: RegistryEntry[]) {
    const fixture = await createFixture();
    const owner: RegistryOwner = { entityId: ENTITY_ID, publicKeys: [fixture.key.publicJwk] };
    const registry = await Registry.create(
      { entityId: ENTITY_ID, key: fixture.key, path: fixture.config.subordinatesPath },
      {
        github: await parseSubordinates({ subordinates: github }, owner),
        local: await parseSubordinates({ subordinates: local }, owner),
      },
    );
    return { registry, path: fixture.config.subordinatesPath };
  }

  async function statementJwks(registry: Registry, sub: string): Promise<string> {
    const url = new URL(`/federation_fetch?sub=${encodeURIComponent(sub)}`, ENTITY_ID);
    const jwt = await (await registry.trustAnchor.handleRequest(new Request(url))).text();
    return JSON.stringify(decodeJwt(jwt)["jwks"]);
  }

  it("serves the GitHub entry when both registries hold the same Entity Identifier", async () => {
    const githubKey = await subordinateKey();
    const localKey = await subordinateKey();
    const fromGitHub = { ...(await entry(ISSUER)), jwks: { keys: [githubKey.publicJwk] } };
    const fromLocal = { ...(await entry(`${ISSUER}/`)), jwks: { keys: [localKey.publicJwk] } };
    const { registry } = await registries([fromGitHub], [fromLocal, await entry(VERIFIER)]);

    expect(registry.subordinates.map((subordinate) => subordinate.entityId)).toEqual([
      ISSUER,
      VERIFIER,
    ]);
    const pinned = await statementJwks(registry, ISSUER);
    expect(pinned).toContain(githubKey.publicJwk.kid ?? "missing");
    expect(pinned).not.toContain(localKey.publicJwk.kid ?? "missing");
    expect(
      registry.members.map((member) => [
        member.subordinate.entityId,
        member.source,
        member.overridden,
      ]),
    ).toEqual([
      [ISSUER, "github", false],
      [`${ISSUER}/`, "local", true],
      [VERIFIER, "local", false],
    ]);
  });

  it("never lets a change create a new override, but allows changing an existing one", async () => {
    const { registry, path } = await registries(
      [await entry(ISSUER), await entry(VERIFIER)],
      [await entry(ISSUER)],
    );
    const shadowing = await entry(VERIFIER);
    await expect(registry.update((entries) => [...entries, shadowing])).rejects.toBeInstanceOf(
      GitHubManagedError,
    );
    await expect(readFile(path)).rejects.toThrow();

    await registry.update((entries) => entries.map((value) => ({ ...value, enabled: false })));
    expect(registry.members.find((member) => member.source === "local")).toMatchObject({
      overridden: true,
      subordinate: { enabled: false },
    });
    expect(await fetchStatus(registry, ISSUER)).toBe(200);
  });
});

describe("loadRegistryDirectory", () => {
  const owner = async (): Promise<RegistryOwner> => {
    const { key } = await createFixture();
    return { entityId: ENTITY_ID, publicKeys: [key.publicJwk] };
  };

  async function directory(files: Record<string, unknown>): Promise<string> {
    const dir = await tempDir();
    for (const [name, content] of Object.entries(files)) {
      await writeFile(
        join(dir, name),
        typeof content === "string" ? content : JSON.stringify(content),
      );
    }
    return dir;
  }

  async function issuesOf(dir: string): Promise<string> {
    try {
      await loadRegistryDirectory(dir, await owner());
    } catch (error) {
      expect(error).toBeInstanceOf(SubordinateConfigError);
      return (error as SubordinateConfigError).issues.join("\n");
    }
    throw new Error("expected the registry to be rejected");
  }

  it("names each file after its Entity Identifier", () => {
    expect(registryFileName("https://issuer.example.org")).toBe("issuer.example.org.json");
    expect(registryFileName("https://issuer.example.org/issuers/pid/")).toBe(
      "issuer.example.org_issuers_pid.json",
    );
    expect(registryFileName("https://host.example:8443/a~b")).toBe("host.example_8443_a_b.json");
  });

  it("loads one entry per JSON file, in file-name order, ignoring other files", async () => {
    const dir = await directory({
      [registryFileName(VERIFIER)]: await entry(VERIFIER),
      [registryFileName(ISSUER)]: await entry(ISSUER),
      "README.md": "# not an entry",
    });
    const loaded = await loadRegistryDirectory(dir, await owner());
    expect(loaded.map((subordinate) => subordinate.entityId)).toEqual([ISSUER, VERIFIER]);
  });

  it("reports problems by file name", async () => {
    const dir = await directory({
      "wrong-name.json": await entry(ISSUER),
      "broken.json": "{",
      [registryFileName(VERIFIER)]: { ...(await entry(VERIFIER)), jwks: { keys: [] } },
    });
    const issues = await issuesOf(dir);
    expect(issues).toContain("wrong-name.json: must be named issuer.test.example.json");
    expect(issues).toContain("broken.json: not valid JSON.");
    expect(issues).toMatch(/verifier\.test\.example\.json: .*at least one key/s);
    expect(issues).not.toContain("subordinates[");
  });

  it("fails clearly when the directory is missing", async () => {
    expect(await issuesOf(join(await tempDir(), "missing"))).toBe("directory not found.");
  });
});
