import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { PostgresContentPurge } from "../../../src/adapters/postgres/content-purge.js";
import type { PostgresKernel } from "../../../src/adapters/postgres/kernel.js";
import { RunWriteAuthority } from "../../../src/adapters/postgres/run-write-authority.js";
import type { AgentOwnershipFence } from "../../../src/domain/agent-ownership.js";
import type { TelemetryPort } from "../../../src/ports/telemetry.js";

type Call = { text: string; values: readonly unknown[] };
type Rows = Record<string, unknown>[];

function fakeClient(script: (call: Call) => Rows) {
  const calls: Call[] = [];
  const client = {
    query: vi.fn((text: string, values: readonly unknown[] = []) => {
      calls.push({ text, values });
      return Promise.resolve({ rows: script({ text, values }), rowCount: 0 });
    }),
  };
  return { client: client as unknown as PoolClient, calls };
}

function kernelReturning(client: PoolClient, agentOptions?: { options: unknown[] }) {
  const wrap = async (operation: (client: PoolClient) => Promise<unknown>) => {
    await client.query("BEGIN");
    try {
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  };
  return {
    transaction: (operation: (client: PoolClient) => Promise<unknown>) => wrap(operation),
    agentTransaction: async (
      _fence: AgentOwnershipFence,
      operation: (client: PoolClient) => Promise<unknown>,
      options?: unknown,
    ) => {
      agentOptions?.options.push(options);
      return wrap(operation);
    },
  } as unknown as PostgresKernel;
}

const sessionRows = (ids: string[]): Rows =>
  ids.map((id) => ({ id, organization_id: "org-1", agent_id: "agent-1" }));
const countRow = (): Rows => [
  {
    sessions: "2",
    runs: "1",
    messages: "3",
    toolAttempts: "0",
    learningTasks: "0",
    evidenceItems: "0",
    evidenceSnapshots: "0",
    candidates: "0",
    publishedCandidates: "0",
    learningChanges: "0",
  },
];

function script(sessions: string[], blocked = new Set<string>()): (call: Call) => Rows {
  return ({ text, values }) => {
    if (text.includes("AS blocked")) return [{ blocked: blocked.has(values[0] as string) }];
    if (text.includes("AS sessions")) return countRow();
    if (text.includes("FROM acp_sessions")) return sessionRows(sessions);
    if (text.includes("FROM runs"))
      return sessions.map((id, i) => ({ id: `run-${i}`, session_id: id }));
    return [];
  };
}

const legacy = () => RunWriteAuthority.legacy(new AbortController().signal);
const telemetry = (): { port: TelemetryPort; events: string[] } => {
  const events: string[] = [];
  return {
    events,
    port: {
      span: (_n, _a, op) => op(),
      count: () => undefined,
      duration: () => undefined,
      log: (_level, event, attributes) => {
        events.push(`${event}:${JSON.stringify(attributes)}`);
      },
    },
  };
};

describe("PostgresContentPurge", () => {
  it("returns an empty cursor without scanning content when no rows match", async () => {
    const f = fakeClient(script([]));
    const purge = new PostgresContentPurge(kernelReturning(f.client), legacy());
    const cutoff = new Date();
    await expect(
      purge.batch({ cutoff, limit: 10, dryRun: false, signal: new AbortController().signal }),
    ).resolves.toEqual({
      scanned: 0,
      blocked: 0,
      counts: expect.any(Object) as Record<string, number>,
      nextCursor: null,
    });
    expect(f.calls.filter(({ text }) => /\bFROM runs\b/u.test(text))).toHaveLength(0);
    expect(f.calls.filter(({ text }) => /^DELETE|^UPDATE|^INSERT/u.test(text))).toHaveLength(0);
  });

  it("stops after the count query in dry-run mode", async () => {
    const f = fakeClient(script(["s-1", "s-2"]));
    const purge = new PostgresContentPurge(kernelReturning(f.client), legacy());
    const outcome = await purge.batch({
      cutoff: new Date(),
      limit: 10,
      dryRun: true,
      signal: new AbortController().signal,
    });
    expect(outcome.nextCursor).toBe("s-2");
    expect(f.calls.filter(({ text }) => /^DELETE|^UPDATE|^INSERT/u.test(text))).toHaveLength(0);
  });

  it("issues the bounded mutation sequence, audit insert and count-only telemetry", async () => {
    const statements: string[] = [];
    const f = fakeClient(({ text }) => {
      statements.push(text);
      if (text.includes("AS blocked")) return [{ blocked: false }];
      if (text.includes("AS sessions")) return countRow();
      if (text.includes("FROM acp_sessions")) return sessionRows(["s-1", "s-2"]);
      if (text.includes("FROM runs"))
        return [
          { id: "run-1", session_id: "s-1" },
          { id: "run-2", session_id: "s-2" },
        ];
      return [];
    });
    const t = telemetry();
    const purge = new PostgresContentPurge(kernelReturning(f.client), legacy(), t.port);
    const outcome = await purge.batch({
      cutoff: new Date(),
      limit: 10,
      dryRun: false,
      signal: new AbortController().signal,
    });
    expect(outcome).toMatchObject({ scanned: 2, blocked: 0, nextCursor: "s-2" });
    const writes = statements.filter((text) => /^(DELETE|UPDATE|INSERT)/u.test(text));
    expect(writes.length).toBeGreaterThan(5);
    expect(writes.at(-1)).toMatch(/^INSERT INTO content_purge_audit/u);
    expect(writes.some((text) => /DELETE FROM acp_sessions/u.test(text))).toBe(true);
    expect(writes.some((text) => /DELETE FROM runs/u.test(text))).toBe(true);
    expect(writes.some((text) => /model_budget|organization_spend|run_usage/u.test(text))).toBe(
      false,
    );
    expect(t.events).toEqual([
      'acp_content_purge_batch:{"sessions":2,"runs":1,"messages":3,"toolAttempts":0,"learningTasks":0,"evidenceItems":0,"evidenceSnapshots":0,"candidates":0,"publishedCandidates":0,"learningChanges":0}',
    ]);
    expect(statements.at(-1)).toBe("COMMIT");
  });

  it("rolls back instead of committing when aborted before return", async () => {
    const controller = new AbortController();
    const statements: string[] = [];
    const f = fakeClient(({ text }) => {
      statements.push(text);
      if (text.includes("FROM acp_sessions")) {
        controller.abort(new Error("stop"));
        return sessionRows(["s-1"]);
      }
      if (text.includes("AS blocked")) return [{ blocked: false }];
      if (text.includes("AS sessions")) return countRow();
      if (text.includes("FROM runs")) return [{ id: "run-1", session_id: "s-1" }];
      return [];
    });
    const purge = new PostgresContentPurge(kernelReturning(f.client), legacy());
    await expect(
      purge.batch({ limit: 10, dryRun: false, signal: controller.signal }),
    ).rejects.toThrow();
    expect(statements).toContain("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
  });

  it("locks selected Sessions without SKIP LOCKED when the operator waits", async () => {
    const f = fakeClient(script(["s-1"]));
    const purge = new PostgresContentPurge(kernelReturning(f.client), legacy());
    await purge.batch({
      limit: 10,
      dryRun: true,
      waitForLocks: true,
      signal: new AbortController().signal,
    });
    const select = f.calls.find(({ text }) => text.includes("FROM acp_sessions"));
    expect(select?.text).toContain("FOR UPDATE");
    expect(select?.text).not.toContain("SKIP LOCKED");
    const skipped = fakeClient(script(["s-1"]));
    const automated = new PostgresContentPurge(kernelReturning(skipped.client), legacy());
    await automated.batch({
      limit: 10,
      dryRun: true,
      signal: new AbortController().signal,
    });
    const automatedSelect = skipped.calls.find(({ text }) => text.includes("FROM acp_sessions"));
    expect(automatedSelect?.text).toContain("FOR UPDATE SKIP LOCKED");
  });

  it("fails closed when the safety guard returns no verdict", async () => {
    const statements: string[] = [];
    const f = fakeClient(({ text }) => {
      statements.push(text);
      if (text.includes("AS blocked")) return [];
      if (text.includes("FROM acp_sessions")) return sessionRows(["s-1"]);
      return [];
    });
    const purge = new PostgresContentPurge(kernelReturning(f.client), legacy());
    await expect(
      purge.batch({
        limit: 10,
        dryRun: false,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow();
    expect(statements).toContain("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
  });

  it("restricts owned authority to its fence and requires a live fence at commit", async () => {
    const options: unknown[] = [];
    const statements: string[] = [];
    const f = fakeClient(({ text }) => {
      statements.push(text);
      if (text.includes("FROM acp_sessions")) return sessionRows(["s-1"]);
      if (text.includes("AS blocked")) return [{ blocked: false }];
      if (text.includes("AS sessions")) return countRow();
      if (text.includes("FROM runs")) return [{ id: "run-1", session_id: "s-1" }];
      return [];
    });
    const incarnation = randomUUID();
    const authority = RunWriteAuthority.owned({
      registration: {
        registration_id: randomUUID(),
        member_id: "acp-a",
        incarnation_id: incarnation,
      },
      fence: {
        organizationId: "fence-org",
        agentId: "fence-agent",
        ownerInstanceId: incarnation,
        epoch: "1",
      },
    });
    const purge = new PostgresContentPurge(kernelReturning(f.client, { options }), authority);
    await purge.batch({
      organizationId: "other-org",
      cutoff: new Date(),
      limit: 10,
      dryRun: true,
      signal: new AbortController().signal,
    });
    expect(options).toEqual([
      expect.objectContaining({ requireLiveFenceAtCommit: true, organizationBarrier: true }),
    ]);
    const select = statements.find((text) => text.includes("FROM acp_sessions"));
    expect(select).toBeDefined();
  });
});
