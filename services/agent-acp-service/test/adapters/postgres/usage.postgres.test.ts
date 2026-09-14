import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { migrate } from "../../../src/adapters/postgres/migrate.js";
import { PostgresKernel } from "../../../src/adapters/postgres/kernel.js";
import { SecretBox } from "../../../src/adapters/postgres/secret-box.js";
import { PostgresSessionRepository } from "../../../src/adapters/postgres/session-repository.js";
import { PostgresRunRepository } from "../../../src/adapters/postgres/run-repository.js";
import { PostgresExecutionRepository } from "../../../src/adapters/postgres/execution-repository.js";
import { PostgresRunEventRepository } from "../../../src/adapters/postgres/run-event-repository.js";
import { binding, snapshot } from "../../support/fixtures.js";
import type { ModelUsage } from "../../../src/domain/usage.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
const pricing = { currency: "USD" as const, inputPerMillion: 2, outputPerMillion: 8 };
describe.skipIf(databaseUrl === undefined)("usage receipts in private PostgreSQL", () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  const kernel = new PostgresKernel(pool);
  const sessions = new PostgresSessionRepository(kernel, new SecretBox(randomBytes(32)));
  const runs = new PostgresRunRepository(kernel);
  const executions = new PostgresExecutionRepository(kernel);
  const events = new PostgresRunEventRepository(kernel);
  beforeAll(async () => {
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await migrate(pool);
  });
  afterAll(async () => {
    await pool.end();
  });
  async function session() {
    const id = randomUUID(),
      revision = randomUUID();
    await sessions.create({
      sessionId: id,
      binding: binding(),
      cwd: "/workspace",
      mcpRevisionId: revision,
      mcpSources: [],
    });
    return { id, revision };
  }
  async function run(sessionId: string, revision: string) {
    const id = randomUUID();
    await runs.createRunIntent({
      runId: id,
      requestId: randomUUID(),
      sessionId,
      expectedAccessRevision: "access-1",
      userMessageId: randomUUID(),
      prompt: [{ type: "text", text: "hello" }],
      createdAt: new Date(),
    });
    const admitted = snapshot();
    admitted.clientMcpRevisionId = revision;
    admitted.executionSpec.model.pricing = { ...pricing };
    await runs.acceptRun({
      runId: id,
      snapshot: admitted,
      environmentFact: null,
      sessionTitle: "hello",
      acceptedAt: new Date(),
    });
    return id;
  }
  function receipt(runId: string, amount?: number) {
    const usage: ModelUsage = {
      inputTokens: 100,
      outputTokens: 10,
      ...(amount === undefined
        ? {}
        : { cost: { amount, currency: "USD" as const, source: "estimated" as const, pricing } }),
    };
    return { id: randomUUID(), runId, usage, contextSize: 64000, createdAt: new Date() };
  }
  it("retries one receipt exactly once under the Session lock and rejects conflicting IDs", async () => {
    const source = await session(),
      runId = await run(source.id, source.revision);
    const input = receipt(runId, 0.03);
    const [a, b] = await Promise.all([events.appendUsage(input), events.appendUsage(input)]);
    expect(a).toEqual(b);
    expect(a).toMatchObject({
      kind: "usage",
      cost: { amount: 0.03, currency: "USD" },
      measurement: input.usage,
    });
    await expect(
      events.appendUsage({ ...input, usage: { ...input.usage, outputTokens: 11 } }),
    ).rejects.toThrow("conflict");
    const stored = await pool.query<{ total: number }>(
      "SELECT count(*)::int AS total FROM session_messages WHERE session_id = $1 AND kind = 'usage'",
      [source.id],
    );
    expect(stored.rows[0]?.total).toBe(1);
    const before = await sessions.readOutput(source.id, 0);
    const reopened = new PostgresRunEventRepository(new PostgresKernel(pool));
    await expect(reopened.appendUsage(input)).resolves.toEqual(a);
    expect(await sessions.readOutput(source.id, 0)).toEqual(before);
    const unknown = await reopened.appendUsage(receipt(runId));
    expect(unknown).toMatchObject({
      cost: { amount: 0.03 },
      measurement: { inputTokens: 100, outputTokens: 10 },
    });
    const audited = await pool.query<{ execution_snapshot: unknown }>(
      "SELECT execution_snapshot FROM runs WHERE id = $1",
      [runId],
    );
    expect(audited.rows[0]?.execution_snapshot).toMatchObject({
      executionSpec: { model: { pricing } },
    });
  });
  it("forks the saved known-cost baseline without changing the source or repricing it", async () => {
    const source = await session(),
      runId = await run(source.id, source.revision);
    await events.appendUsage(receipt(runId, 0.02));
    await executions.finish({
      runId,
      terminalClass: "completed",
      executorState: "quiescent",
      toolEffectState: "none",
      stopReason: "end_turn",
      finishedAt: new Date(),
    });
    const id = randomUUID(),
      revision = randomUUID();
    await sessions.fork({
      sourceSessionId: source.id,
      sessionId: id,
      mcpRevisionId: revision,
      mcpSources: [],
      createdAt: new Date(),
    });
    const forkRun = await run(id, revision);
    const added = await events.appendUsage(receipt(forkRun, 0.04));
    expect(added).toMatchObject({ cost: { currency: "USD" } });
    if (added.kind !== "usage") throw new Error("expected usage");
    expect(added.cost?.amount).toBeCloseTo(0.06, 12);
    const original = (await sessions.readOutput(source.id, 0)).events.filter(
      (e) => e.kind === "usage",
    );
    expect(original).toHaveLength(1);
    expect(original[0]?.cost?.amount).toBe(0.02);
    const forked = (await sessions.readOutput(id, 0)).events.filter((e) => e.kind === "usage");
    expect(forked).toHaveLength(2);
    expect(forked[0]?.measurement?.cost).toEqual({
      amount: 0.02,
      currency: "USD",
      source: "estimated",
      pricing,
    });
  });

  it("rechecks a receipt after waiting for a writer that also completed the Run", async () => {
    const source = await session(),
      runId = await run(source.id, source.revision);
    const input = receipt(runId, 0.03);
    const writer = await pool.connect();
    let retry: Promise<unknown> | undefined;
    try {
      await writer.query("BEGIN");
      const locked = await writer.query<{ last_message_sequence: string }>(
        "SELECT last_message_sequence FROM acp_sessions WHERE id = $1 FOR UPDATE",
        [source.id],
      );
      retry = events.appendUsage(input);
      void retry.catch(() => undefined);
      await vi.waitFor(async () => {
        const waiting = await pool.query<{ total: number }>(
          "SELECT count(*)::int AS total FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%last_message_sequence%FOR UPDATE%'",
        );
        expect(waiting.rows[0]?.total).toBe(1);
      });
      const saved = {
        kind: "usage",
        used: 110,
        size: input.contextSize,
        measurement: input.usage,
        cost: { amount: 0.03, currency: "USD" },
      };
      const sequence = Number(locked.rows[0]?.last_message_sequence) + 1;
      await writer.query(
        "INSERT INTO session_messages (id, session_id, run_id, sequence, kind, visible, payload, created_at) VALUES ($1, $2, $3, $4, 'usage', true, $5::jsonb, now())",
        [input.id, source.id, runId, sequence, JSON.stringify(saved)],
      );
      await writer.query("UPDATE acp_sessions SET last_message_sequence = $2 WHERE id = $1", [
        source.id,
        sequence,
      ]);
      await writer.query(
        "UPDATE runs SET state = 'completed', terminal_class = 'completed', executor_state = 'quiescent', tool_effect_state = 'none', stop_reason = 'end_turn' WHERE id = $1",
        [runId],
      );
      await writer.query("COMMIT");
      await expect(retry).resolves.toEqual(saved);
      await expect(events.appendUsage(input)).resolves.toEqual(saved);
      await expect(events.appendUsage(receipt(runId, 0.04))).rejects.toThrow("Run is not running");
      expect(
        (await sessions.readOutput(source.id, 0)).events.filter((event) => event.kind === "usage"),
      ).toEqual([saved]);
    } finally {
      await writer.query("ROLLBACK");
      writer.release();
      await retry?.catch(() => undefined);
    }
  });
});
