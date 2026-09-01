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
        agentAccessSubject: "subject-1",
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
        agentAccessSubject: "subject-1",
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
      expectedAccessRevision: "access-1",
      userMessageId: randomUUID(),
      prompt: [{ type: "text", text: "hello" }],
      createdAt: new Date("2026-08-30T00:00:00Z"),
    });

    await expect(
      runs.acceptRun({
        runId,
        snapshot: snapshot(revisionId),
        sessionTitle: "hello",
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
      title: "hello",
      lastExecutionRevision: "execution-2",
      lastMessageSequence: 2,
    });
    await expect(sessions.getCurrentRunState(sessionId)).resolves.toEqual({
      kind: "state",
      state: "running",
    });
  });

  it("forks a settled Session context without copying Run ownership", async () => {
    const sourceSessionId = randomUUID();
    const sourceMcpRevisionId = randomUUID();
    const runId = randomUUID();
    await sessions.create({
      sessionId: sourceSessionId,
      binding: {
        connectionId: "connection-fork",
        agentAccessSubject: "subject-fork",
        principalId: "principal-fork",
        agentId: "agent-fork",
        accessRevision: "access-fork",
      },
      cwd: "/workspace",
      mcpRevisionId: sourceMcpRevisionId,
      mcpSources: [],
    });
    await runs.createRunIntent({
      runId,
      requestId: randomUUID(),
      sessionId: sourceSessionId,
      expectedAccessRevision: "access-fork",
      userMessageId: randomUUID(),
      prompt: [{ type: "text", text: "remember this" }],
      createdAt: new Date("2026-08-30T00:20:00Z"),
    });
    await runs.acceptRun({
      runId,
      snapshot: snapshot(sourceMcpRevisionId),
      environmentFact: null,
      sessionTitle: "remember this",
      acceptedAt: new Date("2026-08-30T00:20:01Z"),
    });
    await events.appendAgentMessage({
      id: randomUUID(),
      runId,
      content: [{ type: "text", text: "remembered" }],
      createdAt: new Date("2026-08-30T00:20:02Z"),
    });
    await expect(
      sessions.fork({
        sourceSessionId,
        sessionId: randomUUID(),
        mcpRevisionId: randomUUID(),
        mcpSources: [],
        createdAt: new Date("2026-08-30T00:20:02Z"),
      }),
    ).rejects.toMatchObject({ code: "session_busy" });
    await executions.finish({
      runId,
      terminalClass: "completed",
      executorState: "quiescent",
      toolEffectState: "none",
      stopReason: "end_turn",
      finishedAt: new Date("2026-08-30T00:20:03Z"),
    });
    await executions.markAdmissionFinished(runId, new Date("2026-08-30T00:20:04Z"));

    const forkSessionId = randomUUID();
    const forkMcpRevisionId = randomUUID();
    await sessions.fork({
      sourceSessionId,
      sessionId: forkSessionId,
      mcpRevisionId: forkMcpRevisionId,
      mcpSources: [],
      createdAt: new Date("2026-08-30T00:20:05Z"),
    });

    await expect(sessions.get(forkSessionId)).resolves.toMatchObject({
      principalId: "principal-fork",
      agentId: "agent-fork",
      state: "active",
      title: "remember this",
      forkedFromSessionId: sourceSessionId,
      lastMessageSequence: 2,
    });
    await expect(sessions.replay(forkSessionId)).resolves.toMatchObject([
      { kind: "user_message", content: [{ type: "text", text: "remember this" }] },
      { kind: "agent_message", content: [{ type: "text", text: "remembered" }] },
    ]);
    const copiedRunReferences = await pool.query(
      "SELECT id FROM session_messages WHERE session_id = $1 AND run_id IS NOT NULL",
      [forkSessionId],
    );
    expect(copiedRunReferences.rowCount).toBe(0);
  });

  it("persists replay events, context checkpoints, Tool attempts, and terminal Run facts", async () => {
    const sessionId = randomUUID();
    const revisionId = randomUUID();
    const runId = randomUUID();
    await sessions.create({
      sessionId,
      binding: {
        connectionId: "connection-2",
        agentAccessSubject: "subject-2",
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
      expectedAccessRevision: "access-2",
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
    await events.appendAgentMessage({
      id: randomUUID(),
      runId,
      content: [{ type: "text", text: "I will inspect and update the files." }],
      toolCalls: [
        { id: "call-1", name: "read", arguments: { path: "README.md" } },
        {
          id: "call-2",
          name: "write",
          arguments: { path: "result.txt", text: "data" },
        },
        { id: "call-3", name: "bash", arguments: { command: "pwd" } },
      ],
      createdAt: new Date("2026-08-30T01:00:01Z"),
    });
    await events.startToolAttempt({
      id: randomUUID(),
      runId,
      toolCallId: "call-1",
      tool: {
        source: "client",
        sourceId: "client-mcp-1",
        name: "read",
        modelName: "read",
        description: "Read",
      },
      arguments: { path: "README.md" },
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
      toolEffectState: "unknown",
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
      arguments: { path: "result.txt", text: "data" },
      requestDigest: "b".repeat(64),
      createdAt: new Date("2026-08-30T01:00:03Z"),
    });
    await expect(
      events.interruptToolAttempts(runId, new Date("2026-08-30T01:00:04Z")),
    ).resolves.toEqual({
      toolEffectState: "unknown",
      unknownEffectSource: "unclassified",
    });
    await events.appendAgentMessage({
      id: randomUUID(),
      runId,
      content: [{ type: "text", text: "done" }],
      createdAt: new Date("2026-08-30T01:00:04Z"),
    });

    const context = await contexts.load(sessionId);
    expect(context.messages.map((message) => message.kind)).toEqual([
      "user_message",
      "tool_exchange",
      "agent_message",
    ]);
    expect(context.messages[1]).toMatchObject({
      kind: "tool_exchange",
      assistant: {
        content: [{ type: "text", text: "I will inspect and update the files." }],
        toolCalls: [
          { id: "call-1", name: "read", arguments: { path: "README.md" } },
          {
            id: "call-2",
            name: "write",
            arguments: { path: "result.txt", text: "data" },
          },
          { id: "call-3", name: "bash", arguments: { command: "pwd" } },
        ],
      },
      results: [
        { toolCallId: "call-1", content: [{ type: "text", text: "data" }] },
        {
          toolCallId: "call-2",
          content: [
            {
              type: "text",
              text: "Tool outcome is unknown because Agent ACP Service restarted.",
            },
          ],
        },
        {
          toolCallId: "call-3",
          content: [
            {
              type: "text",
              text: "Tool was not executed because Agent ACP Service restarted before dispatch.",
            },
          ],
        },
      ],
    });
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
      toolEffectState: "settled",
      stopReason: "refusal",
      finishedAt: new Date("2026-08-30T01:00:06Z"),
    });
    await expect(
      executions.finish({
        runId,
        terminalClass: "completed",
        executorState: "quiescent",
        toolEffectState: "settled",
        stopReason: "refusal",
        finishedAt: new Date("2026-08-30T01:00:06Z"),
      }),
    ).resolves.toBeUndefined();
    await expect(
      executions.finish({
        runId,
        terminalClass: "completed",
        executorState: "quiescent",
        toolEffectState: "settled",
        stopReason: "end_turn",
        finishedAt: new Date("2026-08-30T01:00:06Z"),
      }),
    ).rejects.toThrow("Run cannot enter the requested terminal state");
    await executions.markAdmissionFinished(runId, new Date("2026-08-30T01:00:07Z"));

    await expect(executions.getState(runId)).resolves.toBe("completed");
    await expect(sessions.getCurrentRunState(sessionId)).resolves.toEqual({
      kind: "state",
      state: "idle",
      stopReason: "refusal",
    });
    await expect(executions.listRecoveryWork()).resolves.not.toContainEqual(
      expect.objectContaining({ id: runId }),
    );
    const attempt = await pool.query<{ state: string; tool_effect_state: string }>(
      `SELECT state, tool_effect_state
         FROM tool_attempts
        WHERE run_id = $1
        ORDER BY tool_call_id`,
      [runId],
    );
    expect(attempt.rows).toEqual([
      { state: "completed", tool_effect_state: "unknown" },
      { state: "failed", tool_effect_state: "unknown" },
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
        agentAccessSubject: "subject-cancel",
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
      expectedAccessRevision: "access-cancel",
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
      error_class: string | null;
    }>("SELECT state, cancel_requested_at, admission_id, error_class FROM runs WHERE id = $1", [
      runId,
    ]);
    expect(persisted.rows[0]?.state).toBe("cancelled");
    expect(persisted.rows[0]?.admission_id).not.toBeNull();
    expect(persisted.rows[0]?.cancel_requested_at).not.toBeNull();
    expect(persisted.rows[0]?.error_class).toBeNull();
    const messages = await pool.query("SELECT id FROM session_messages WHERE run_id = $1", [runId]);
    expect(messages.rowCount).toBe(0);
  });

  it("persists an unresolved Run only after the executor is quiescent", async () => {
    const sessionId = randomUUID();
    const revisionId = randomUUID();
    const runId = randomUUID();
    await sessions.create({
      sessionId,
      binding: {
        connectionId: "connection-unresolved",
        agentAccessSubject: "subject-unresolved",
        principalId: "principal-unresolved",
        agentId: "agent-unresolved",
        accessRevision: "access-unresolved",
      },
      cwd: "/workspace",
      mcpRevisionId: revisionId,
      mcpSources: [],
    });
    await runs.createRunIntent({
      runId,
      requestId: randomUUID(),
      sessionId,
      expectedAccessRevision: "access-unresolved",
      userMessageId: randomUUID(),
      prompt: [{ type: "text", text: "perform one Tool call" }],
      createdAt: new Date("2026-08-30T02:15:00Z"),
    });
    await runs.acceptRun({
      runId,
      snapshot: snapshot(revisionId),
      environmentFact: null,
      acceptedAt: new Date("2026-08-30T02:15:01Z"),
    });

    await expect(
      executions.finish({
        runId,
        terminalClass: "unresolved",
        executorState: "quiescent",
        toolEffectState: "unknown",
        unknownEffectSource: "runtime_mcp",
        errorClass: "runtime_tool_effect_unknown",
        finishedAt: new Date("2026-08-30T02:15:02Z"),
      }),
    ).resolves.toBeUndefined();

    const persisted = await pool.query<{
      state: string;
      executor_state: string;
      tool_effect_state: string;
      unknown_effect_source: string;
      error_class: string;
    }>(
      `SELECT state, executor_state, tool_effect_state, unknown_effect_source, error_class
         FROM runs WHERE id = $1`,
      [runId],
    );
    expect(persisted.rows[0]).toEqual({
      state: "unresolved",
      executor_state: "quiescent",
      tool_effect_state: "unknown",
      unknown_effect_source: "runtime_mcp",
      error_class: "runtime_tool_effect_unknown",
    });
  });

  it("uses Session-before-Run lock ordering during admission acceptance", async () => {
    const sessionId = randomUUID();
    const revisionId = randomUUID();
    const runId = randomUUID();
    await sessions.create({
      sessionId,
      binding: {
        connectionId: "connection-lock-order",
        agentAccessSubject: "subject-lock-order",
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
      expectedAccessRevision: "access-lock-order",
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
        agentAccessSubject: "subject-unique",
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
        expectedAccessRevision: "access-unique",
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
    agentSpecRevision: "config-2",
    executionRevision: "execution-2",
    runtimeMcpSourceDigest: "a".repeat(64),
    agentExecutionSpecDigest: "b".repeat(64),
    credentialVersion: "credential-version-1",
    runtime: {
      revision: "runtime-2",
      executionId: "runtime-execution-2",
      mcpEndpoint: "http://runtime-2:8080/mcp",
    },
    executionSpec: {
      systemPrompt: "system",
      contextPolicyVersion: "context-v1",
      skillInstructions: [],
      model: {
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
