import type { PoolClient } from "pg";
import {
  AgentLeaseEpochExhaustedError,
  MAX_AGENT_LEASE_EPOCH,
  leaseDuration,
  ownershipFence,
  ownershipInstance,
  ownershipScope,
  type AgentOwnershipFence,
  type AgentOwnershipScope,
} from "../../domain/agent-ownership.js";
import type { AgentLease, AgentLeases } from "../../ports/agent-leases.js";
import type { PostgresKernel } from "./kernel.js";
import { lockPeerParticipation } from "./peer-participation.js";
import type { PeerParticipationGuard } from "../../ports/peer-participation.js";

type LeaseRow = {
  organization_id: string;
  agent_id: string;
  owner_instance_id: string;
  epoch: string;
  expires_at: Date;
  observed_at: Date;
  expired: boolean;
};
const columns = `organization_id, agent_id, owner_instance_id, epoch::text AS epoch,
  expires_at, clock_timestamp() AS observed_at, expires_at <= clock_timestamp() AS expired`;
const budget = { timeoutMs: 10_000 };

export class PostgresAgentLeases implements AgentLeases {
  public constructor(
    private readonly kernel: PostgresKernel,
    private readonly participation?: (scope: AgentOwnershipScope) => PeerParticipationGuard,
  ) {}

  public async tryAcquire(
    input: AgentOwnershipScope,
    instance: string,
    durationMs: number,
  ): Promise<AgentLease | null> {
    const scope = ownershipScope(input);
    const owner = ownershipInstance(instance);
    const ttl = leaseDuration(durationMs);
    const captured = this.participation?.(scope);
    const participation =
      captured === undefined
        ? undefined
        : { membershipSha256: captured.membershipSha256, revision: captured.revision };
    return this.kernel.transaction(async (client) => {
      if (participation !== undefined) await lockPeerParticipation(client, participation);
      await client.query(
        `INSERT INTO agent_leases(organization_id,agent_id,owner_instance_id,epoch,expires_at)
         VALUES ($1,$2,$3,1,clock_timestamp()+$4::integer*interval '1 millisecond')
         ON CONFLICT (organization_id,agent_id) DO NOTHING`,
        [scope.organizationId, scope.agentId, owner, ttl],
      );
      if (!(await lock(client, scope))) throw new Error("Agent lease row is unavailable");
      // Sample expiry in a separate statement after the row lock was obtained.
      const current = (
        await client.query<LeaseRow>(
          `SELECT ${columns} FROM agent_leases WHERE organization_id=$1 AND agent_id=$2`,
          [scope.organizationId, scope.agentId],
        )
      ).rows[0];
      if (current === undefined) throw new Error("Agent lease row is unavailable");
      if (!current.expired) return current.owner_instance_id === owner ? snapshot(current) : null;
      if (current.epoch === MAX_AGENT_LEASE_EPOCH) throw new AgentLeaseEpochExhaustedError();
      const updated = await client.query<LeaseRow>(
        `UPDATE agent_leases SET owner_instance_id=$3,epoch=epoch+1,
           expires_at=clock_timestamp()+$4::integer*interval '1 millisecond',updated_at=clock_timestamp()
         WHERE organization_id=$1 AND agent_id=$2 AND expires_at<=clock_timestamp()
         RETURNING ${columns}`,
        [scope.organizationId, scope.agentId, owner, ttl],
      );
      return updated.rows[0] === undefined ? null : snapshot(updated.rows[0]);
    }, budget);
  }

  public async renew(input: AgentOwnershipFence, durationMs: number): Promise<AgentLease | null> {
    const fence = ownershipFence(input);
    const ttl = leaseDuration(durationMs);
    return this.kernel.transaction(async (client) => {
      if (!(await lock(client, fence))) return null;
      const result = await client.query<LeaseRow>(
        `UPDATE agent_leases SET expires_at=clock_timestamp()+$5::integer*interval '1 millisecond',
           updated_at=clock_timestamp()
         WHERE organization_id=$1 AND agent_id=$2 AND owner_instance_id=$3 AND epoch=$4::bigint
           AND expires_at>clock_timestamp() RETURNING ${columns}`,
        [fence.organizationId, fence.agentId, fence.ownerInstanceId, fence.epoch, ttl],
      );
      return result.rows[0] === undefined ? null : snapshot(result.rows[0]);
    }, budget);
  }

  public async release(input: AgentOwnershipFence): Promise<boolean> {
    const fence = ownershipFence(input);
    return this.kernel.transaction(async (client) => {
      if (!(await lock(client, fence))) return false;
      const result = await client.query(
        `UPDATE agent_leases SET expires_at=clock_timestamp(),updated_at=clock_timestamp()
         WHERE organization_id=$1 AND agent_id=$2 AND owner_instance_id=$3 AND epoch=$4::bigint
           AND expires_at>clock_timestamp()`,
        [fence.organizationId, fence.agentId, fence.ownerInstanceId, fence.epoch],
      );
      return result.rowCount === 1;
    }, budget);
  }

  public async read(input: AgentOwnershipScope): Promise<AgentLease | null> {
    const scope = ownershipScope(input);
    const result = await this.kernel.query<LeaseRow>(
      `SELECT ${columns} FROM agent_leases WHERE organization_id=$1 AND agent_id=$2`,
      [scope.organizationId, scope.agentId],
    );
    return result.rows[0] === undefined ? null : snapshot(result.rows[0]);
  }
}

async function lock(client: PoolClient, scope: AgentOwnershipScope): Promise<boolean> {
  const result = await client.query(
    "SELECT organization_id FROM agent_leases WHERE organization_id=$1 AND agent_id=$2 FOR UPDATE",
    [scope.organizationId, scope.agentId],
  );
  return result.rowCount === 1;
}

function snapshot(row: LeaseRow): AgentLease {
  return Object.freeze({
    fence: ownershipFence({
      organizationId: row.organization_id,
      agentId: row.agent_id,
      ownerInstanceId: row.owner_instance_id,
      epoch: row.epoch,
    }),
    expiresAt: new Date(row.expires_at),
    observedAt: new Date(row.observed_at),
  });
}
