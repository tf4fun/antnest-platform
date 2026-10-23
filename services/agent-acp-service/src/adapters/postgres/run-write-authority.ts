import type { PoolClient } from "pg";
import {
  parseOwnerRegistration,
  type OwnerRegistration,
} from "../../application/owner-incarnation.js";
import { assertWorkerOwnership } from "../../application/worker-ownership.js";
import {
  AgentOwnershipLostError,
  ownershipFence,
  type AgentOwnershipFence,
} from "../../domain/agent-ownership.js";
import type { PostgresKernel } from "./kernel.js";
import { lockRuntimeBarrierOrganization } from "./runtime-barrier.js";

export type RunOwnerAuthority = Readonly<{
  registration: Readonly<OwnerRegistration>;
  fence: AgentOwnershipFence;
}>;

export type RunOwnerColumns = {
  organization_id: string;
  agent_id: string;
  execution_owner_registration_id: string | null;
  execution_owner_member_id: string | null;
  execution_owner_incarnation_id: string | null;
  execution_owner_epoch: string | null;
};

type Mode =
  | Readonly<{ kind: "legacy"; workerOwnership: AbortSignal }>
  | Readonly<{ kind: "owned"; authority: RunOwnerAuthority }>;

// Each repository captures one explicit mode. An owned failure can never select
// the legacy branch or substitute a newer lease observed after the operation.
export class RunWriteAuthority {
  private constructor(private readonly mode: Mode) {
    Object.freeze(this);
  }

  public static legacy(workerOwnership: AbortSignal): RunWriteAuthority {
    if (!(workerOwnership instanceof AbortSignal))
      throw new TypeError("Legacy Run writers require worker ownership");
    assertWorkerOwnership(workerOwnership);
    return new RunWriteAuthority(Object.freeze({ kind: "legacy", workerOwnership }));
  }

  public static owned(input: RunOwnerAuthority): RunWriteAuthority {
    try {
      const registration = parseOwnerRegistration(input.registration);
      const fence = ownershipFence(input.fence);
      if (fence.ownerInstanceId !== registration.incarnation_id) throw new TypeError();
      const authority = Object.freeze({ registration, fence });
      return new RunWriteAuthority(Object.freeze({ kind: "owned", authority }));
    } catch {
      throw new TypeError("Invalid Run ownership authority");
    }
  }

  public async transaction<T>(
    kernel: PostgresKernel,
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    if (this.mode.kind === "owned")
      return kernel.agentTransaction(this.mode.authority.fence, operation);
    const signal = this.mode.workerOwnership;
    assertWorkerOwnership(signal);
    try {
      // Await the original transaction and rollback, even when ownership is lost.
      const result = await kernel.transaction(operation);
      assertWorkerOwnership(signal);
      return result;
    } catch (error) {
      if (signal.aborted && error !== signal.reason) {
        let ownershipFailure: unknown;
        try {
          assertWorkerOwnership(signal);
        } catch (lost) {
          ownershipFailure = lost;
        }
        if (ownershipFailure !== undefined)
          throw new AggregateError(
            [error, ownershipFailure],
            "Run transaction and worker ownership both failed",
            { cause: error },
          );
      }
      throw error;
    }
  }

  public assertSession(scope: { organization_id: string; agent_id: string }): void {
    if (this.mode.kind === "legacy") return;
    const fence = this.mode.authority.fence;
    if (scope.organization_id !== fence.organizationId || scope.agent_id !== fence.agentId)
      throw new AgentOwnershipLostError();
  }

  public organizationTransaction<T>(
    kernel: PostgresKernel,
    organizationId: string,
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    if (this.mode.kind === "owned") {
      const { fence } = this.mode.authority;
      if (organizationId !== fence.organizationId)
        return Promise.reject(new AgentOwnershipLostError());
      return kernel.agentTransaction(fence, operation, { organizationBarrier: true });
    }
    return this.transaction(kernel, async (client) => {
      await lockRuntimeBarrierOrganization(client, organizationId);
      return operation(client);
    });
  }

  public assertLegacyRecovery(): void {
    if (this.mode.kind !== "legacy") throw new AgentOwnershipLostError();
  }

  public assertRun(row: RunOwnerColumns): void {
    this.assertSession(row);
    const expected = this.origin();
    if (
      row.execution_owner_registration_id !== expected[0] ||
      row.execution_owner_member_id !== expected[1] ||
      row.execution_owner_incarnation_id !== expected[2] ||
      row.execution_owner_epoch !== expected[3]
    )
      throw new AgentOwnershipLostError();
  }

  public origin(): readonly [string | null, string | null, string | null, string | null] {
    if (this.mode.kind === "legacy") return [null, null, null, null];
    const { registration, fence } = this.mode.authority;
    return [
      registration.registration_id,
      registration.member_id,
      registration.incarnation_id,
      fence.epoch,
    ];
  }

  public scope(): Readonly<{ organizationId: string; agentId: string }> | null {
    if (this.mode.kind === "legacy") return null;
    const { organizationId, agentId } = this.mode.authority.fence;
    return Object.freeze({ organizationId, agentId });
  }
}
