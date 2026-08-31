import { describe, expect, it, vi } from "vitest";
import { ControlPlaneClient, ControlPlaneRequestError } from "../src/controlPlaneClient.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("ControlPlaneClient", () => {
  it("POSTs to /v1/credentials/mint with the bearer token and returns the parsed response on success", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        provider: "aws",
        credentials: { accessKeyId: "AKIA_MOCK", secretAccessKey: "s", sessionToken: "t", expiration: "2026-01-01T00:00:00Z" },
      }),
    );
    const client = new ControlPlaneClient({ baseUrl: "https://cp.example.com", token: "sfcp_test", fetchImpl });

    const result = await client.mintCredential("aws-prod", "prod/db");

    expect(result.provider).toBe("aws");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://cp.example.com/v1/credentials/mint");
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe("Bearer sfcp_test");
    expect(JSON.parse(init.body)).toEqual({ alias: "aws-prod", path: "prod/db" });
  });

  it("strips a trailing slash from baseUrl", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { provider: "bitwarden", credentials: {} }));
    const client = new ControlPlaneClient({ baseUrl: "https://cp.example.com/", token: "t", fetchImpl });

    await client.mintCredential("bw-prod", "x");

    expect(fetchImpl.mock.calls[0]![0]).toBe("https://cp.example.com/v1/credentials/mint");
  });

  it("throws ControlPlaneRequestError with the server's reason on a denial", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(403, { error: 'no grant authorizes path "prod/billing"' }));
    const client = new ControlPlaneClient({ baseUrl: "https://cp.example.com", token: "t", fetchImpl });

    await expect(client.mintCredential("aws-prod", "prod/billing")).rejects.toThrow(
      /no grant authorizes path "prod\/billing"/,
    );
    await expect(client.mintCredential("aws-prod", "prod/billing")).rejects.toBeInstanceOf(
      ControlPlaneRequestError,
    );
  });

  it("sets .status on ControlPlaneRequestError", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(401, { error: "missing or unrecognized bootstrap token" }));
    const client = new ControlPlaneClient({ baseUrl: "https://cp.example.com", token: "bad", fetchImpl });

    try {
      await client.mintCredential("aws-prod", "prod/db");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ControlPlaneRequestError);
      expect((err as ControlPlaneRequestError).status).toBe(401);
    }
  });

  it("falls back to a generic message if the error response has no JSON body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("not json", { status: 502 }));
    const client = new ControlPlaneClient({ baseUrl: "https://cp.example.com", token: "t", fetchImpl });

    await expect(client.mintCredential("aws-prod", "prod/db")).rejects.toThrow(/502/);
  });

  it("wraps a network failure in a clear error naming the control plane's URL", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const client = new ControlPlaneClient({ baseUrl: "https://cp.example.com", token: "t", fetchImpl });

    await expect(client.mintCredential("aws-prod", "prod/db")).rejects.toThrow(
      /could not reach control plane at https:\/\/cp\.example\.com/,
    );
  });
});
