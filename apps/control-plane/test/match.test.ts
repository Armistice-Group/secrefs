import { describe, expect, it } from "vitest";
import { matchesPathPattern } from "../src/rbac/match.js";

describe("matchesPathPattern", () => {
  it("matches an exact path", () => {
    expect(matchesPathPattern("prod/db", "prod/db")).toBe(true);
  });

  it("does not match a different exact path", () => {
    expect(matchesPathPattern("prod/db", "prod/other")).toBe(false);
  });

  it("matches a wildcard suffix against a nested path", () => {
    expect(matchesPathPattern("prod/db/*", "prod/db/password")).toBe(true);
  });

  it("does not match the wildcard's own prefix without a trailing segment", () => {
    expect(matchesPathPattern("prod/db/*", "prod/db")).toBe(false);
  });

  it("does not let a wildcard prefix match a sibling path that merely shares characters", () => {
    // "prod/db/*" must not match "prod/db2/..." - this is the exact
    // collision the trailing-slash prefix check in match.ts exists to avoid.
    expect(matchesPathPattern("prod/db/*", "prod/db2/password")).toBe(false);
  });

  it("bare * matches anything", () => {
    expect(matchesPathPattern("*", "literally/anything")).toBe(true);
  });
});
