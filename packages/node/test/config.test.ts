import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, buildProviders, loadConfigFrom, parseConfig } from "../src/config.js";

function tempProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "secrefs-config-"));
  for (const [relative, contents] of Object.entries(files)) {
    const full = join(root, relative);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, contents);
  }
  return root;
}

const VALID = JSON.stringify({
  providers: {
    "aws-prod": { type: "aws", profile: "acme-prod", region: "us-east-1" },
    "aws-staging": { type: "aws", profile: "acme-stg" },
  },
});

describe("parseConfig", () => {
  it("accepts a config declaring several aliases of the same provider type", () => {
    const config = parseConfig(VALID);
    expect(Object.keys(config.providers)).toEqual(["aws-prod", "aws-staging"]);
  });

  it("rejects a literal credential rather than ignoring it", () => {
    // Someone who writes "token" believes it is being used. Quietly not
    // using it is worse than refusing - and this file is meant to be
    // committed, so a credential here is the exact failure SecRefs exists
    // to prevent, one level up.
    const raw = JSON.stringify({
      providers: { bw: { type: "bitwarden", token: "0.real-token-value" } },
    });
    expect(() => parseConfig(raw)).toThrow(/must never contain a credential/);
  });

  it("rejects every credential-shaped key, not just the obvious one", () => {
    for (const key of ["accessToken", "secretAccessKey", "password", "apiKey", "credentials"]) {
      const raw = JSON.stringify({ providers: { p: { type: "aws", [key]: "x" } } });
      expect(() => parseConfig(raw), key).toThrow(ConfigError);
    }
  });

  it("names the file and the alias when the type is unknown", () => {
    const raw = JSON.stringify({ providers: { p: { type: "hashicorp" } } });
    expect(() => parseConfig(raw)).toThrow(/"p" has type "hashicorp"/);
  });

  it("rejects malformed JSON with the parser's own message", () => {
    expect(() => parseConfig("{ not json")).toThrow(/is not valid JSON/);
  });

  it("requires a providers object", () => {
    expect(() => parseConfig("{}")).toThrow(/must have a "providers" object/);
    expect(() => parseConfig("[]")).toThrow(/must contain a JSON object/);
  });
});

describe("buildProviders", () => {
  it("registers each alias under its own name", () => {
    const registry = buildProviders(parseConfig(VALID));
    expect(Object.keys(registry).sort()).toEqual(["aws-prod", "aws-staging"]);
    expect(registry["aws-prod"]!.name).toBe("aws");
  });

  it("reads a credential from the named environment variable", () => {
    const raw = JSON.stringify({
      providers: { "bw-eng": { type: "bitwarden", tokenEnv: "BWS_TOKEN_ENG" } },
    });
    const registry = buildProviders(parseConfig(raw), {
      env: { BWS_TOKEN_ENG: "0.token" } as NodeJS.ProcessEnv,
    });
    expect(registry["bw-eng"]!.name).toBe("bitwarden");
  });

  it("names both the alias and the missing variable when it isn't set", () => {
    // "missing credentials" sends someone hunting; naming the variable
    // tells them exactly what to export.
    const raw = JSON.stringify({
      providers: { "bw-eng": { type: "bitwarden", tokenEnv: "BWS_TOKEN_ENG" } },
    });
    expect(() => buildProviders(parseConfig(raw), { env: {} as NodeJS.ProcessEnv })).toThrow(
      /"bw-eng" expects the credential in BWS_TOKEN_ENG/,
    );
  });

  it("replaces the built-in aliases rather than merging with them", () => {
    // A project declaring aws-prod and aws-staging must not also get a
    // third, differently-configured `aws` still resolving - that is how a
    // reference silently reaches the wrong account.
    const registry = buildProviders(parseConfig(VALID));
    expect(registry["aws"]).toBeUndefined();
    expect(registry["local"]).toBeUndefined();
  });

  it("resolves a local provider's file relative to the config, not the cwd", () => {
    const raw = JSON.stringify({ providers: { dev: { type: "local", file: "secrets/dev.json" } } });
    const registry = buildProviders(parseConfig(raw), { configDir: "/srv/app" });
    expect(registry["dev"]!.name).toBe("local");
  });
});

describe("loadConfigFrom", () => {
  it("finds the config in the starting directory", () => {
    const root = tempProject({ "secrefs.config.json": VALID });
    expect(loadConfigFrom(root)?.config.providers["aws-prod"]).toBeTruthy();
  });

  it("walks up to an ancestor, so it works from a subdirectory", () => {
    const root = tempProject({
      "secrefs.config.json": VALID,
      "packages/api/.keep": "",
    });
    const found = loadConfigFrom(join(root, "packages", "api"));
    expect(found?.path).toBe(join(root, "secrefs.config.json"));
  });

  it("returns undefined when there is no config anywhere up the tree", () => {
    // Not an error: no config is the common case, and the built-in
    // aliases are used instead.
    expect(loadConfigFrom(tempProject({ "some.txt": "x" }))).toBeUndefined();
  });

  it("throws rather than falling back when the config it finds is broken", () => {
    const root = tempProject({ "secrefs.config.json": "{ broken" });
    expect(() => loadConfigFrom(root)).toThrow(ConfigError);
  });
});
