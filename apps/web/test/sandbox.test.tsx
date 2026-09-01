import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Sandbox, { MOCK_VAULT, mockFetch, parseEnvText } from "@/components/Sandbox";
import { parseSecretRef } from "@secrefs/node/parser";

describe("parseEnvText", () => {
  it("skips comments, blank lines, and lines with no '='", () => {
    const lines = parseEnvText("# a comment\n\nNOT_AN_ASSIGNMENT\nA=1\n");
    expect(lines.map((l) => l.key)).toEqual(["A"]);
  });

  it("marks a plain value as having no reference", () => {
    const [line] = parseEnvText("PORT=3000");
    expect(line).toMatchObject({ key: "PORT", rawValue: "3000", ref: null, parseError: null });
  });

  it("parses a sec:// value into provider, path and field", () => {
    const [line] = parseEnvText("DB=sec://aws/prod/db#password");
    expect(line!.ref).toMatchObject({ provider: "aws", path: "prod/db", field: "password" });
  });

  it("reports a parse error instead of throwing on a malformed reference", () => {
    const [line] = parseEnvText("BAD=sec://");
    expect(line!.ref).toBeNull();
    expect(line!.parseError).toBeTruthy();
  });

  it("ignores an empty key", () => {
    expect(parseEnvText("=novalue")).toEqual([]);
  });
});

describe("mockFetch", () => {
  it("extracts the requested field and nothing else", async () => {
    const value = await mockFetch(parseSecretRef("sec://aws/prod/db#password"));
    expect(value).toBe(MOCK_VAULT.aws!["prod/db"]!["password" as never]);
    expect(value).not.toContain("app_prod"); // the sibling field must not leak
  });

  it("returns a whole string entry when no field is requested", async () => {
    await expect(mockFetch(parseSecretRef("sec://aws/prod/api-key"))).resolves.toBe(
      "ak_live_mock_9f8e7d6c5b4a",
    );
  });

  it("rejects an unknown provider", async () => {
    await expect(mockFetch(parseSecretRef("sec://nope/a#b"))).rejects.toThrow(/unknown provider/);
  });

  it("rejects an unknown path", async () => {
    await expect(mockFetch(parseSecretRef("sec://aws/missing#b"))).rejects.toThrow(/no mock entry/);
  });

  it("rejects a field that is not present in the entry", async () => {
    await expect(mockFetch(parseSecretRef("sec://aws/prod/db#nope"))).rejects.toThrow(
      /field "nope" not found/,
    );
  });
});

describe("<Sandbox /> - the interaction actually shipped on secrefs.com", () => {
  it("counts the sec:// references in the default .env", () => {
    render(<Sandbox />);
    expect(screen.getByText("4 sec:// references detected")).toBeInTheDocument();
  });

  it("prompts before anything has been run", () => {
    render(<Sandbox />);
    expect(screen.getByText(/to simulate resolving every/i)).toBeInTheDocument();
  });

  it("expands the sample .env: real values in, failures isolated, plain lines untouched", async () => {
    const user = userEvent.setup();
    render(<Sandbox />);
    await user.click(screen.getByRole("button", { name: /expand/i }));

    await waitFor(
      () => {
        // Resolved from the mock vault.
        expect(screen.getByText("S3cur3-P@ss-mock-2024")).toBeInTheDocument();
      },
      { timeout: 5000 },
    );

    expect(screen.getByText("sk_test_mock_51AbCdEf")).toBeInTheDocument();
    expect(screen.getByText("hunter2")).toBeInTheDocument();

    // The deliberately-broken line fails on its own without taking the
    // others down with it - this is the Promise.allSettled contract.
    expect(screen.getByText(/no mock entry for path "does-not-exist"/)).toBeInTheDocument();

    // A non-reference line passes through verbatim.
    expect(screen.getByText("3000")).toBeInTheDocument();
  });

  it("clears stale results when the .env is edited", async () => {
    const user = userEvent.setup();
    render(<Sandbox />);
    await user.click(screen.getByRole("button", { name: /expand/i }));
    await waitFor(() => expect(screen.getByText("hunter2")).toBeInTheDocument(), { timeout: 5000 });

    await user.type(screen.getByRole("textbox"), "\nEXTRA=1");

    // Showing values resolved from an older .env next to newer text would be
    // actively misleading about what expanded.
    expect(screen.queryByText("hunter2")).not.toBeInTheDocument();
    expect(screen.getByText(/to simulate resolving every/i)).toBeInTheDocument();
  });

  it("never renders a resolved value before Expand is pressed", () => {
    render(<Sandbox />);
    expect(screen.queryByText("S3cur3-P@ss-mock-2024")).not.toBeInTheDocument();
  });
});
