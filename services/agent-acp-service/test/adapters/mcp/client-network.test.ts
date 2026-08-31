import type { LookupAddress } from "node:dns";

import { describe, expect, it, vi } from "vitest";

import {
  ClientMcpNetworkError,
  ClientMcpNetworkPolicy,
  createClientMcpFetch,
} from "../../../src/adapters/mcp/client-network.js";

describe("ClientMcpNetworkPolicy", () => {
  it("accepts HTTPS only and rejects any private DNS answer", async () => {
    const publicPolicy = policy([{ address: "93.184.216.34", family: 4 }]);
    await expect(publicPolicy.assertUrl(new URL("https://mcp.example.test/mcp"))).resolves.toBe(
      undefined,
    );
    await expect(
      publicPolicy.assertUrl(new URL("http://mcp.example.test/mcp")),
    ).rejects.toMatchObject({ code: "client_mcp_insecure_url" });

    const mixedPolicy = policy([
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.8", family: 4 },
    ]);
    await expect(
      mixedPolicy.assertUrl(new URL("https://mcp.example.test/mcp")),
    ).rejects.toMatchObject({ code: "client_mcp_blocked_address" });
  });

  it("rejects literal loopback and operator-defined blocked CIDRs", async () => {
    await expect(policy([]).assertUrl(new URL("https://127.0.0.1/mcp"))).rejects.toBeInstanceOf(
      ClientMcpNetworkError,
    );
    const blocked = policy([{ address: "93.184.216.34", family: 4 }], ["93.184.216.0/24"]);
    await expect(blocked.assertUrl(new URL("https://mcp.example.test/mcp"))).rejects.toMatchObject({
      code: "client_mcp_blocked_address",
    });
  });

  it("revalidates redirects and strips source credentials across origins", async () => {
    const requests: Array<{ url: string; headers: Headers }> = [];
    const request = vi.fn((url: string | URL, init: RequestInit) => {
      requests.push({ url: String(url), headers: new Headers(init.headers) });
      if (requests.length === 1) {
        return Promise.resolve(
          new Response(null, {
            status: 307,
            headers: { location: "https://redirect.example.test/mcp" },
          }),
        );
      }
      return Promise.resolve(new Response("ok", { status: 200 }));
    });
    const safe = createClientMcpFetch({
      policy: new ClientMcpNetworkPolicy({
        resolve: vi.fn(() => Promise.resolve([{ address: "93.184.216.34", family: 4 }])),
      }),
      sensitiveHeaders: ["authorization", "x-api-key"],
      request,
    });

    const response = await safe.fetch("https://mcp.example.test/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "x-api-key": "secret",
        "content-type": "application/json",
      },
      body: "{}",
    });

    expect(response.status).toBe(200);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.headers.get("authorization")).toBeNull();
    expect(requests[1]?.headers.get("x-api-key")).toBeNull();
    expect(requests[1]?.headers.get("content-type")).toBe("application/json");
    await safe.close();
  });
});

function policy(addresses: LookupAddress[], blockedCidrs: string[] = []): ClientMcpNetworkPolicy {
  return new ClientMcpNetworkPolicy({
    resolve: vi.fn(() => Promise.resolve(addresses)),
    blockedCidrs,
  });
}
