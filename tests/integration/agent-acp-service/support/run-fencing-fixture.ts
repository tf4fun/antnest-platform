import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { expect } from "vitest";
import { PostgresAgentLeases } from "../../../../services/agent-acp-service/src/adapters/postgres/agent-leases.js";
import { PostgresKernel } from "../../../../services/agent-acp-service/src/adapters/postgres/kernel.js";
import { migrate } from "../../../../services/agent-acp-service/src/adapters/postgres/migrate.js";
import {
  createLegacyRunRepositories,
  createOwnedRunRepositories,
} from "../../../../services/agent-acp-service/src/adapters/postgres/run-repositories.js";
import { SecretBox } from "../../../../services/agent-acp-service/src/adapters/postgres/secret-box.js";
import {
  createLegacySessionRepository,
  type PostgresSessionRepository,
} from "../../../../services/agent-acp-service/src/adapters/postgres/session-repository.js";
import type { OwnerRegistration } from "../../../../services/agent-acp-service/src/application/owner-incarnation.js";
import {
  AgentOwnershipLostError,
  type AgentOwnershipScope,
} from "../../../../services/agent-acp-service/src/domain/agent-ownership.js";
import { publicExecutionConfiguration } from "../../../../services/agent-acp-service/src/domain/execution-configuration.js";
import { runSnapshot } from "../../../../services/agent-acp-service/src/domain/run-snapshot.js";
import type { ConnectionBinding } from "../../../../services/agent-acp-service/src/domain/types.js";
import type {
  AcceptRunInput,
  CreateRunIntentInput,
  RunRepository,
} from "../../../../services/agent-acp-service/src/ports/run-repository.js";
import { executionConfiguration } from "../../../../services/agent-acp-service/test/fixtures/execution-configuration.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
export const duration = 30_000;
export type Session = {
  sessionId: string;
  mcpRevisionId: string;
  binding: ConnectionBinding;
};
export type MutableFence = {
  organizationId: string;
  agentId: string;
  ownerInstanceId: string;
  epoch: string;
};
export type Owned = {
  authority: { fence: MutableFence; registration: OwnerRegistration };
  runs: RunRepository;
};
export type Origin = {
  execution_owner_registration_id: string | null;
  execution_owner_member_id: string | null;
  execution_owner_incarnation_id: string | null;
  execution_owner_epoch: string | null;
};

export function registration(member = "acp-a"): OwnerRegistration {
  return {
    registration_id: randomUUID(),
    member_id: member,
    incarnation_id: randomUUID(),
  };
}

export function expectedOrigin(owner: Owned): Origin {
  return {
    execution_owner_registration_id:
      owner.authority.registration.registration_id,
    execution_owner_member_id: owner.authority.registration.member_id,
    execution_owner_incarnation_id: owner.authority.registration.incarnation_id,
    execution_owner_epoch: owner.authority.fence.epoch,
  };
}

export class FencingFixture {
  private readonly schema = `acp_run_fencing_${randomUUID().replaceAll("-", "")}`;
  private readonly pools: Pool[];
  private readonly held = new Set<PoolClient>();
  private readonly operations: Promise<unknown>[] = [];
  private created = false;
  public readonly a: Pool;
  public readonly b: Pool;
  public readonly observer: Pool;
  public readonly kernelA: PostgresKernel;
  public readonly kernelB: PostgresKernel;
  public readonly leasesA: PostgresAgentLeases;
  public readonly leasesB: PostgresAgentLeases;
  public readonly nameA = `run-fencing-a-${randomUUID()}`;
  public readonly nameB = `run-fencing-b-${randomUUID()}`;
  private readonly sessions: PostgresSessionRepository;
  public readonly secretBox = new SecretBox(randomBytes(32));

  public constructor(url: string) {
    const pool = (applicationName: string) =>
      new Pool({
        connectionString: url,
        application_name: applicationName,
        options: `-c search_path=${this.schema}`,
        max: 2,
        connectionTimeoutMillis: 5_000,
        statement_timeout: 5_000,
        query_timeout: 6_000,
      });
    this.a = pool(this.nameA);
    this.b = pool(this.nameB);
    this.observer = pool(`run-fencing-observer-${randomUUID()}`);
    this.pools = [this.a, this.b, this.observer];
    this.kernelA = new PostgresKernel(this.a);
    this.kernelB = new PostgresKernel(this.b);
    this.leasesA = new PostgresAgentLeases(this.kernelA);
    this.leasesB = new PostgresAgentLeases(this.kernelB);
    this.sessions = createLegacySessionRepository(
      this.kernelA,
      this.secretBox,
      new AbortController().signal,
    );
  }

  public async initialize(): Promise<void> {
    // The generated identifier contains only lowercase letters, digits and underscores.
    // No other test's public schema is dropped or searched by these connections.
    await this.observer.query(`CREATE SCHEMA ${this.schema}`);
    this.created = true;
    await migrate(this.a);
  }

  public async session(scope: AgentOwnershipScope): Promise<Session> {
    const session: Session = {
      sessionId: randomUUID(),
      mcpRevisionId: randomUUID(),
      binding: {
        connectionId: randomUUID(),
        ...scope,
        principalId: "principal-1",
      },
    };
    await this.sessions.create({
      ...session,
      cwd: "/workspace",
      mcpSources: [],
    });
    return session;
  }

  public async owner(
    scope: AgentOwnershipScope,
    original = registration(),
    side: "a" | "b" = "a",
  ): Promise<Owned> {
    const leases = side === "a" ? this.leasesA : this.leasesB;
    const lease = await leases.tryAcquire(
      scope,
      original.incarnation_id,
      duration,
    );
    if (lease === null)
      throw new Error("Expected an acquired test Agent lease");
    const authority = {
      fence: { ...lease.fence },
      registration: { ...original },
    };
    return {
      authority,
      runs: createOwnedRunRepositories(
        side === "a" ? this.kernelA : this.kernelB,
        authority,
      ).runs,
    };
  }

  public legacy(): RunRepository {
    // This explicit signal is fixture authority only. The existing global worker
    // lock integration tests separately prove actual lock acquisition and loss.
    return createLegacyRunRepositories(
      this.kernelA,
      new AbortController().signal,
    ).runs;
  }

  public input(session: Session): CreateRunIntentInput {
    return {
      runId: randomUUID(),
      requestId: randomUUID(),
      sessionId: session.sessionId,
      expectedAccessRevision: "access-1",
      userMessageId: randomUUID(),
      prompt: [{ type: "text", text: "Persist this exact owned Prompt once" }],
      createdAt: new Date(),
    };
  }

  public acceptance(session: Session, runId: string): AcceptRunInput {
    const configuration = executionConfiguration();
    configuration.organization_id = session.binding.organizationId;
    configuration.agents[0]!.agent_id = session.binding.agentId;
    configuration.agents[0]!.principal_ids = [session.binding.principalId];
    return {
      runId,
      snapshot: runSnapshot({
        configuration: publicExecutionConfiguration(configuration),
        identity: session.binding,
        overrides: {},
        accessRevision: "access-1",
        clientMcpRevisionId: session.mcpRevisionId,
        deadlineAt: new Date(Date.now() + 60_000),
      }),
      environmentFact: null,
      acceptedAt: new Date(),
    };
  }

  public async origin(runId: string): Promise<Origin> {
    const result = await this.observer.query<Origin>(
      `SELECT execution_owner_registration_id, execution_owner_member_id,
              execution_owner_incarnation_id, execution_owner_epoch::text
         FROM runs WHERE id=$1`,
      [runId],
    );
    if (result.rows[0] === undefined)
      throw new Error("Expected a stored Run origin");
    return result.rows[0];
  }

  public async snapshot(): Promise<string> {
    const result = await this.observer.query<{ value: string }>(
      `SELECT jsonb_build_object(
        'sessions', (SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY s.id),'[]'::jsonb) FROM acp_sessions s),
        'runs', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]'::jsonb) FROM runs r),
        'messages', (SELECT COALESCE(jsonb_agg(to_jsonb(m) ORDER BY m.id),'[]'::jsonb) FROM session_messages m),
        'mcp', (SELECT COALESCE(jsonb_agg(to_jsonb(m) ORDER BY m.id),'[]'::jsonb) FROM client_mcp_revisions m),
        'attempts', (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM tool_attempts t),
        'checkpoints', (SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY c.id),'[]'::jsonb) FROM context_checkpoints c)
      )::text AS value`,
    );
    if (result.rows[0] === undefined)
      throw new Error("Expected a business snapshot");
    return result.rows[0].value;
  }

  public async denied(operation: () => Promise<unknown>): Promise<void> {
    const before = await this.snapshot();
    await expect(operation()).rejects.toBeInstanceOf(AgentOwnershipLostError);
    expect(await this.snapshot()).toBe(before);
  }

  public async denyRunMutations(
    runs: RunRepository,
    original: Session,
    runId: string,
  ): Promise<void> {
    const accept = this.acceptance(original, runId);
    for (const operation of [
      () => runs.acceptRun(accept),
      () => runs.rejectRun(runId, "fenced_test_rejection", new Date()),
      () => runs.requestCancellation(runId, new Date()),
    ])
      await this.denied(operation);
  }

  public async successor(
    owner: Owned,
    next = registration("acp-b"),
  ): Promise<Owned> {
    expect(await this.leasesA.release(owner.authority.fence)).toBe(true);
    return this.owner(owner.authority.fence, next, "b");
  }

  public async holdLease(scope: AgentOwnershipScope): Promise<PoolClient> {
    const client = await this.observer.connect();
    this.held.add(client);
    await client.query("BEGIN");
    await client.query(
      "SELECT organization_id FROM agent_leases WHERE organization_id=$1 AND agent_id=$2 FOR UPDATE",
      [scope.organizationId, scope.agentId],
    );
    return client;
  }

  public async holdSession(sessionId: string): Promise<PoolClient> {
    const client = await this.observer.connect();
    this.held.add(client);
    await client.query("BEGIN");
    await client.query("SELECT id FROM acp_sessions WHERE id=$1 FOR UPDATE", [
      sessionId,
    ]);
    return client;
  }

  public async release(client: PoolClient, commit = false): Promise<void> {
    if (!this.held.delete(client)) return;
    let failure: Error | undefined;
    try {
      await client.query(commit ? "COMMIT" : "ROLLBACK");
    } catch (error) {
      failure =
        error instanceof Error ? error : new Error("Fixture rollback failed");
      throw error;
    } finally {
      client.release(failure);
    }
  }

  public observe<T>(operation: Promise<T>): Promise<T> {
    this.operations.push(operation);
    void operation.catch(() => undefined);
    return operation;
  }

  public async waitForBlockedWriter(name = this.nameA): Promise<void> {
    await expect
      .poll(
        async () =>
          (
            await this.observer.query<{ blocked: boolean }>(
              `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1
          AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0) AS blocked`,
              [name],
            )
          ).rows[0]?.blocked,
        { timeout: 3000 },
      )
      .toBe(true);
  }

  public async close(): Promise<void> {
    const failures: unknown[] = [];
    for (const client of [...this.held]) {
      try {
        await this.release(client);
      } catch (error) {
        failures.push(error);
      }
    }
    for (const result of await Promise.allSettled(this.operations))
      if (result.status === "rejected") failures.push(result.reason as unknown);
    for (const result of await Promise.allSettled([this.a.end(), this.b.end()]))
      if (result.status === "rejected") failures.push(result.reason as unknown);
    try {
      if (this.created)
        await this.observer.query(`DROP SCHEMA ${this.schema} CASCADE`);
    } catch (error) {
      failures.push(error);
    } finally {
      try {
        await this.observer.end();
      } catch (error) {
        failures.push(error);
      }
    }
    for (const pool of this.pools) {
      try {
        expect(pool.totalCount).toBe(0);
        expect(pool.waitingCount).toBe(0);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0)
      throw new AggregateError(failures, "Run fencing fixture cleanup failed");
  }
}

export async function withDatabase(
  work: (fixture: FencingFixture) => Promise<void>,
) {
  if (databaseUrl === undefined)
    throw new Error("PostgreSQL test database is not configured");
  const fixture = new FencingFixture(databaseUrl);
  const failures: unknown[] = [];
  try {
    await fixture.initialize();
    await work(fixture);
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      await fixture.close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(
      failures,
      "Run fencing business or cleanup failed",
    );
}

export const scope = (
  agentId: string,
  organizationId = "organization-1",
): AgentOwnershipScope => ({
  organizationId,
  agentId,
});
