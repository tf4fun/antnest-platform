import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresTemporarySkills } from "../../../../../services/agent-acp-service/src/adapters/postgres/temporary-skills.js";
import { PostgresKernel } from "../../../../../services/agent-acp-service/src/adapters/postgres/kernel.js";
import { PostgresRunRepository } from "../../../../../services/agent-acp-service/src/adapters/postgres/run-repository.js";
import { PostgresSessionRepository } from "../../../../../services/agent-acp-service/src/adapters/postgres/session-repository.js";
import { PostgresRunEventRepository } from "../../../../../services/agent-acp-service/src/adapters/postgres/run-event-repository.js";
import { PostgresExecutionRepository } from "../../../../../services/agent-acp-service/src/adapters/postgres/execution-repository.js";
import { SecretBox } from "../../../../../services/agent-acp-service/src/adapters/postgres/secret-box.js";
import { migrate } from "../../../../../services/agent-acp-service/src/adapters/postgres/migrate.js";
import { snapshot } from "../../../../../services/agent-acp-service/test/support/fixtures.js";
const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)(
  "durable temporary scopes and platform write recovery",
  () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 2 }),
      kernel = new PostgresKernel(pool),
      store = new PostgresTemporarySkills(kernel);
    const signal = new AbortController().signal;
    beforeAll(async () => {
      await pool.query("DROP SCHEMA public CASCADE");
      await pool.query("CREATE SCHEMA public");
      await migrate(pool);
    });
    afterAll(() => pool.end());
    async function input() {
      const runId = randomUUID(),
        sessionId = randomUUID(),
        revision = randomUUID();
      await new PostgresSessionRepository(
        kernel,
        new SecretBox(randomBytes(32)),
      ).create({
        sessionId,
        binding: {
          connectionId: randomUUID(),
          organizationId: "org_1",
          agentId: "agent_1",
          principalId: "user_1",
        },
        cwd: "/workspace",
        mcpRevisionId: revision,
        mcpSources: [],
      });
      const runs = new PostgresRunRepository(kernel);
      await runs.createRunIntent({
        runId,
        requestId: randomUUID(),
        sessionId,
        expectedAccessRevision: "access-1",
        userMessageId: randomUUID(),
        prompt: [{ type: "text", text: "Load a package" }],
        createdAt: new Date(),
      });
      const frozen = {
        ...snapshot(),
        runtime: { ...snapshot().runtime, revision: `rtv_${"a".repeat(32)}` },
        organizationId: "org_1",
        clientMcpRevisionId: revision,
      };
      await runs.acceptRun({
        runId,
        snapshot: frozen,
        environmentFact: null,
        acceptedAt: new Date(),
      });
      return { runId, snapshot: frozen, signal };
    }
    async function attempt(
      runId: string,
      name = "load_skill",
      effect = "none",
      state = "in_progress",
    ) {
      const id = randomUUID();
      await pool.query(
        "INSERT INTO tool_attempts(id,run_id,tool_call_id,source,source_id,tool_name,request_digest,state,tool_effect_state,created_at,updated_at,started_at,finished_at,result_summary) VALUES($1,$2,$1,'agent','skill_registry',$3,'digest',$4,$5,now(),now(),now(),CASE WHEN $4='in_progress' THEN NULL ELSE now() END,CASE WHEN $4='in_progress' THEN NULL ELSE '[]'::jsonb END)",
        [id, runId, name, state, effect],
      );
      return id;
    }
    it("freezes the real Run/Session binding and rejects substituted or released scopes", async () => {
      const value = await input(),
        scope = await store.reserve(value);
      expect(scope).toMatchObject({
        runId: value.runId,
        organizationId: "org_1",
        agentId: "agent_1",
        executionId: value.snapshot.runtime.executionId,
        mcpEndpoint: value.snapshot.runtime.mcpEndpoint,
        revision: value.snapshot.runtime.revision,
        connectionId: value.snapshot.runtime.connectionId,
      });
      expect(await store.reserve(value)).toEqual(scope);
      await expect(
        store.reserve({
          ...value,
          snapshot: { ...value.snapshot, organizationId: "other-org" },
        }),
      ).rejects.toThrow();
      await store.released(scope);
      expect(await store.forRun(value.runId, signal)).toBeNull();
      await expect(store.reserve(value)).rejects.toThrow();
    });
    it.each(["revision", "connectionId"] as const)(
      "rejects substituted %s before reserving or releasing a temporary scope",
      async (field) => {
        const value = await input();
        const changed = `${field === "revision" ? "rtv" : "rci"}_${"f".repeat(32)}`;
        await expect(
          store.reserve({
            ...value,
            snapshot: {
              ...value.snapshot,
              runtime: { ...value.snapshot.runtime, [field]: changed },
            },
          }),
        ).rejects.toThrow();
        expect(await store.forRun(value.runId, signal)).toBeNull();
        const original = await store.reserve(value);
        await expect(
          store.released({ ...original, [field]: changed }),
        ).rejects.toThrow();
        expect(await store.forRun(value.runId, signal)).toEqual(original);
        expect(
          await store.forAgent(
            {
              organizationId: original.organizationId,
              agentId: original.agentId,
            },
            signal,
          ),
        ).toContainEqual(original);
        await store.released(original);
      },
    );
    it("pending scopes fence the same Runtime but not another Agent or replacement revision", async () => {
      const value = await input(),
        scope = await store.reserve(value),
        protection = new PostgresExecutionRepository(kernel);
      expect(
        await protection.hasUnstoppedRuntimeCalls({
          organizationId: scope.organizationId,
          agentId: scope.agentId,
          runtimeRevision: value.snapshot.runtime.revision,
        }),
      ).toBe(true);
      expect(
        await protection.hasUnstoppedRuntimeCalls({
          organizationId: scope.organizationId,
          agentId: "other-agent",
          runtimeRevision: null,
        }),
      ).toBe(false);
      expect(
        await protection.hasUnstoppedRuntimeCalls({
          organizationId: scope.organizationId,
          agentId: scope.agentId,
          runtimeRevision: "new-revision",
        }),
      ).toBe(false);
      await store.released(scope);
    });
    it("closed cleanup marks only platform loads stopped and preserves historical uncertain effects", async () => {
      const value = await input(),
        scope = await store.reserve(value),
        id = await attempt(value.runId, "load_skill", "unknown", "failed");
      const builtin = randomUUID();
      await pool.query(
        "INSERT INTO tool_attempts(id,run_id,tool_call_id,source,source_id,tool_name,request_digest,state,tool_effect_state,created_at,updated_at,started_at,finished_at,result_summary) VALUES($1,$2,$1,'runtime','runtime','bash','digest','failed','unknown',now(),now(),now(),now(),'[]'::jsonb)",
        [builtin, value.runId],
      );
      await store.released(scope);
      await store.released(scope);
      const rows = (
        await pool.query<{
          id: string;
          tool_effect_state: string;
          runtime_call_stopped: boolean;
        }>(
          "SELECT id,tool_effect_state,runtime_call_stopped FROM tool_attempts WHERE id=ANY($1)",
          [[id, builtin]],
        )
      ).rows;
      expect(rows.find((row) => row.id === id)).toMatchObject({
        tool_effect_state: "unknown",
        runtime_call_stopped: true,
      });
      expect(rows.find((row) => row.id === builtin)).toMatchObject({
        runtime_call_stopped: false,
      });
    });
    it("does not use readonly recovery for a persisted pending install", async () => {
      const value = await input();
      await store.reserve(value);
      const id = await attempt(value.runId);
      expect(
        await new PostgresRunEventRepository(kernel).interruptToolAttempts(
          value.runId,
          new Date(),
        ),
      ).toEqual({
        toolEffectState: "unknown",
        unknownEffectSource: "runtime_mcp",
      });
      expect(
        (
          await pool.query(
            "SELECT tool_effect_state,runtime_call_stopped FROM tool_attempts WHERE id=$1",
            [id],
          )
        ).rows[0],
      ).toMatchObject({
        tool_effect_state: "unknown",
        runtime_call_stopped: false,
      });
    });
    it("an interrupted text-only load remains none; a proved released install is settled", async () => {
      const text = await input();
      await attempt(text.runId);
      expect(
        await new PostgresRunEventRepository(kernel).interruptToolAttempts(
          text.runId,
          new Date(),
        ),
      ).toEqual({ toolEffectState: "none" });
      const files = await input();
      const scope = await store.reserve(files);
      await attempt(files.runId);
      await store.released(scope);
      expect(
        await new PostgresRunEventRepository(kernel).interruptToolAttempts(
          files.runId,
          new Date(),
        ),
      ).toEqual({ toolEffectState: "settled" });
    });
    it("cleanup paging selects ended pending scopes and never an active foreground Run", async () => {
      const value = await input(),
        scope = await store.reserve(value);
      const scopes = await store.forAgent(
        { organizationId: "org_1", agentId: "agent_1" },
        signal,
      );
      expect(scopes).toContainEqual(scope);
      expect(
        await store.forAgent(
          { organizationId: "other-org", agentId: "agent_1" },
          signal,
        ),
      ).toEqual([]);
      const active = await input();
      await store.reserve(active);
      await new PostgresExecutionRepository(kernel).finish({
        runId: value.runId,
        terminalClass: "failed",
        executorState: "quiescent",
        toolEffectState: "none",
        errorClass: "fixture_failure",
        finishedAt: new Date(),
      });
      const rows = [];
      let cursor: null | string = null;
      for (;;) {
        const row = await store.next(cursor, signal);
        if (!row) break;
        rows.push(row);
        cursor = row.runId;
      }
      expect(rows).toContainEqual(scope);
      expect(rows.map((row) => row.runId)).not.toContain(active.runId);
    });
  },
);
