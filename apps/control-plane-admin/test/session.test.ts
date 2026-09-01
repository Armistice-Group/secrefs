import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearAdminToken,
  isTokenExpired,
  millisUntilExpiry,
  onSessionExpired,
  readTokenExpiry,
  setAdminToken,
} from "@/lib/auth";

/** Builds an unsigned JWT with the given payload. The signature is
 * irrelevant here by design - the client only ever parses. */
function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64({ alg: "none" })}.${b64(payload)}.signature`;
}

describe("readTokenExpiry", () => {
  it("reads exp out of a JWT", () => {
    expect(readTokenExpiry(jwt({ exp: 1_700_000_000 }))).toBe(1_700_000_000);
  });

  it("returns undefined for an opaque token", () => {
    // Self-hosters may paste a non-JWT. That must not be treated as
    // expired, or we lock them out of their own console.
    expect(readTokenExpiry("not-a-jwt")).toBeUndefined();
    expect(readTokenExpiry("")).toBeUndefined();
  });

  it("returns undefined for a JWT with no exp", () => {
    expect(readTokenExpiry(jwt({ sub: "user_1" }))).toBeUndefined();
  });

  it("returns undefined for a non-numeric exp rather than trusting it", () => {
    expect(readTokenExpiry(jwt({ exp: "soon" }))).toBeUndefined();
  });

  it("survives a payload that isn't valid base64 or JSON", () => {
    expect(readTokenExpiry("a.!!!!.c")).toBeUndefined();
  });
});

describe("isTokenExpired", () => {
  const now = 1_700_000_000_000;

  it("is true once exp has passed", () => {
    expect(isTokenExpired(jwt({ exp: 1_699_999_999 }), now)).toBe(true);
  });

  it("is false while the token is still live", () => {
    expect(isTokenExpired(jwt({ exp: 1_700_000_060 }), now)).toBe(false);
  });

  it("treats exp exactly at now as expired", () => {
    expect(isTokenExpired(jwt({ exp: 1_700_000_000 }), now)).toBe(true);
  });

  it("never reports an unreadable token as expired", () => {
    // "I cannot read this" and "this is dead" are different answers, and
    // conflating them would sign out every non-JWT session immediately.
    expect(isTokenExpired("opaque-token", now)).toBe(false);
  });
});

describe("millisUntilExpiry", () => {
  it("counts down to expiry", () => {
    expect(millisUntilExpiry(jwt({ exp: 1_700_000_060 }), 1_700_000_000_000)).toBe(60_000);
  });

  it("goes negative once past", () => {
    expect(millisUntilExpiry(jwt({ exp: 1_699_999_940 }), 1_700_000_000_000)).toBe(-60_000);
  });

  it("is undefined when the token carries no expiry", () => {
    expect(millisUntilExpiry("opaque")).toBeUndefined();
  });
});

describe("session storage", () => {
  beforeEach(() => window.localStorage.clear());

  it("round-trips a token and clears it", () => {
    setAdminToken("abc");
    expect(window.localStorage.getItem("secrefs.admin.token")).toBe("abc");
    clearAdminToken();
    expect(window.localStorage.getItem("secrefs.admin.token")).toBeNull();
  });
});

describe("onSessionExpired", () => {
  it("notifies subscribers and can be unsubscribed", async () => {
    const { notifySessionExpired } = await import("@/lib/auth");
    const listener = vi.fn();
    const off = onSessionExpired(listener);

    notifySessionExpired();
    expect(listener).toHaveBeenCalledTimes(1);

    off();
    notifySessionExpired();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
