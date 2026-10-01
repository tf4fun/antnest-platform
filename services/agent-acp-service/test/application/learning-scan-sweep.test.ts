import { describe, expect, it, vi } from "vitest";

import { LearningScanSweep } from "../../src/application/learning-scan-sweep.js";

const first = { organizationId: "org", agentId: "agent-a", ownerId: "owner" };
const second = { organizationId: "org", agentId: "agent-b", ownerId: "owner" };

describe("Learning scan sweep", () => {
  it("scans one bounded keyset page serially and advances despite one unavailable policy", async () => {
    const visited: string[] = [];
    const failures: string[] = [];
    const scopes = { listScopes: vi.fn(() => Promise.resolve([first, second])) };
    const scan = {
      scanPage: vi.fn((scope: typeof first) => {
        visited.push(scope.agentId);
        if (scope.agentId === first.agentId) return Promise.reject(new Error("policy unavailable"));
        return Promise.resolve({ decided: 1, queued: 1, queueFull: false });
      }),
    };
    const sweep = new LearningScanSweep(scopes, scan, (scope, error) => {
      failures.push(`${scope.agentId}:${(error as Error).message}`);
    });
    expect(await sweep.next(null, new AbortController().signal)).toEqual({
      after: second,
      scanned: 1,
      failed: 1,
      queued: 1,
      exhausted: false,
    });
    expect(visited).toEqual(["agent-a", "agent-b"]);
    expect(failures).toEqual(["agent-a:policy unavailable"]);
    expect(scopes.listScopes).toHaveBeenCalledWith(null, 100);
  });

  it("ends on an empty page and does not swallow cancellation", async () => {
    const empty = new LearningScanSweep(
      { listScopes: () => Promise.resolve([]) },
      { scanPage: () => Promise.resolve({ decided: 0, queued: 0, queueFull: false }) },
    );
    expect(await empty.next(second, new AbortController().signal)).toEqual({
      after: null,
      scanned: 0,
      failed: 0,
      queued: 0,
      exhausted: true,
    });
    const cancelled = new AbortController();
    cancelled.abort(new Error("owner lost"));
    await expect(empty.next(null, cancelled.signal)).rejects.toThrow("owner lost");
  });
});
