import { describe, expect, it, vi } from "vitest";
import { RunWriteAuthority } from "../../../src/adapters/postgres/run-write-authority.js";
import { LearningWriteAuthority } from "../../../src/adapters/postgres/learning-write-authority.js";
import { PostgresExecutionRepository } from "../../../src/adapters/postgres/execution-repository.js";
import { PostgresToolPermissions } from "../../../src/adapters/postgres/tool-permissions.js";
import type { PostgresKernel } from "../../../src/adapters/postgres/kernel.js";
import { AgentOwnershipLostError } from "../../../src/domain/agent-ownership.js";

const input = () => ({
  registration: {
    member_id: "acp-a",
    registration_id: "11111111-1111-4111-8111-111111111111",
    incarnation_id: "22222222-2222-4222-8222-222222222222",
  },
  fence: {
    organizationId: "org-1",
    agentId: "agent-1",
    ownerInstanceId: "22222222-2222-4222-8222-222222222222",
    epoch: "1",
  },
});

describe("current Agent fence with original legacy facts", () => {
  it("captures the current fence while retaining null legacy origin and explicit row mode", async () => {
    const value = input();
    const fixed = structuredClone(value);
    const authority = RunWriteAuthority.fencedLegacy(value);
    value.fence.agentId = "other";
    value.registration.member_id = "other";
    const agentTransaction = vi
      .fn<(fence: unknown, operation: unknown) => Promise<number>>()
      .mockResolvedValue(42);
    const transaction = vi.fn();
    const kernel = { agentTransaction, transaction } as unknown as PostgresKernel;
    expect(await authority.transaction(kernel, () => Promise.resolve(0))).toBe(42);
    expect(agentTransaction.mock.calls[0]?.[0]).toEqual(fixed.fence);
    expect(transaction).not.toHaveBeenCalled();
    expect(authority.origin()).toEqual([null, null, null, null]);
    expect(authority.scope()).toEqual({ organizationId: "org-1", agentId: "agent-1" });
    expect(new LearningWriteAuthority(authority).mode).toBe("legacy");
    expect(() => authority.assertSession({ organization_id: "org-1", agent_id: "other" })).toThrow(
      AgentOwnershipLostError,
    );
  });

  it.each([undefined, { organizationId: "org-1", agentId: "empty-other" }])(
    "rejects absent or foreign recovery scope before any SQL (%j)",
    async (scope) => {
      const query = vi.fn();
      const transaction = vi.fn();
      const agentTransaction = vi.fn();
      const kernel = { query, transaction, agentTransaction } as unknown as PostgresKernel;
      const authority = RunWriteAuthority.fencedLegacy(input());
      await expect(
        new PostgresExecutionRepository(kernel, authority).listRecoveryWork(scope),
      ).rejects.toBeInstanceOf(AgentOwnershipLostError);
      await expect(
        new PostgresToolPermissions(kernel, authority).cancelAbandoned(scope),
      ).rejects.toBeInstanceOf(AgentOwnershipLostError);
      expect(query).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
      expect(agentTransaction).not.toHaveBeenCalled();
    },
  );
});
