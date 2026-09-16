import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresKernel } from "../../../src/adapters/postgres/kernel.js";
import { migrate } from "../../../src/adapters/postgres/migrate.js";
import { SecretBox } from "../../../src/adapters/postgres/secret-box.js";
import { PostgresSessionRepository } from "../../../src/adapters/postgres/session-repository.js";
import { PostgresRunRepository } from "../../../src/adapters/postgres/run-repository.js";
import { PostgresToolPermissions } from "../../../src/adapters/postgres/tool-permissions.js";
import { PostgresRunEventRepository } from "../../../src/adapters/postgres/run-event-repository.js";
import { PostgresExecutionRepository } from "../../../src/adapters/postgres/execution-repository.js";
import { runSnapshot } from "../../../src/domain/run-snapshot.js";
import { publicExecutionConfiguration } from "../../../src/domain/execution-configuration.js";
import {
  executionConfiguration,
  executionIdentity,
} from "../../fixtures/execution-configuration.js";

const url = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
describe.skipIf(url === undefined)("local Run persistence", () => {
  const pool = new Pool({ connectionString: url, max: 2 });
  const kernel = new PostgresKernel(pool);
  const sessions = new PostgresSessionRepository(kernel, new SecretBox(randomBytes(32)));
  const runs = new PostgresRunRepository(kernel);
  const permissions = new PostgresToolPermissions(kernel);
  const events = new PostgresRunEventRepository(kernel);
  const executions = new PostgresExecutionRepository(kernel);
  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await migrate(pool);
  });
  afterAll(async () => {
    await pool.end();
  });

  async function accept() {
    const sessionId = randomUUID();
    const runId = randomUUID();
    const mcpRevisionId = randomUUID();
    await sessions.create({
      sessionId,
      binding: { connectionId: "connection-1", ...executionIdentity() },
      cwd: "/workspace",
      mcpRevisionId,
      mcpSources: [],
    });
    await runs.createRunIntent({
      runId,
      requestId: randomUUID(),
      sessionId,
      expectedAccessRevision: "access-1",
      userMessageId: randomUUID(),
      prompt: [{ type: "text", text: "hello" }],
      createdAt: new Date(),
    });
    const snapshot = runSnapshot({
      configuration: publicExecutionConfiguration(executionConfiguration()),
      identity: executionIdentity(),
      overrides: {},
      accessRevision: "access-1",
      clientMcpRevisionId: mcpRevisionId,
      deadlineAt: new Date(Date.now() + 60000),
    });
    expect(
      await runs.acceptRun({ runId, snapshot, environmentFact: null, acceptedAt: new Date() }),
    ).toBe("accepted");
    return { runId, sessionId, snapshot };
  }

  it("commits refusal isolation and checkpoint invalidation atomically with the terminal Run", async () => {
    const { runId, sessionId } = await accept();
    await pool.query(
      "INSERT INTO context_checkpoints(id,session_id,through_sequence,summary,token_count,created_at) VALUES ('checkpoint',$1,1,'refused prompt',1,now())",
      [sessionId],
    );
    await pool.query(`CREATE FUNCTION reject_exclusion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test refusal isolation failure'; END $$;
      CREATE TRIGGER reject_exclusion BEFORE UPDATE OF context_excluded ON session_messages FOR EACH ROW EXECUTE FUNCTION reject_exclusion()`);
    const input = {
      runId,
      terminalClass: "completed" as const,
      executorState: "quiescent" as const,
      toolEffectState: "none" as const,
      stopReason: "refusal" as const,
      finishedAt: new Date(),
    };
    await expect(executions.finish(input)).rejects.toThrow("test refusal isolation failure");
    expect(await executions.getState(runId)).toBe("running");
    expect(
      (
        await pool.query("SELECT context_excluded FROM session_messages WHERE session_id = $1", [
          sessionId,
        ])
      ).rows,
    ).toEqual([{ context_excluded: false }]);
    expect((await pool.query("SELECT id FROM context_checkpoints")).rows).toHaveLength(1);
    await pool.query("DROP TRIGGER reject_exclusion ON session_messages");
    await executions.finish(input);
    await executions.finish(input);
    expect(
      (
        await pool.query("SELECT context_excluded FROM session_messages WHERE session_id = $1", [
          sessionId,
        ])
      ).rows,
    ).toEqual([{ context_excluded: true }]);
    expect((await pool.query("SELECT id FROM context_checkpoints")).rows).toHaveLength(0);
  });

  it.each([true, false])(
    "persists Runtime stopping independently from unknown tool effects: %s",
    async (runtimeCallStopped) => {
      const { runId } = await accept();
      await events.startToolAttempt({
        id: randomUUID(),
        runId,
        toolCallId: "call-1",
        tool: {
          source: "runtime",
          sourceId: "runtime",
          name: "write",
          modelName: "write",
          description: "Write",
        },
        arguments: {},
        requestDigest: "digest",
        createdAt: new Date(),
      });
      expect(
        (
          await pool.query<{ runtime_call_stopped: boolean }>(
            "SELECT runtime_call_stopped FROM tool_attempts WHERE run_id = $1",
            [runId],
          )
        ).rows,
      ).toEqual([{ runtime_call_stopped: false }]);
      await events.finishToolAttempt({
        id: randomUUID(),
        runId,
        toolCallId: "call-1",
        status: "failed",
        content: [],
        resultSummary: [],
        toolEffectState: "unknown",
        runtimeCallStopped,
        createdAt: new Date(),
      });
      expect(
        (
          await pool.query<{ runtime_call_stopped: boolean; tool_effect_state: string }>(
            "SELECT runtime_call_stopped, tool_effect_state FROM tool_attempts WHERE run_id = $1",
            [runId],
          )
        ).rows,
      ).toEqual([{ runtime_call_stopped: runtimeCallStopped, tool_effect_state: "unknown" }]);
      const scope = {
        organizationId: "organization-1",
        agentId: "agent-1",
        runtimeRevision: "runtime-1",
      };
      expect(await executions.hasUnstoppedRuntimeCalls(scope)).toBe(!runtimeCallStopped);
      expect(await executions.hasUnstoppedRuntimeCalls({ ...scope, runtimeRevision: null })).toBe(
        !runtimeCallStopped,
      );
      const restartedReader = new PostgresExecutionRepository(kernel);
      expect(await restartedReader.hasUnstoppedRuntimeCalls(scope)).toBe(!runtimeCallStopped);
      for (const other of [
        { ...scope, organizationId: "organization-2" },
        { ...scope, agentId: "agent-2" },
        { ...scope, runtimeRevision: "runtime-replacement" },
      ]) {
        expect(await executions.hasUnstoppedRuntimeCalls(other)).toBe(false);
      }
    },
  );

  it("retains stopping uncertainty through interruption without treating an ended Run as proof", async () => {
    const { runId } = await accept();
    const scope = {
      organizationId: "organization-1",
      agentId: "agent-1",
      runtimeRevision: "runtime-1",
    };
    expect(await executions.hasUnstoppedRuntimeCalls(scope)).toBe(false);
    await events.startToolAttempt({
      id: randomUUID(),
      runId,
      toolCallId: "call-1",
      tool: {
        source: "runtime",
        sourceId: "runtime",
        name: "bash",
        modelName: "bash",
        description: "Bash",
      },
      arguments: {},
      requestDigest: "digest",
      createdAt: new Date(),
    });
    expect(await executions.hasUnstoppedRuntimeCalls(scope)).toBe(true);
    await events.interruptToolAttempts(runId, new Date());
    await executions.finish({
      runId,
      terminalClass: "unresolved",
      executorState: "quiescent",
      toolEffectState: "unknown",
      unknownEffectSource: "runtime_mcp",
      errorClass: "service_restarted_during_tool",
      finishedAt: new Date(),
    });
    expect(await executions.hasUnstoppedRuntimeCalls(scope)).toBe(true);
  });

  it("rolls back stopping proof when the terminal event cannot commit", async () => {
    const { runId } = await accept();
    const eventId = randomUUID();
    const scope = {
      organizationId: "organization-1",
      agentId: "agent-1",
      runtimeRevision: "runtime-1",
    };
    await events.startToolAttempt({
      id: eventId,
      runId,
      toolCallId: "call-1",
      tool: {
        source: "runtime",
        sourceId: "runtime",
        name: "write",
        modelName: "write",
        description: "Write",
      },
      arguments: {},
      requestDigest: "digest",
      createdAt: new Date(),
    });
    await expect(
      events.finishToolAttempt({
        id: eventId,
        runId,
        toolCallId: "call-1",
        status: "completed",
        content: [],
        resultSummary: [],
        toolEffectState: "settled",
        runtimeCallStopped: true,
        createdAt: new Date(),
      }),
    ).rejects.toMatchObject({ code: "23505" });
    expect(await executions.hasUnstoppedRuntimeCalls(scope)).toBe(true);
    expect(
      (
        await pool.query(
          "SELECT state, runtime_call_stopped FROM tool_attempts WHERE run_id = $1",
          [runId],
        )
      ).rows,
    ).toEqual([{ state: "in_progress", runtime_call_stopped: false }]);
  });

  it("stores local identity/configuration and deadline without a Controller admission column", async () => {
    const { runId, snapshot } = await accept();
    const { rows } = await pool.query(
      "SELECT state, deadline_at, execution_snapshot FROM runs WHERE id = $1",
      [runId],
    );
    expect(rows[0]).toMatchObject({
      state: "running",
      deadline_at: snapshot.deadlineAt,
      execution_snapshot: {
        organizationId: "organization-1",
        providerConnectionId: "provider-1",
        modelProfileId: "model-1",
      },
    });
    expect(JSON.stringify(rows)).not.toMatch(
      /admissionId|credentialRef|credentialVersion|synthetic-provider-key/u,
    );
    expect(
      (
        await pool.query(
          "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'runs' AND column_name = 'admission_id'",
        )
      ).rows,
    ).toEqual([]);
  });

  it("uses local deadline and immutable organization when deciding a tool approval", async () => {
    const { runId, sessionId } = await accept();
    const request = {
      runId,
      sessionId,
      call: { id: "tool-1", name: "read", arguments: {} },
      tool: {
        source: "runtime" as const,
        sourceId: "runtime-1",
        name: "read",
        modelName: "read",
        description: "Read",
      },
    };
    await expect(permissions.open(request)).resolves.toMatchObject(executionIdentity());
    await pool.query(
      "UPDATE runs SET deadline_at = clock_timestamp() - interval '1 second' WHERE id = $1",
      [runId],
    );
    expect(
      await permissions.decide({
        request,
        result: { decision: "allow_once", reason: "client_response" },
      }),
    ).toBe(false);
    expect(
      (await pool.query("SELECT decision, reason FROM tool_permissions WHERE run_id = $1", [runId]))
        .rows,
    ).toEqual([{ decision: "cancelled", reason: "permission_stale" }]);
  });
});
