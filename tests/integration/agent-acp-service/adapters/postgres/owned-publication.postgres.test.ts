import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { PostgresExecutionConfiguration } from "../../../../../services/agent-acp-service/src/adapters/postgres/execution-configuration.js";
import {
  AgentOwnershipLostError,
  type AgentOwnershipFence,
} from "../../../../../services/agent-acp-service/src/domain/agent-ownership.js";
import type { ExecutionConfiguration } from "../../../../../services/agent-acp-service/src/domain/execution-configuration.js";
import {
  executionConfiguration,
  runtimeConfiguration,
} from "../../../../../services/agent-acp-service/test/fixtures/execution-configuration.js";
import { withDatabase } from "../../support/run-fencing-fixture.js";
const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
type Confirmer = {
  confirmOwnedAuthority(
    expected: ExecutionConfiguration,
    fences: readonly AgentOwnershipFence[],
  ): Promise<void>;
};

describe.skipIf(databaseUrl === undefined)(
  "complete owned publication acknowledgement",
  () => {
    it("requires every accepting Agent and the unchanged private authority", async () => {
      await withDatabase(async (f) => {
        const configuration = executionConfiguration();
        configuration.agents.push({
          ...structuredClone(configuration.agents[0]!),
          agent_id: "agent-2",
          runtime: runtimeConfiguration(2),
        });
        const owners = await Promise.all(
          configuration.agents.map((agent) =>
            f.owner({
              organizationId: configuration.organization_id,
              agentId: agent.agent_id,
            }),
          ),
        );
        const repository = new PostgresExecutionConfiguration(
          f.kernelA,
          f.secretBox,
        );
        const confirm = repository as unknown as Confirmer;
        await repository.save(configuration, null);
        const fences = owners.map((owner) => owner.authority.fence);
        await expect(
          confirm.confirmOwnedAuthority(configuration, fences.slice(0, 1)),
        ).rejects.toThrow();
        await confirm.confirmOwnedAuthority(configuration, fences);
        const newer = structuredClone(configuration);
        newer.revision++;
        await repository.save(newer, configuration.revision);
        await expect(
          confirm.confirmOwnedAuthority(configuration, fences),
        ).rejects.toThrow();
        await confirm.confirmOwnedAuthority(newer, fences);
        await f.successor(owners[0]!);
        await expect(
          confirm.confirmOwnedAuthority(newer, fences),
        ).rejects.toBeInstanceOf(AgentOwnershipLostError);
        expect(
          await repository.loadAuthority(configuration.organization_id),
        ).toEqual(newer);
      });
    });

    it("checks every lease again after waiting for the last Agent row and captures caller inputs", async () => {
      await withDatabase(async (f) => {
        const configuration = executionConfiguration();
        configuration.agents.push({
          ...structuredClone(configuration.agents[0]!),
          agent_id: "agent-2",
          runtime: runtimeConfiguration(2),
        });
        const owners = [];
        for (const agent of configuration.agents)
          owners.push(
            await f.owner({
              organizationId: configuration.organization_id,
              agentId: agent.agent_id,
            }),
          );
        const repository = new PostgresExecutionConfiguration(
          f.kernelB,
          f.secretBox,
        );
        const confirm = repository as unknown as Confirmer;
        await repository.save(configuration, null);
        await f.observer.query(
          "UPDATE agent_leases SET expires_at=clock_timestamp()+interval '500 milliseconds' WHERE organization_id=$1 AND agent_id=$2",
          [configuration.organization_id, "agent-1"],
        );
        const held = await f.holdLease(owners[1]!.authority.fence);
        let confirmation: Promise<void> | undefined;
        try {
          const mutable = owners.map((owner) => ({ ...owner.authority.fence }));
          confirmation = confirm.confirmOwnedAuthority(configuration, mutable);
          void confirmation.catch(() => undefined);
          await f.waitForBlockedWriter(f.nameB);
          mutable.splice(0, 1);
          await delay(700);
          await f.release(held);
          await expect(confirmation).rejects.toBeInstanceOf(
            AgentOwnershipLostError,
          );
        } finally {
          try {
            await f.release(held);
          } finally {
            if (confirmation !== undefined)
              await Promise.allSettled([confirmation]);
          }
        }
      });
    });
  },
);
