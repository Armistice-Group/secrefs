import { describe, expect, it } from "vitest";
import { parseEnvFileText, recoverTruncatedSecRefs } from "../src/envFile.js";

describe("parseEnvFileText", () => {
  it("preserves the #field fragment on an unquoted sec:// value", () => {
    const parsed = parseEnvFileText("DB_PASSWORD=sec://aws/prod/db#password\n");
    expect(parsed.DB_PASSWORD).toBe("sec://aws/prod/db#password");
  });

  it("preserves the #field fragment on a quoted sec:// value (already correct via dotenv)", () => {
    const parsed = parseEnvFileText('DB_PASSWORD="sec://aws/prod/db#password"\n');
    expect(parsed.DB_PASSWORD).toBe("sec://aws/prod/db#password");
  });

  it("still treats a genuine standalone comment line as a comment", () => {
    const parsed = parseEnvFileText("# this is a real comment\nPORT=3000\n");
    expect(parsed).toEqual({ PORT: "3000" });
  });

  it("still strips inline comments on ordinary (non sec://) values", () => {
    const parsed = parseEnvFileText("GREETING=hello # trailing comment\n");
    expect(parsed.GREETING).toBe("hello");
  });

  it("handles multiple sec:// references and plain values in the same file", () => {
    const parsed = parseEnvFileText(
      [
        "PORT=3000",
        "DB_PASSWORD=sec://aws/prod/db#password",
        "STRIPE_KEY=sec://vault/secret/data/stripe#key",
        "PLAIN=just-a-value",
      ].join("\n"),
    );
    expect(parsed).toEqual({
      PORT: "3000",
      DB_PASSWORD: "sec://aws/prod/db#password",
      STRIPE_KEY: "sec://vault/secret/data/stripe#key",
      PLAIN: "just-a-value",
    });
  });

  it("supports a leading `export` keyword before a sec:// assignment", () => {
    const parsed = parseEnvFileText("export DB_PASSWORD=sec://aws/prod/db#password\n");
    expect(parsed.DB_PASSWORD).toBe("sec://aws/prod/db#password");
  });

  it("supports dotted nested field fragments", () => {
    const parsed = parseEnvFileText("X=sec://vault/secret/data/stripe#nested.value\n");
    expect(parsed.X).toBe("sec://vault/secret/data/stripe#nested.value");
  });
});

describe("recoverTruncatedSecRefs", () => {
  it("only overrides keys whose raw line is an unquoted sec:// assignment", () => {
    const parsed = { A: "sec://aws/x", B: "unrelated" };
    const result = recoverTruncatedSecRefs("A=sec://aws/x#field\nB=unrelated\n", parsed);
    expect(result).toEqual({ A: "sec://aws/x#field", B: "unrelated" });
  });
});
