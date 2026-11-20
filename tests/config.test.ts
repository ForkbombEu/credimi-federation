import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, parseEntityId } from "../src/config.js";

const baseEnv = {
  FEDERATION_ENTITY_ID: "https://federation.credimi.io",
  FEDERATION_SIGNING_KEY_PATH: "/data/keys/federation.jwk",
  FEDERATION_SUBORDINATES_PATH: "/data/subordinates.json",
};

describe("loadConfig", () => {
  it("reads the documented variables and applies defaults", () => {
    expect(loadConfig(baseEnv)).toEqual({
      entityId: "https://federation.credimi.io",
      port: 3000,
      signingKey: { kind: "file", path: "/data/keys/federation.jwk" },
      subordinatesPath: "/data/subordinates.json",
      federationName: "OpenID Federation Trust Anchor",
    });
  });

  it("honours PORT and FEDERATION_NAME", () => {
    const config = loadConfig({ ...baseEnv, PORT: "8080", FEDERATION_NAME: "Credimi Test" });
    expect(config.port).toBe(8080);
    expect(config.federationName).toBe("Credimi Test");
  });

  it.each(["FEDERATION_ENTITY_ID", "FEDERATION_SUBORDINATES_PATH"])(
    "fails clearly when %s is missing",
    (name) => {
      const env: Record<string, string> = { ...baseEnv };
      env[name] = " ";
      expect(() => loadConfig(env)).toThrow(new ConfigError(`${name} is required but not set.`));
    },
  );

  it("reads the signing key from FEDERATION_SIGNING_KEY instead of a file", () => {
    const config = loadConfig({
      ...baseEnv,
      FEDERATION_SIGNING_KEY_PATH: undefined,
      FEDERATION_SIGNING_KEY: ' {"kty":"EC"} ',
    });
    expect(config.signingKey).toEqual({
      kind: "env",
      variable: "FEDERATION_SIGNING_KEY",
      value: '{"kty":"EC"}',
    });
  });

  it("refuses two signing key sources rather than picking one", () => {
    expect(() => loadConfig({ ...baseEnv, FEDERATION_SIGNING_KEY: '{"kty":"EC"}' })).toThrow(
      /either FEDERATION_SIGNING_KEY_PATH or FEDERATION_SIGNING_KEY, not both/,
    );
  });

  it("names both options when no signing key source is set", () => {
    expect(() => loadConfig({ ...baseEnv, FEDERATION_SIGNING_KEY_PATH: "" })).toThrow(
      /Set FEDERATION_SIGNING_KEY_PATH .* or FEDERATION_SIGNING_KEY/,
    );
  });

  it.each(["0", "65536", "80a", "-1"])("rejects PORT=%s", (port) => {
    expect(() => loadConfig({ ...baseEnv, PORT: port })).toThrow(ConfigError);
  });

  it("enables the admin area with a password used exactly as given", () => {
    const password = " correct horse battery staple ";
    expect(loadConfig(baseEnv).adminPassword).toBeUndefined();
    expect(loadConfig({ ...baseEnv, FEDERATION_ADMIN_PASSWORD: "" }).adminPassword).toBeUndefined();
    expect(loadConfig({ ...baseEnv, FEDERATION_ADMIN_PASSWORD: password }).adminPassword).toBe(
      password,
    );
  });

  it("refuses an admin password shorter than 16 characters", () => {
    expect(() => loadConfig({ ...baseEnv, FEDERATION_ADMIN_PASSWORD: "fifteen-chars-x" })).toThrow(
      /FEDERATION_ADMIN_PASSWORD must be at least 16 characters/,
    );
  });
});

describe("parseEntityId", () => {
  it("removes a single trailing slash and keeps an explicit port", () => {
    expect(parseEntityId("https://federation.credimi.io/")).toBe("https://federation.credimi.io");
    expect(parseEntityId("https://localhost:8443")).toBe("https://localhost:8443");
  });

  it.each([
    ["http://federation.credimi.io", /https scheme/],
    ["https://user:pw@federation.credimi.io", /credentials/],
    ["https://federation.credimi.io?x=1", /query/],
    ["https://federation.credimi.io/#frag", /fragment/],
    ["https://federation.credimi.io/ta", /without a path/],
    ["federation.credimi.io", /not a valid URL/],
  ])("rejects %s", (value, message) => {
    expect(() => parseEntityId(value)).toThrow(message);
  });
});
