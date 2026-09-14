import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../../../src/adapters/postgres/migrate.js";
import { PostgresKernel } from "../../../src/adapters/postgres/kernel.js";
import { PostgresToolPermissions } from "../../../src/adapters/postgres/tool-permissions.js";
import { PostgresExecutionRepository } from "../../../src/adapters/postgres/execution-repository.js";
import { permissionRule } from "../../../src/domain/tool-permissions.js";
import type { PermissionRequest } from "../../../src/ports/tool-permissions.js";
import { snapshot } from "../../support/fixtures.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
const request: PermissionRequest = {
  runId: "r",
  sessionId: "s",
  call: { id: "call", name: "write", arguments: { content: "exact\u0000input" } },
  tool: {
    source: "runtime",
    sourceId: "runtime",
    name: "write",
    modelName: "write",
    description: "write",
  },
};
const allow = {
  request,
  result: { decision: "allow_always" as const, reason: "client_response" },
  rule: permissionRule(request.tool, "allow_always")!,
};

describe.skipIf(databaseUrl === undefined)("Postgres permission decisions", () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  const kernel = new PostgresKernel(pool);
  const permissions = new PostgresToolPermissions(kernel);
  const executions = new PostgresExecutionRepository(kernel);
  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await migrate(pool);
    await pool.query(`INSERT INTO acp_sessions(id,organization_id,principal_id,agent_id,cwd,state,created_at,updated_at)
      VALUES ('s','organization-1','p','a','/workspace','active',now(),now());
      INSERT INTO client_mcp_revisions(id,session_id,revision,encrypted_sources,nonce,created_at)
      VALUES ('m','s',1,'\\x00','\\x00',now());
      UPDATE acp_sessions SET client_mcp_revision_id='m' WHERE id='s'`);
    const snap = { ...snapshot(), deadlineAt: new Date(Date.now() + 60_000) };
    await pool.query(
      `INSERT INTO runs(id,request_id,session_id,client_mcp_revision_id,expected_access_revision,
      state,execution_snapshot,deadline_at,created_at,updated_at,input_prompt)
      VALUES ('r','req','s','m','access-1','running',$1::jsonb,$2,now(),now(),
        '[{"type":"text","text":"permission trigger"}]'::jsonb)`,
      [JSON.stringify(snap), snap.deadlineAt],
    );
  });
  afterAll(async () => {
    await pool.end();
  });

  it("binds exact arguments and merges rules without losing concurrent model/mode changes", async () => {
    expect(await permissions.open(request)).toEqual({
      organizationId: "organization-1",
      principalId: "p",
      agentId: "a",
      accessRevision: "access-1",
    });
    const altered = { ...request, call: { ...request.call, arguments: { content: "different" } } };
    expect(await permissions.decide({ ...allow, request: altered })).toBe(false);
    await pool.query(`UPDATE acp_sessions SET configuration = '{"modelProfileId":"new","authorizationMode":"chat"}'::jsonb,
      configuration_revision = 1 WHERE id = 's'`);
    expect(await permissions.decide(allow)).toBe(true);
    expect(
      (await pool.query("SELECT configuration, configuration_revision FROM acp_sessions")).rows,
    ).toEqual([
      {
        configuration: {
          modelProfileId: "new",
          authorizationMode: "chat",
          toolRules: [allow.rule],
        },
        configuration_revision: "2",
      },
    ]);
    expect(
      await permissions.decide({ ...allow, result: { decision: "reject_always", reason: "late" } }),
    ).toBe(false);
    expect((await pool.query("SELECT decision FROM tool_permissions")).rows).toEqual([
      { decision: "allow_always" },
    ]);
  });

  it("commits a duplicate response only once", async () => {
    await permissions.open(request);
    const results = await Promise.all([permissions.decide(allow), permissions.decide(allow)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(
      (
        await pool.query<{ configuration_revision: string }>(
          "SELECT configuration_revision FROM acp_sessions",
        )
      ).rows[0]?.configuration_revision,
    ).toBe("1");
  });

  it("cannot grant an expired or cancelled Run and writes no always rule", async () => {
    await permissions.open(request);
    await pool.query("UPDATE runs SET cancel_requested_at = now() WHERE id = 'r'");
    expect(await permissions.decide(allow)).toBe(false);
    expect((await pool.query("SELECT decision,reason FROM tool_permissions")).rows).toEqual([
      { decision: "cancelled", reason: "permission_stale" },
    ]);
    expect(
      (await pool.query<{ configuration: unknown }>("SELECT configuration FROM acp_sessions"))
        .rows[0]?.configuration,
    ).toEqual({});
    await expect(
      permissions.open({ ...request, call: { ...request.call, id: "next" } }),
    ).rejects.toMatchObject({ code: "permission_stale" });
  });

  it("finishes Runs and their orphan permission waits atomically", async () => {
    await permissions.open(request);
    await executions.finish({
      runId: "r",
      terminalClass: "cancelled",
      executorState: "quiescent",
      toolEffectState: "none",
      finishedAt: new Date(),
    });
    expect((await pool.query("SELECT decision,reason FROM tool_permissions")).rows).toEqual([
      { decision: "cancelled", reason: "run_finished" },
    ]);
    expect(await permissions.decide(allow)).toBe(false);
  });

  it("cannot save always after waiting for a Session lock beyond the actual deadline", async () => {
    await permissions.open(request);
    const holder = await pool.connect();
    const delayed = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM acp_sessions WHERE id='s' FOR UPDATE");
      await pool.query(
        "UPDATE runs SET deadline_at = clock_timestamp() + interval '150 milliseconds' WHERE id = 'r'",
      );
      const query = delayed.query(`BEGIN; SELECT id FROM acp_sessions WHERE id='s' FOR UPDATE`);
      // Use the repository transaction while another backend demonstrably holds the Session lock.
      const decision = permissions.decide(allow);
      await holder.query("SELECT pg_sleep(0.3)");
      await holder.query("ROLLBACK");
      await query;
      await delayed.query("ROLLBACK");
      expect(await decision).toBe(false);
      expect((await pool.query("SELECT decision,reason FROM tool_permissions")).rows).toEqual([
        { decision: "cancelled", reason: "permission_stale" },
      ]);
      expect(
        (await pool.query<{ configuration: unknown }>("SELECT configuration FROM acp_sessions"))
          .rows[0]?.configuration,
      ).toEqual({});
    } finally {
      await holder.query("ROLLBACK");
      await delayed.query("ROLLBACK");
      holder.release();
      delayed.release();
    }
  });

  it("startup cancels pending facts without reviving or erasing decided requests", async () => {
    await permissions.open(request);
    await permissions.decide(allow);
    await permissions.open({ ...request, call: { ...request.call, id: "second" } });
    await permissions.cancelAbandoned();
    await permissions.cancelAbandoned();
    expect(
      (await pool.query("SELECT decision FROM tool_permissions ORDER BY tool_call_id")).rows,
    ).toEqual([{ decision: "allow_always" }, { decision: "cancelled" }]);
    expect(
      (await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM tool_attempts")).rows[0]?.n,
    ).toBe(0);
  });

  it("rechecks cancellation after obtaining locks and never persists a late always rule", async () => {
    await permissions.open(request);
    const cancelled = new AbortController();
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM acp_sessions WHERE id='s' FOR UPDATE");
      const decision = permissions.decide({ ...allow, signal: cancelled.signal });
      await expect
        .poll(
          async () =>
            (
              await pool.query<{ n: number }>(
                "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
              )
            ).rows[0]?.n,
        )
        .toBe(1);
      cancelled.abort();
      await holder.query("ROLLBACK");
      expect(await decision).toBe(false);
      expect(
        (await pool.query<{ configuration: unknown }>("SELECT configuration FROM acp_sessions"))
          .rows[0]?.configuration,
      ).toEqual({});
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
  });
});
