import { describe, expect, it, vi } from "vitest";
import { PostgresAgentLeases } from "../../../src/adapters/postgres/agent-leases.js";
import { PostgresKernel } from "../../../src/adapters/postgres/kernel.js";

const scope = { organizationId: "organization-1", agentId: "agent-1" };
const fence = { ...scope, ownerInstanceId: "worker-a", epoch: "1" };

describe("Agent lease input boundaries", () => {
  it("does not renew or release a lease inserted after the locking lookup missed", async () => {
    const query = vi.fn((sql: string) =>
      Promise.resolve(
        sql.includes("FOR UPDATE")
          ? { rows: [], rowCount: 0 }
          : {
              rowCount: 1,
              rows: [
                {
                  organization_id: scope.organizationId,
                  agent_id: scope.agentId,
                  owner_instance_id: fence.ownerInstanceId,
                  epoch: "1",
                  expires_at: new Date("2030-01-01T00:00:00Z"),
                  observed_at: new Date("2026-01-01T00:00:00Z"),
                  expired: false,
                },
              ],
            },
      ),
    );
    const transaction = (operation: (client: { query: typeof query }) => Promise<unknown>) =>
      operation({ query });
    const leases = new PostgresAgentLeases({ transaction } as never);
    expect(await leases.renew(fence, 30_000)).toBeNull();
    expect(await leases.release(fence)).toBe(false);
    expect(query.mock.calls.every(([sql]) => sql.includes("FOR UPDATE"))).toBe(true);
  });

  it.each([0, -1, 999, 300_001, 1.5, NaN, Infinity])(
    "rejects invalid TTL %s before starting a transaction",
    async (ttl) => {
      const transaction = vi.fn();
      const leases = new PostgresAgentLeases({ transaction } as never);
      await expect(leases.tryAcquire(scope, "worker-a", ttl)).rejects.toThrow();
      await expect(leases.renew(fence, ttl)).rejects.toThrow();
      expect(transaction).not.toHaveBeenCalled();
    },
  );

  it.each(["", "0", "-1", "01", "1.5", "9223372036854775808", "not-an-epoch"])(
    "rejects invalid epoch %s before starting a transaction",
    async (epoch) => {
      const transaction = vi.fn();
      const leases = new PostgresAgentLeases({ transaction } as never);
      await expect(leases.renew({ ...fence, epoch }, 30_000)).rejects.toThrow();
      await expect(leases.release({ ...fence, epoch })).rejects.toThrow();
      expect(transaction).not.toHaveBeenCalled();
    },
  );

  it.each(["organizationId", "agentId", "ownerInstanceId"] as const)(
    "rejects an empty %s without database access",
    async (field) => {
      const connect = vi.fn();
      const kernel = new PostgresKernel({ connect } as never);
      await expect(async () =>
        kernel.agentTransaction({ ...fence, [field]: "" }, () => Promise.resolve()),
      ).rejects.toThrow();
      expect(connect).not.toHaveBeenCalled();
    },
  );

  it.each([0, -1, 1.5, NaN, Infinity, 300_001])(
    "rejects invalid transaction budget %s before database access",
    async (timeoutMs) => {
      const connect = vi.fn();
      const kernel = new PostgresKernel({ connect } as never);
      await expect(async () =>
        kernel.agentTransaction(fence, () => Promise.resolve(), { timeoutMs }),
      ).rejects.toThrow();
      expect(connect).not.toHaveBeenCalled();
    },
  );
});
