import { Pool } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import v1Schema from "@agentclientprotocol/sdk/schema/schema.json" with { type: "json" };
import v2Schema from "@agentclientprotocol/sdk/schema/v2/schema.unstable.json" with { type: "json" };
import { migrate } from "../../src/adapters/postgres/migrate.js";
import { PostgresContextRepository } from "../../src/adapters/postgres/context-repository.js";
import { PostgresKernel } from "../../src/adapters/postgres/kernel.js";
import { startBoundaryApplication } from "../support/postgres-boundary-application.js";
import type { AcpWireClient, ProtocolVersion, WireFrame } from "../support/acp-wire-client.js";
import type { PlanEntry } from "../../src/domain/plan.js";
import { binding, snapshot } from "../support/fixtures.js";
import { PostgresRunRepository } from "../../src/adapters/postgres/run-repository.js";
import {
  DurableRunEvents,
  RunEventPersistenceError,
} from "../../src/application/durable-run-events.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
const setup = { cwd: "/workspace", mcpServers: [] };
const first: PlanEntry[] = [
  { content: "owner plan: inspect", priority: "high", status: "in_progress" },
  { content: "verify", priority: "low", status: "pending" },
];
const updated: PlanEntry[] = [
  { content: "owner plan: inspect", priority: "high", status: "completed" },
];
const validators = [v1Schema, v2Schema].map((schema) =>
  new Ajv2020({ strict: false, validateFormats: false }).compile({
    $ref: "#/$defs/SessionUpdate",
    $defs: schema.$defs,
  }),
);

describe.skipIf(databaseUrl === undefined)("Structured plans over ACP and PostgreSQL", () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  let app: Awaited<ReturnType<typeof startBoundaryApplication>>;
  let close: (() => Promise<void>) | undefined;
  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await migrate(pool);
    app = await startBoundaryApplication(pool);
    close = app.close;
    app.model.complete.mockReset().mockResolvedValue({
      kind: "message",
      content: [{ type: "text", text: "final" }],
      usage: { inputTokens: 1, outputTokens: 1 },
      stopReason: "end_turn",
    });
  });
  afterEach(async () => {
    await close?.();
    close = undefined;
  });
  afterAll(async () => {
    await pool.end();
  });
  function submit(entries: unknown) {
    app.model.complete.mockResolvedValueOnce({
      kind: "tool_calls",
      content: [],
      usage: { inputTokens: 1, outputTokens: 1 },
      calls: [{ id: "same-provider-id", name: "update_plan", arguments: { entries } }],
    });
  }
  for (const version of [1, 2] as const) {
    it(`v${version}: replaces, clears, replays, forks and restores the model's plan without Runtime execution`, async () => {
      const client = await app.connect(version);
      const sessionId = String((await client.request("session/new", setup)).result?.sessionId);
      submit(first);
      await prompt(client, version, sessionId);
      submit(updated);
      await prompt(client, version, sessionId);
      const plans = planUpdates(client.frames);
      expect(plans).toHaveLength(2);
      expect(entries(plans[0]!)).toEqual(first);
      expect(entries(plans[1]!)).toEqual(updated);
      for (const plan of plans) expect(validators[version - 1]!(plan)).toBe(true);
      if (version === 2)
        expect(plans.map((plan) => (plan.plan as { planId: string }).planId)).toEqual([
          "current",
          "current",
        ]);
      expect(client.frames.findIndex((frame) => planUpdates([frame]).length > 0)).toBeLessThan(
        client.frames.findIndex(
          (frame) =>
            frame.params?.update?.sessionUpdate ===
            (version === 1 ? "agent_message_chunk" : "agent_message"),
        ),
      );
      expect(app.tools.call).not.toHaveBeenCalled();
      expect((await pool.query("SELECT * FROM tool_attempts")).rowCount).toBe(0);
      expect(app.finish.mock.calls.every(([value]) => value.toolEffectState === "none")).toBe(true);
      const forkId = String(
        (await client.request("session/fork", { ...setup, sessionId })).result?.sessionId,
      );
      const repository = new PostgresContextRepository(new PostgresKernel(pool));
      const sequence = Number(
        (
          await pool.query<{ sequence: string }>(
            "SELECT max(sequence) AS sequence FROM session_messages WHERE session_id = $1",
            [sessionId],
          )
        ).rows[0]?.sequence,
      );
      await repository.saveCheckpoint({
        id: "checkpoint",
        sessionId,
        throughSequence: sequence,
        summary: "older work",
        tokenCount: 3,
        createdAt: new Date(),
      });
      expect((await repository.load(sessionId)).plan).toEqual(updated);
      submit([]);
      await prompt(client, version, sessionId);
      expect(entries(planUpdates(client.frames).at(-1)!)).toEqual([]);
      expect((await repository.load(sessionId)).plan).toEqual([]);
      expect((await repository.load(forkId)).plan).toEqual(updated);
      const request = app.model.complete.mock.calls.at(-2)![0];
      expect(JSON.stringify(request.messages[1])).toContain("plan at Run start");
      expect(JSON.stringify(request.messages[1])).toContain("owner plan: inspect");
      expect(JSON.stringify(request.messages[0])).not.toContain("owner plan: inspect");
      const allPlans = planUpdates(client.frames);
      for (const subject of ["other-user", "other-agent"]) {
        const stranger = await app.connect(version, subject);
        expect((await replay(stranger, version, sessionId)).error).toBeDefined();
        expect(planUpdates(stranger.frames)).toEqual([]);
      }
      await close?.();
      close = undefined;
      app = await startBoundaryApplication(pool);
      close = app.close;
      const restored = await app.connect(version);
      expect((await replay(restored, version, sessionId)).error).toBeUndefined();
      expect(planUpdates(restored.frames)).toEqual(allPlans);
      expect(app.model.complete).not.toHaveBeenCalled();
      expect(app.tools.call).not.toHaveBeenCalled();
    });
    it(`v${version}: invalid update and subsequent model failure retain the last committed plan`, async () => {
      const client = await app.connect(version);
      const sessionId = String((await client.request("session/new", setup)).result?.sessionId);
      submit(first);
      await prompt(client, version, sessionId);
      submit([{ content: "bad", status: "failed", priority: "high" }]);
      await prompt(client, version, sessionId);
      expect(planUpdates(client.frames)).toHaveLength(1);
      submit(updated);
      app.model.complete.mockRejectedValueOnce(new Error("model stopped"));
      await prompt(client, version, sessionId);
      expect(planUpdates(client.frames)).toHaveLength(2);
      expect(
        (await new PostgresContextRepository(new PostgresKernel(pool)).load(sessionId)).plan,
      ).toEqual(updated);
      expect(app.tools.call).not.toHaveBeenCalled();
    });
  }
  async function localEvents() {
    const runId = "local-run";
    await app.sessions.create({
      sessionId: "local-session",
      binding: binding(),
      cwd: "/workspace",
      mcpRevisionId: "client-mcp-1",
      mcpSources: [],
    });
    const runs = new PostgresRunRepository(new PostgresKernel(pool));
    await runs.createRunIntent({
      runId,
      requestId: "request",
      sessionId: "local-session",
      expectedAccessRevision: "access-1",
      userMessageId: "user",
      prompt: [{ type: "text", text: "work" }],
      createdAt: new Date(),
    });
    await runs.acceptRun({
      runId,
      snapshot: snapshot(),
      environmentFact: null,
      acceptedAt: new Date(),
    });
    const publish = vi.fn(() => Promise.resolve());
    const events = new DurableRunEvents({
      repository: app.events,
      publish,
      id: () => "unused",
      now: () => new Date(),
      contextSize: 64000,
    });
    const update = (id: string, entries: PlanEntry[]) =>
      events.updatePlan(runId, { id, name: "update_plan", arguments: { entries } }, entries);
    return { runs, publish, update };
  }
  it("retains JSON string values through model call, local plan, output and next context", async () => {
    const special: PlanEntry[] = [
      { content: "plan\0\ud800\\u0000", priority: "high", status: "pending" },
    ];
    const client = await app.connect(1);
    const sessionId = String((await client.request("session/new", setup)).result?.sessionId);
    submit(special);
    expect((await prompt(client, 1, sessionId)).error).toBeUndefined();
    expect(entries(planUpdates(client.frames).at(-1)!)).toEqual(special);
    const repository = new PostgresContextRepository(new PostgresKernel(pool));
    expect((await repository.load(sessionId)).plan).toEqual(special);
    expect(JSON.stringify((await repository.load(sessionId)).messages)).toContain(
      "plan\\u0000\\ud800\\\\u0000",
    );
    const restored = await app.connect(1);
    await replay(restored, 1, sessionId);
    expect(planUpdates(restored.frames)).toEqual(planUpdates(client.frames));
  });
  it("rolls back plan, result and sequence together if the second insert fails", async () => {
    const { update, publish } = await localEvents();
    const before = await app.sessions.readOutput("local-session", 0);
    await pool.query(
      `CREATE FUNCTION reject_plan_result() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind = 'tool_call' THEN RAISE EXCEPTION 'fixture result failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_plan_result BEFORE INSERT ON session_messages FOR EACH ROW EXECUTE FUNCTION reject_plan_result()`,
    );
    await expect(update("one", first)).rejects.toBeInstanceOf(RunEventPersistenceError);
    expect(await app.sessions.readOutput("local-session", 0)).toEqual(before);
    expect(publish).not.toHaveBeenCalled();
  });
  it("orders a cancellation committed while plan mutation waits for the Run lock", async () => {
    const { update, publish } = await localEvents();
    const lock = await pool.connect();
    let pending: Promise<boolean> | undefined;
    try {
      await lock.query("BEGIN");
      await lock.query("UPDATE runs SET cancel_requested_at = now() WHERE id = 'local-run'");
      const pid = Number(
        (await lock.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid,
      );
      pending = update("one", first);
      const observed = pending.catch(() => false);
      await vi.waitFor(async () => {
        const blocked = await pool.query<{ waiting: boolean }>(
          "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))) AS waiting",
          [pid],
        );
        expect(blocked.rows[0]?.waiting).toBe(true);
      });
      await lock.query("COMMIT");
      await observed;
      expect(await pending).toBe(false);
      expect(publish).not.toHaveBeenCalled();
      expect(
        (await app.sessions.readOutput("local-session", 0)).events.some(
          (event) => event.kind === "plan",
        ),
      ).toBe(false);
    } finally {
      await lock.query("ROLLBACK");
      lock.release();
      await pending?.catch(() => undefined);
    }
  });
  it("does not let old calls overwrite newer plans or later cancellation undo a commit", async () => {
    const { update, runs } = await localEvents();
    expect(await update("one", first)).toBe(true);
    expect(await update("two", updated)).toBe(true);
    await expect(update("one", first)).rejects.toBeInstanceOf(RunEventPersistenceError);
    await runs.requestCancellation("local-run", new Date());
    expect(await update("three", [])).toBe(false);
    const plans = (await app.sessions.readOutput("local-session", 0)).events.filter(
      (event) => event.kind === "plan",
    );
    expect(plans).toEqual([
      { kind: "plan", entries: first },
      { kind: "plan", entries: updated },
    ]);
  });
  it("keeps committed plan and success when the live subscriber disconnects", async () => {
    const { update, publish } = await localEvents();
    publish.mockRejectedValue(new Error("connection closed"));
    expect(await update("one", first)).toBe(true);
    expect(publish).toHaveBeenCalledTimes(2);
    expect((await app.sessions.readOutput("local-session", 0)).events.slice(-2)).toMatchObject([
      { kind: "plan", entries: first },
      { kind: "tool_call", status: "completed" },
    ]);
  });
  it.each([true, false])(
    "recovers an interrupted local call without executing it again (committed=%j)",
    async (committed) => {
      const { update } = await localEvents();
      await app.events.appendAgentMessage({
        id: "assistant",
        runId: "local-run",
        content: [],
        toolCalls: [{ id: "one", name: "update_plan", arguments: { entries: first } }],
        createdAt: new Date(),
      });
      if (committed) expect(await update("one", first)).toBe(true);
      expect(await app.events.interruptToolAttempts("local-run", new Date())).toEqual({
        toolEffectState: "none",
      });
      const stored = await new PostgresContextRepository(new PostgresKernel(pool)).load(
        "local-session",
      );
      expect(stored.plan).toEqual(committed ? first : undefined);
      const terminal = (await app.sessions.readOutput("local-session", 0)).events.filter(
        (event) => event.kind === "tool_call",
      );
      expect(terminal).toHaveLength(1);
      expect(terminal[0]).toMatchObject({ status: committed ? "completed" : "failed" });
      expect(app.tools.call).not.toHaveBeenCalled();
    },
  );
});

function planUpdates(frames: WireFrame[]) {
  return frames.flatMap((frame) => {
    const update = frame.params?.update;
    return update?.sessionUpdate === "plan" || update?.sessionUpdate === "plan_update"
      ? [update]
      : [];
  });
}
function entries(update: Record<string, unknown>) {
  return update.entries ?? (update.plan as { entries: unknown }).entries;
}
function replay(client: AcpWireClient, version: ProtocolVersion, sessionId: string) {
  return client.request(version === 1 ? "session/load" : "session/resume", {
    ...setup,
    sessionId,
    ...(version === 2 ? { replayFrom: { type: "start" } } : {}),
  });
}
async function prompt(client: AcpWireClient, version: ProtocolVersion, sessionId: string) {
  const offset = client.frames.length;
  const response = await client.request("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "work" }],
  });
  if (version === 2)
    await vi.waitFor(() =>
      expect(
        client.frames
          .slice(offset)
          .some(
            (frame) =>
              frame.params?.update?.sessionUpdate === "state_update" &&
              frame.params.update.state === "idle",
          ),
      ).toBe(true),
    );
  return response;
}
