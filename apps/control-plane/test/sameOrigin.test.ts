import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { openDatabase } from "../src/db/client.js";
import { ControlPlaneRepo } from "../src/db/repo.js";
import { SESSION_COOKIE, sessionTokenFrom } from "../src/auth/requireOrgAdmin.js";
import type { AppContext } from "../src/context.js";

async function context(): Promise<AppContext> {
  const db = await openDatabase();
  return { repo: new ControlPlaneRepo(db) } as AppContext;
}

function consoleBuild(): string {
  const dir = mkdtempSync(join(tmpdir(), "secrefs-console-"));
  writeFileSync(join(dir, "index.html"), "<html>console home</html>");
  writeFileSync(join(dir, "roles.html"), "<html>roles</html>");
  writeFileSync(join(dir, "404.html"), "<html>not found</html>");
  return dir;
}

describe("sessionTokenFrom", () => {
  it("reads a bearer header", () => {
    expect(sessionTokenFrom("Bearer abc", undefined)).toBe("abc");
  });

  it("reads the session cookie when there is no header", () => {
    expect(sessionTokenFrom(undefined, { [SESSION_COOKIE]: "abc" })).toBe("abc");
  });

  it("prefers the header when both are present", () => {
    // An explicit credential is a deliberate act; an ambient cookie rides
    // along on its own. When they disagree, the explicit one is the one
    // the caller meant.
    expect(sessionTokenFrom("Bearer explicit", { [SESSION_COOKIE]: "ambient" })).toBe("explicit");
  });

  it("ignores an empty bearer and falls through to the cookie", () => {
    expect(sessionTokenFrom("Bearer   ", { [SESSION_COOKIE]: "abc" })).toBe("abc");
  });

  it("returns undefined when neither is present", () => {
    expect(sessionTokenFrom(undefined, {})).toBeUndefined();
    expect(sessionTokenFrom("Basic abc", undefined)).toBeUndefined();
  });
});

describe("security headers", () => {
  it("forbids framing, so the admin UI cannot be clickjacked", async () => {
    const app = buildApp(await context());
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  });

  it("blocks inline event handlers even though inline scripts are allowed", async () => {
    // Next's static export inlines its bootstrap, so script-src needs
    // 'unsafe-inline' - but script-src-attr does not, and leaving it open
    // would be a free XSS primitive.
    const app = buildApp(await context());
    const csp = (await app.inject({ method: "GET", url: "/healthz" })).headers[
      "content-security-policy"
    ] as string;
    expect(csp).toContain("script-src-attr 'none'");
  });

  it("restricts the referrer, because org ids ride in query params", async () => {
    const app = buildApp(await context());
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  });

  it("sets HSTS", async () => {
    const app = buildApp(await context());
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.headers["strict-transport-security"]).toContain("max-age=31536000");
  });
});

describe("serving the console same-origin", () => {
  it("serves index.html at the root", async () => {
    const app = buildApp(await context(), { consoleDir: consoleBuild() });
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("console home");
  });

  it("maps an extension-less path onto the flat file next export writes", async () => {
    const app = buildApp(await context(), { consoleDir: consoleBuild() });
    const res = await app.inject({ method: "GET", url: "/roles" });
    expect(res.body).toContain("roles");
  });

  it("keeps API 404s as JSON", async () => {
    // Handing a programmatic caller the console's HTML turns a clear
    // error into a parse failure three layers away.
    const app = buildApp(await context(), { consoleDir: consoleBuild() });
    const res = await app.inject({ method: "GET", url: "/v1/nope" });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: "not found" });
  });

  it("falls back to the console 404 for an unknown page", async () => {
    const app = buildApp(await context(), { consoleDir: consoleBuild() });
    const res = await app.inject({ method: "GET", url: "/nonexistent" });
    expect(res.body).toContain("not found");
  });

  it("still answers /healthz rather than serving it from disk", async () => {
    const app = buildApp(await context(), { consoleDir: consoleBuild() });
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  it("stays API-only when no console directory is configured", async () => {
    const app = buildApp(await context());
    expect((await app.inject({ method: "GET", url: "/" })).statusCode).toBe(404);
  });
});
