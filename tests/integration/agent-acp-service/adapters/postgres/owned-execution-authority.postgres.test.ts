import { describe, expect, it } from "vitest";
import { PostgresExecutionConfiguration } from "../../../../../services/agent-acp-service/src/adapters/postgres/execution-configuration.js";
import { lockRuntimeBarrierOrganization } from "../../../../../services/agent-acp-service/src/adapters/postgres/runtime-barrier.js";
import {
  AgentOwnershipLostError,
  type AgentOwnershipFence,
} from "../../../../../services/agent-acp-service/src/domain/agent-ownership.js";
import {
  publicExecutionConfiguration,
  type ExecutionConfiguration,
} from "../../../../../services/agent-acp-service/src/domain/execution-configuration.js";
import { executionConfiguration } from "../../../../../services/agent-acp-service/test/fixtures/execution-configuration.js";
import { withDatabase } from "../../support/run-fencing-fixture.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
const scope = { organizationId: "organization-1", agentId: "agent-1" };
type OwnedAuthorityReader = {
  loadOwnedAuthority(
    fence: AgentOwnershipFence,
  ): Promise<ExecutionConfiguration | null>;
};

describe.skipIf(databaseUrl === undefined)(
  "fixed owner sealed execution authority",
  () => {
    it("loads the authenticated private configuration only under a current Agent fence", async () => {
      await withDatabase(async (f) => {
        const owner = await f.owner(scope);
        const repository = new PostgresExecutionConfiguration(
          f.kernelA,
          f.secretBox,
        );
        const reader = repository as unknown as OwnedAuthorityReader;
        expect(
          await reader.loadOwnedAuthority(owner.authority.fence),
        ).toBeNull();
        const configuration = executionConfiguration();
        expect(await repository.save(configuration, null)).toBe(true);
        expect(await reader.loadOwnedAuthority(owner.authority.fence)).toEqual(
          configuration,
        );
        const successor = await f.successor(owner);
        await expect(
          reader.loadOwnedAuthority(owner.authority.fence),
        ).rejects.toBeInstanceOf(AgentOwnershipLostError);
        expect(
          await reader.loadOwnedAuthority(successor.authority.fence),
        ).toEqual(configuration);
      });
    });

    it("rejects a lease that expires behind a real row lock without using a mutated caller scope", async () => {
      await withDatabase(async (f) => {
        const owner = await f.owner(scope);
        const other = await f.owner({
          organizationId: "other-organization",
          agentId: scope.agentId,
        });
        const repository = new PostgresExecutionConfiguration(
          f.kernelB,
          f.secretBox,
        );
        const reader = repository as unknown as OwnedAuthorityReader;
        const configuration = executionConfiguration();
        expect(await repository.save(configuration, null)).toBe(true);
        expect(
          await repository.save(
            {
              ...configuration,
              organization_id: other.authority.fence.organizationId,
            },
            null,
          ),
        ).toBe(true);
        const held = await f.holdLease(scope);
        let read: Promise<ExecutionConfiguration | null> | undefined;
        try {
          const mutable = { ...owner.authority.fence };
          read = reader.loadOwnedAuthority(mutable);
          void read.catch(() => undefined);
          await f.waitForBlockedWriter(f.nameB);
          Object.assign(mutable, other.authority.fence);
          await held.query(
            "UPDATE agent_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE organization_id=$1 AND agent_id=$2",
            [scope.organizationId, scope.agentId],
          );
          await f.release(held, true);
          await expect(read).rejects.toBeInstanceOf(AgentOwnershipLostError);
          expect(
            await reader.loadOwnedAuthority(other.authority.fence),
          ).toEqual({
            ...configuration,
            organization_id: other.authority.fence.organizationId,
          });
        } finally {
          try {
            await f.release(held);
          } finally {
            if (read !== undefined) await Promise.allSettled([read]);
          }
        }
      });
    });

    it("does not turn a corrupt seal or a public/private mismatch into an owned configuration", async () => {
      await withDatabase(async (f) => {
        const owner = await f.owner(scope);
        const repository = new PostgresExecutionConfiguration(
          f.kernelA,
          f.secretBox,
        );
        const reader = repository as unknown as OwnedAuthorityReader;
        const configuration = executionConfiguration();
        expect(await repository.save(configuration, null)).toBe(true);
        await f.observer.query(
          "UPDATE execution_configurations SET configuration=jsonb_set(configuration,'{agents,0,system_prompt}',to_jsonb('unsealed mutation'::text)) WHERE organization_id=$1",
          [scope.organizationId],
        );
        await expect(
          reader.loadOwnedAuthority(owner.authority.fence),
        ).rejects.toThrow("Stored execution authority is invalid");
        await f.observer.query(
          "UPDATE execution_configurations SET configuration=$2::jsonb,authority_ciphertext=set_byte(authority_ciphertext,0,get_byte(authority_ciphertext,0)#1) WHERE organization_id=$1",
          [
            scope.organizationId,
            JSON.stringify(publicExecutionConfiguration(configuration)),
          ],
        );
        await expect(
          reader.loadOwnedAuthority(owner.authority.fence),
        ).rejects.toThrow("Stored execution authority is invalid");
      });
    });

    it("waits for the organization publication barrier while another organization remains available", async () => {
      await withDatabase(async (f) => {
        const owner = await f.owner(scope);
        const other = await f.owner({
          organizationId: "other-organization",
          agentId: scope.agentId,
        });
        const repository = new PostgresExecutionConfiguration(
          f.kernelB,
          f.secretBox,
        );
        const configuration = executionConfiguration();
        const independent = {
          ...configuration,
          organization_id: other.authority.fence.organizationId,
        };
        await repository.save(configuration, null);
        await repository.save(independent, null);
        const held = await f.observer.connect();
        let reading: Promise<ExecutionConfiguration | null> | undefined;
        let released = false;
        try {
          await held.query("BEGIN");
          await lockRuntimeBarrierOrganization(held, scope.organizationId);
          reading = repository.loadOwnedAuthority(owner.authority.fence);
          void reading.catch(() => undefined);
          await f.waitForBlockedWriter(f.nameB);
          expect(
            await repository.loadOwnedAuthority(other.authority.fence),
          ).toEqual(independent);
          await held.query("COMMIT");
          held.release();
          released = true;
          expect(await reading).toEqual(configuration);
        } finally {
          try {
            if (!released) {
              let rollbackFailed = true;
              try {
                await held.query("ROLLBACK");
                rollbackFailed = false;
              } finally {
                held.release(rollbackFailed);
              }
            }
          } finally {
            if (reading !== undefined) await Promise.allSettled([reading]);
          }
        }
      });
    });
  },
);
