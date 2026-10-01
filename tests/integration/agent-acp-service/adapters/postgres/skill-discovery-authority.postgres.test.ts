import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresSkillDiscoveryAuthority } from "../../../../../services/agent-acp-service/src/adapters/postgres/skill-discovery-authority.js";
import { PostgresKernel } from "../../../../../services/agent-acp-service/src/adapters/postgres/kernel.js";
import { migrate } from "../../../../../services/agent-acp-service/src/adapters/postgres/migrate.js";
import { PostgresRunRepository } from "../../../../../services/agent-acp-service/src/adapters/postgres/run-repository.js";
import { PostgresSessionRepository } from "../../../../../services/agent-acp-service/src/adapters/postgres/session-repository.js";
import { SecretBox } from "../../../../../services/agent-acp-service/src/adapters/postgres/secret-box.js";
import { skillDiscoveryTools } from "../../../../../services/agent-acp-service/src/domain/skill-discovery.js";
import { executionConfiguration } from "../../../../../services/agent-acp-service/test/fixtures/execution-configuration.js";
import { snapshot } from "../../../../../services/agent-acp-service/test/support/fixtures.js";
import type { ToolCallInput } from "../../../../../services/agent-acp-service/src/ports/tools.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
describe.skipIf(databaseUrl === undefined)(
  "persisted Skill discovery authority and request budgets",
  () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 2 });
    const kernel = new PostgresKernel(pool);
    const config = executionConfiguration();
    const organizationId = `org_${"1".repeat(32)}`;
    const principalId = `user_${"2".repeat(32)}`;
    const agentId = `agent_${"3".repeat(32)}`;
    config.organization_id = organizationId;
    const agent = config.agents[0]!;
    agent.agent_id = agentId;
    agent.principal_ids = [principalId];
    const authority = new PostgresSkillDiscoveryAuthority(kernel, {
      inspect: () => ({ agent, configuration: config }),
    });
    beforeAll(async () => {
      await pool.query("DROP SCHEMA public CASCADE");
      await pool.query("CREATE SCHEMA public");
      await migrate(pool);
    });
    afterAll(async () => {
      await pool.end();
    });
    async function input(name = "find_skill"): Promise<ToolCallInput> {
      const sessionId = randomUUID(),
        runId = randomUUID(),
        revisionId = randomUUID();
      const identity = {
        organizationId,
        principalId,
        agentId,
        connectionId: randomUUID(),
      };
      await new PostgresSessionRepository(
        kernel,
        new SecretBox(randomBytes(32)),
      ).create({
        sessionId,
        binding: identity,
        cwd: "/workspace",
        mcpRevisionId: revisionId,
        mcpSources: [],
      });
      const runs = new PostgresRunRepository(kernel);
      await runs.createRunIntent({
        runId,
        requestId: randomUUID(),
        sessionId,
        expectedAccessRevision: "access-1",
        userMessageId: randomUUID(),
        prompt: [{ type: "text", text: "Find a Skill" }],
        createdAt: new Date(),
      });
      const frozen = {
        ...snapshot(),
        organizationId,
        clientMcpRevisionId: revisionId,
      };
      await runs.acceptRun({
        runId,
        snapshot: frozen,
        environmentFact: null,
        acceptedAt: new Date(),
      });
      return {
        runId,
        snapshot: frozen,
        tool: skillDiscoveryTools.find((tool) => tool.name === name)!,
        arguments: {},
        signal: new AbortController().signal,
      };
    }
    it("derives the real actor/Agent from an active matching Run", async () => {
      const value = await input();
      expect(await authority.authorize(value)).toEqual({
        organizationId,
        principalId,
        agentId,
      });
      await expect(
        authority.authorize({
          ...value,
          snapshot: {
            ...value.snapshot,
            organizationId: `org_${"f".repeat(32)}`,
          },
        }),
      ).rejects.toMatchObject({ code: "not_found" });
      await expect(
        authority.authorize({
          ...value,
          snapshot: {
            ...value.snapshot,
            runtime: {
              ...value.snapshot.runtime,
              executionId: "other-execution",
            },
          },
        }),
      ).rejects.toMatchObject({ code: "not_found" });
      await pool.query(
        "UPDATE runs SET state='failed', terminal_class='failed', executor_state='quiescent', tool_effect_state='none', error_class='test' WHERE id=$1",
        [value.runId],
      );
      await expect(authority.authorize(value)).rejects.toMatchObject({
        code: "not_found",
      });
    });
    it.each([
      ["find_skill", 8],
      ["load_skill", 4],
    ] as const)("enforces the durable %s budget of %s", async (name, limit) => {
      const value = await input(name);
      for (let i = 0; i < limit; i += 1) {
        await pool.query(
          "INSERT INTO tool_attempts(id,run_id,tool_call_id,source,source_id,tool_name,request_digest,state,tool_effect_state,created_at,updated_at,started_at,finished_at,result_summary) VALUES($1,$2,$1,'agent','skill_registry',$3,'digest','failed','none',now(),now(),now(),now(),'[]'::jsonb)",
          [randomUUID(), value.runId, name],
        );
      }
      expect(await authority.authorize(value)).toMatchObject({ principalId });
      await pool.query(
        "INSERT INTO tool_attempts(id,run_id,tool_call_id,source,source_id,tool_name,request_digest,state,tool_effect_state,created_at,updated_at,started_at) VALUES($1,$2,$1,'agent','skill_registry',$3,'digest','in_progress','none',now(),now(),now())",
        [randomUUID(), value.runId, name],
      );
      await expect(authority.authorize(value)).rejects.toMatchObject({
        code: "discovery_budget_exceeded",
      });
    });
    it("checks current access and execution after reading the durable owner", async () => {
      const value = await input();
      const original = agent.runtime;
      try {
        agent.runtime = null;
        await expect(authority.authorize(value)).rejects.toMatchObject({
          code: "not_found",
        });
      } finally {
        agent.runtime = original;
      }
    });
  },
);
