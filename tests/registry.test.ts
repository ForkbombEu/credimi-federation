import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Registry, RegistryWriteError, UnknownSubordinateError } from "../src/registry.js";
import {
  loadSubordinates,
  SubordinateConfigError,
  type RegistryEntry,
} from "../src/subordinates.js";
import { createFixture, ENTITY_ID, subordinateKey } from "./helpers.js";

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
    [],
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
    const reloaded = await loadSubordinates(registryPath, { entityId: ENTITY_ID, key });
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

    const ids = (await loadSubordinates(registryPath, { entityId: ENTITY_ID, key })).map(
      (subordinate) => subordinate.entityId,
    );
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
    const owner = { entityId: ENTITY_ID, key };
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
