import { randomBytes, randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SecretBox } from "../../../src/adapters/postgres/secret-box.js";
import { migrate } from "../../../src/adapters/postgres/migrate.js";
import { PostgresKernel } from "../../../src/adapters/postgres/kernel.js";
import { PostgresSessionRepository } from "../../../src/adapters/postgres/session-repository.js";
import { PostgresRunRepository } from "../../../src/adapters/postgres/run-repository.js";
import { PostgresContextRepository } from "../../../src/adapters/postgres/context-repository.js";
import { PostgresExecutionRepository } from "../../../src/adapters/postgres/execution-repository.js";
import { PostgresRunEventRepository } from "../../../src/adapters/postgres/run-event-repository.js";
import type { RunExecutionSnapshot } from "../../../src/domain/types.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;

describe.skipIf(databaseUrl === undefined)("Agent ACP private PostgreSQL repositories", () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  const kernel = new PostgresKernel(pool);
  const secretBox = new SecretBox(randomBytes(32));
  const sessions = new PostgresSessionRepository(kernel, secretBox);
  const runs = new PostgresRunRepository(kernel);
  const contexts = new PostgresContextRepository(kernel);
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

  it("round-trips encrypted client MCP and never stores the header plaintext", async () => {
    const sessionId = randomUUID();
    const revisionId = randomUUID();
    await sessions.create({
      sessionId,
      binding: {
        connectionId: "connection-1",
        authenticatedSubject: "subject-1",
        principalId: "principal-1",
        agentId: "agent-1",
        accessRevision: "access-1",
      },
      cwd: "/workspace",
      mcpRevisionId: revisionId,
      mcpSources: [
        {
          sourceId: "source-1",
          name: "knowledge",
          url: "https://mcp.example.test/service",
          headers: [{ name: "authorization", value: "never-store-this-in-plaintext" }],
        },
      ],
    });

    await expect(sessions.getClientMcpRevision(revisionId)).resolves.toMatchObject([
      {
        sourceId: "source-1",
        headers: [{ name: "authorization", value: "never-store-this-in-plaintext" }],
      },
    ]);
    const stored = await pool.query<{ encrypted_sources: Buffer }>(
      "SELECT encrypted_sources FROM client_mcp_revisions WHERE id = $1",
      [revisionId],
    );
    expect(stored.rows[0]?.encrypted_sources.toString("utf8")).not.toContain(
      "never-store-this-in-plaintext",
    );
  });

  it("atomically stores a Run snapshot, hidden environment fact, user message, and baseline", async () => {
    const sessionId = randomUUID();
    const revisionId = randomUUID();
    const runId = randomUUID();
    await sessions.create({
      sessionId,
      binding: {
        connectionId: "connection-1",
        authenticatedSubject: "subject-1",
        principalId: "principal-1",
        agentId: "agent-1",
        accessRevision: "access-1",
      },
      cwd: "/workspace",
      mcpRevisionId: revisionId,
      mcpSources: [],
    });
    await pool.query(
      "UPDATE acp_sessions SET last_execution_revision = 'execution-1' WHERE id = $1",
      [sessionId],
    );
    await runs.createRunIntent({
      runId,
      requestId: randomUUID(),
      sessionId,
      userMessageId: randomUUID(),
      prompt: [{ type: "text", text: "hello" }],
      createdAt: new Date("2026-08-30T00:00:00Z"),
    });

    await expect(
      runs.acceptRun({
        runId,
        snapshot: snapshot(revisionId),
        environmentFact: {
          kind: "environment_change",
          visible: false,
          content: "environment changed",
          previousExecutionRevision: "execution-1",
          currentExecutionRevision: "execution-2",
        },
        acceptedAt: new Date("2026-08-30T00:00:01Z"),
      }),
    ).resolves.toBe("accepted");

    const persistedRun = await pool.query<{ state: string; execution_snapshot: unknown }>(
      "SELECT state, execution_snapshot FROM runs WHERE id = $1",
      [runId],
    );
    expect(persistedRun.rows[0]).toMatchObject({ state: "running" });
    expect(persistedRun.rows[0]?.execution_snapshot).toMatchObject({
      executionRevision: "execution-2",
    });
    const messages = await pool.query<{ kind: string; visible: boolean; sequence: string }>(
      "SELECT kind, visible, sequence FROM session_messages WHERE session_id = $1 ORDER BY sequence",
      [sessionId],
    );
    expect(messages.rows).toEqual([
      { kind: "environment_change", visible: false, sequence: "1" },
      { kind: "user_message", visible: true, sequence: "2" },
    ]);
    await expect(sessions.get(sessionId)).resolves.toMatchObject({
      lastExecutionRevision: "execution-2",
      lastMessageSequence: 2,
    });
    await expect(sessions.getCurrentRunState(sessionId)).resolves.toEqual({
      kind: "state",
      state: "running",
    });
  });

  it("persists replay events, context checkpoints, Tool attempts, and terminal Run facts", async () => {
    const sessionId = randomUUID();
    const revisionId = randomUUID();
    const runId = randomUUID();
    await sessions.create({
      sessionId,
      binding: {
        connectionId: "connection-2",
        authenticatedSubject: "subject-2",
        principalId: "principal-2",
        agentId: "agent-2",
        accessRevision: "access-2",
      },
      cwd: "/workspace",
      mcpRevisionId: revisionId,
      mcpSources: [],
    });
    await runs.createRunIntent({
      runId,
      requestId: randomUUID(),
      sessionId,
      userMessageId: randomUUID(),
      prompt: [{ type: "text", text: "inspect" }],
      createdAt: new Date("2026-08-30T01:00:00Z"),
    });
    await runs.acceptRun({
      runId,
      snapshot: snapshot(revisionId),
      environmentFact: null,
      acceptedAt: new Date("2026-08-30T01:00:01Z"),
    });
    await events.startToolAttempt({
      id: randomUUID(),
      runId,
      toolCallId: "call-1",
      tool: {
        source: "runtime",
        sourceId: "runtime",
        name: "read",
        modelName: "read",
        description: "Read",
      },
      requestDigest: "a".repeat(64),
      createdAt: new Date("2026-08-30T01:00:02Z"),
    });
    await events.finishToolAttempt({
      id: randomUUID(),
      runId,
      toolCallId: "call-1",
      status: "completed",
      content: [{ type: "text", text: "data" }],
      resultSummary: [{ type: "text", text: "data" }],
      runtimeEffectState: "settled",
      createdAt: new Date("2026-08-30T01:00:03Z"),
    });
    await events.startToolAttempt({
      id: randomUUID(),
      runId,
      toolCallId: "call-2",
      tool: {
        source: "runtime",
        sourceId: "runtime",
        name: "write",
        modelName: "write",
        description: "Write",
      },
      requestDigest: "b".repeat(64),
      createdAt: new Date("2026-08-30T01:00:03Z"),
    });
    await events.interruptToolAttempts(runId, new Date("2026-08-30T01:00:04Z"));
    await events.appendAgentMessage({
      id: randomUUID(),
      runId,
      content: [{ type: "text", text: "done" }],
      createdAt: new Date("2026-08-30T01:00:04Z"),
    });

    const context = await contexts.load(sessionId);
    expect(context.messages.map((message) => message.kind)).toEqual([
      "user_message",
      "agent_message",
    ]);
    await contexts.saveCheckpoint({
      id: randomUUID(),
      sessionId,
      throughSequence: 1,
      summary: "inspect",
      tokenCount: 2,
      createdAt: new Date("2026-08-30T01:00:05Z"),
    });
    await executions.finish({
      runId,
      terminalClass: "completed",
      executorState: "quiescent",
      runtimeEffectState: "settled",
      finishedAt: new Date("2026-08-30T01:00:06Z"),
    });
    await executions.markAdmissionFinished(runId, new Date("2026-08-30T01:00:07Z"));

    await expect(executions.getState(runId)).resolves.toBe("completed");
    await expect(sessions.getCurrentRunState(sessionId)).resolves.toEqual({
      kind: "state",
      state: "idle",
      stopReason: "end_turn",
    });
    await expect(executions.listRecoveryWork()).resolves.not.toContainEqual(
      expect.objectContaining({ id: runId }),
    );
    const attempt = await pool.query<{ state: string; runtime_effect_state: string }>(
      `SELECT state, runtime_effect_state
         FROM tool_attempts
        WHERE run_id = $1
        ORDER BY tool_call_id`,
      [runId],
    );
    expect(attempt.rows).toEqual([
      { state: "completed", runtime_effect_state: "settled" },
      { state: "failed", runtime_effect_state: "unknown" },
    ]);
  });

  it("atomically cancels an admitting Run when its Session closes", async () => {
    const sessionId = randomUUID();
    const revisionId = randomUUID();
    const runId = randomUUID();
    await sessions.create({
      sessionId,
      binding: {
        connectionId: "connection-cancel",
        authenticatedSubject: "subject-cancel",
        principalId: "principal-cancel",
        agentId: "agent-cancel",
        accessRevision: "access-cancel",
      },
      cwd: "/workspace",
      mcpRevisionId: revisionId,
      mcpSources: [],
    });
    await runs.createRunIntent({
      runId,
      requestId: randomUUID(),
      sessionId,
      userMessageId: randomUUID(),
      prompt: [{ type: "text", text: "do not run" }],
      createdAt: new Date("2026-08-30T02:00:00Z"),
    });
    await sessions.close(sessionId, new Date("2026-08-30T02:00:01Z"));

    await expect(
      runs.acceptRun({
        runId,
        snapshot: snapshot(revisionId),
        environmentFact: null,
        acceptedAt: new Date("2026-08-30T02:00:02Z"),
      }),
    ).resolves.toBe("cancelled");

    const persisted = await pool.query<{
      state: string;
      cancel_requested_at: Date | null;
      admission_id: string | null;
    }>("SELECT state, cancel_requested_at, admission_id FROM runs WHERE id = $1", [runId]);
    expect(persisted.rows[0]?.state).toBe("cancelled");
    expect(persisted.rows[0]?.admission_id).not.toBeNull();
    expect(persisted.rows[0]?.cancel_requested_at).not.toBeNull();
    const messages = await pool.query("SELECT id FROM session_messages WHERE run_id = $1", [runId]);
    expect(messages.rowCount).toBe(0);
  });

  it("uses Session-before-Run lock ordering during admission acceptance", async () => {
    const sessionId = randomUUID();
    const revisionId = randomUUID();
    const runId = randomUUID();
    await sessions.create({
      sessionId,
      binding: {
        connectionId: "connection-lock-order",
        authenticatedSubject: "subject-lock-order",
        principalId: "principal-lock-order",
        agentId: "agent-lock-order",
        accessRevision: "access-lock-order",
      },
      cwd: "/workspace",
      mcpRevisionId: revisionId,
      mcpSources: [],
    });
    await runs.createRunIntent({
      runId,
      requestId: randomUUID(),
      sessionId,
      userMessageId: randomUUID(),
      prompt: [{ type: "text", text: "cancel while accepting" }],
      createdAt: new Date("2026-08-30T02:30:00Z"),
    });

    const blocker = await pool.connect();
    let accepting: Promise<"accepted" | "cancelled"> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SET LOCAL lock_timeout = '250ms'");
      await blocker.query("SELECT id FROM acp_sessions WHERE id = $1 FOR UPDATE", [sessionId]);
      accepting = runs.acceptRun({
        runId,
        snapshot: snapshot(revisionId),
        environmentFact: null,
        acceptedAt: new Date("2026-08-30T02:30:02Z"),
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 50));

      await blocker.query("UPDATE runs SET cancel_requested_at = $2 WHERE id = $1", [
        runId,
        new Date("2026-08-30T02:30:01Z"),
      ]);
      await blocker.query("COMMIT");

      await expect(accepting).resolves.toBe("cancelled");
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
      await accepting?.catch(() => undefined);
    }
  });

  it("allows at most one non-terminal Run per Session", async () => {
    const sessionId = randomUUID();
    const revisionId = randomUUID();
    await sessions.create({
      sessionId,
      binding: {
        connectionId: "connection-unique",
        authenticatedSubject: "subject-unique",
        principalId: "principal-unique",
        agentId: "agent-unique",
        accessRevision: "access-unique",
      },
      cwd: "/workspace",
      mcpRevisionId: revisionId,
      mcpSources: [],
    });
    const intent = (runId: string) =>
      runs.createRunIntent({
        runId,
        requestId: randomUUID(),
        sessionId,
        userMessageId: randomUUID(),
        prompt: [{ type: "text", text: runId }],
        createdAt: new Date("2026-08-30T03:00:00Z"),
      });

    await intent(randomUUID());
    await expect(intent(randomUUID())).rejects.toMatchObject({ code: "session_busy" });
  });
});

function snapshot(clientMcpRevisionId: string): RunExecutionSnapshot {
  return {
    admissionId: randomUUID(),
    admissionDeadline: new Date("2026-08-30T00:10:00Z"),
    agentConfigRevision: "config-2",
    executionRevision: "execution-2",
    runtimeMcpSourceDigest: "a".repeat(64),
    agentExecutionSpecDigest: "b".repeat(64),
    credentialVersion: "credential-version-1",
    runtime: {
      generation: 2,
      instanceId: "runtime-2",
      executionId: "runtime-execution-2",
      mcpEndpoint: "http://runtime-2:8080/mcp",
    },
    executionSpec: {
      systemPrompt: "system",
      skillInstructions: [],
      model: {
        adapter: "openai_compatible",
        baseUrl: "https://api.example.test/v1",
        model: "model",
        contextWindow: 32_000,
        maxOutputTokens: 2_048,
        supportsImages: false,
      },
      maxModelRequests: 8,
      credentialRef: "credential-1",
    },
    clientMcpRevisionId,
  };
}
