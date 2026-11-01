import { randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresContentPurge } from "../../../../../services/agent-acp-service/src/adapters/postgres/content-purge.js";
import { PostgresKernel } from "../../../../../services/agent-acp-service/src/adapters/postgres/kernel.js";
import { PostgresAgentLeases } from "../../../../../services/agent-acp-service/src/adapters/postgres/agent-leases.js";
import { PostgresWorkerLock } from "../../../../../services/agent-acp-service/src/adapters/postgres/worker-lock.js";
import { RunWriteAuthority } from "../../../../../services/agent-acp-service/src/adapters/postgres/run-write-authority.js";
import { SecretBox } from "../../../../../services/agent-acp-service/src/adapters/postgres/secret-box.js";
import { createLegacySessionRepository } from "../../../../../services/agent-acp-service/src/adapters/postgres/session-repository.js";
import { PostgresSkillSourceProjections } from "../../../../../services/agent-acp-service/src/adapters/postgres/skill-source-projections.js";
import { migrate } from "../../../../../services/agent-acp-service/src/adapters/postgres/migrate.js";
import { AgentOwnershipLostError } from "../../../../../services/agent-acp-service/src/domain/agent-ownership.js";
import { buildLearningCandidatePackage } from "../../../../../services/agent-acp-service/src/domain/learning-candidate-package.js";
import type { TelemetryPort } from "../../../../../services/agent-acp-service/src/ports/telemetry.js";

const url = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
const HEX = "a".repeat(64);
const COUNT_KEYS = [
  "sessions",
  "runs",
  "messages",
  "toolAttempts",
  "learningTasks",
  "evidenceItems",
  "evidenceSnapshots",
  "candidates",
  "publishedCandidates",
  "learningChanges",
];
const BUDGET_TABLES = [
  "model_budget_history",
  "model_budget_reservations",
  "model_budget_baseline_attempts",
  "model_budget_baseline_receipts",
  "organization_spend",
  "run_usage",
];

describe.skipIf(url === undefined)("PostgreSQL content purge", () => {
  const pool = new Pool({ connectionString: url, max: 4 });
  const kernel = new PostgresKernel(pool);
  const signal = new AbortController().signal;
  const sessions = createLegacySessionRepository(
    kernel,
    new SecretBox(randomBytes(32)),
    new AbortController().signal,
  );
  const projections = new PostgresSkillSourceProjections(kernel);
  const events: string[] = [];
  const telemetry: TelemetryPort = {
    span: (_n, _a, op) => op(),
    count: () => undefined,
    duration: () => undefined,
    log: (_level, event, attributes) => {
      events.push(`${event}:${JSON.stringify(attributes)}`);
    },
  };
  const purge = () =>
    new PostgresContentPurge(
      kernel,
      RunWriteAuthority.legacy(signal),
      telemetry,
    );

  beforeEach(async () => {
    events.length = 0;
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await migrate(pool);
  });
  afterAll(() => pool.end());

  async function seedSession(
    id: string,
    options: {
      organization?: string;
      principal?: string;
      agent?: string;
      state?: "active" | "closed" | "deleted";
      deletedAt?: string | Date | null;
      forkedFrom?: string;
    } = {},
  ) {
    const organization = options.organization ?? "org-1";
    const agent = options.agent ?? "agent-1";
    await pool.query(
      `INSERT INTO acp_sessions(id,organization_id,principal_id,agent_id,cwd,state,
        forked_from_session_id,client_mcp_revision_id,deleted_at,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'/workspace',$5,$6,NULL,$7,now(),now())`,
      [
        id,
        organization,
        options.principal ?? "user-1",
        agent,
        options.state ?? "active",
        options.forkedFrom ?? null,
        options.state === "deleted" ? (options.deletedAt ?? new Date(0)) : null,
      ],
    );
    await pool.query(
      `INSERT INTO client_mcp_revisions(id,session_id,revision,encrypted_sources,nonce,created_at)
       VALUES ($1,$2,1,'\\x00','\\x00',now())`,
      [`mcp-${id}`, id],
    );
    await pool.query(
      "UPDATE acp_sessions SET client_mcp_revision_id=$2 WHERE id=$1",
      [id, `mcp-${id}`],
    );
  }

  async function seedRun(
    id: string,
    sessionId: string,
    options: {
      state?: string;
      executor?: string | null;
      effect?: string | null;
    } = {},
  ) {
    const state = options.state ?? "completed";
    const terminal =
      state === "running" || state === "admitting"
        ? { terminal: null, executor: null, effect: null, stop: null }
        : state === "unresolved"
          ? {
              terminal: "unresolved",
              executor: options.executor ?? "quiescent",
              effect: options.effect ?? "unknown",
              stop: null,
            }
          : state === "failed"
            ? {
                terminal: "failed",
                executor: options.executor ?? "quiescent",
                effect: options.effect ?? "settled",
                stop: null,
              }
            : {
                terminal: state,
                executor: options.executor ?? "quiescent",
                effect: options.effect ?? "settled",
                stop: state === "completed" ? "end_turn" : null,
              };
    const snapshot = state === "admitting" ? null : "{}";
    const session = await pool.query<{
      organization_id: string;
      agent_id: string;
    }>("SELECT organization_id,agent_id FROM acp_sessions WHERE id=$1", [
      sessionId,
    ]);
    await pool.query(
      `INSERT INTO runs(id,request_id,session_id,client_mcp_revision_id,expected_access_revision,
        state,pending_user_message_id,input_prompt,deadline_at,execution_snapshot,terminal_class,executor_state,
        tool_effect_state,stop_reason,error_class,created_at,updated_at,organization_id,agent_id,unknown_effect_source)
       VALUES ($1,$2,$3,$4,'access-1',$5,$15,'[]'::jsonb,$6,$7::jsonb,$8,$9,$10,$11,$12,now(),now(),$13,$14,CASE WHEN $5='unresolved' THEN 'unclassified' END)`,
      [
        id,
        `request-${id}`,
        sessionId,
        `mcp-${sessionId}`,
        state,
        snapshot === null ? null : new Date(Date.now() + 60_000),
        snapshot,
        terminal.terminal,
        terminal.executor,
        terminal.effect,
        terminal.stop,
        state === "failed" || state === "unresolved" ? "error" : null,
        session.rows[0]!.organization_id,
        session.rows[0]!.agent_id,
        state === "admitting" ? `msg-${id}` : null,
      ],
    );
  }

  async function seedContent(sessionId: string, runId: string) {
    await pool.query(
      `INSERT INTO session_messages(id,session_id,run_id,sequence,kind,visible,payload,created_at)
       VALUES ($1,$2,$3,1,'user_message',true,'{"text":"body"}'::jsonb,now())`,
      [`msg-${sessionId}`, sessionId, runId],
    );
    await pool.query(
      `INSERT INTO context_checkpoints(id,session_id,through_sequence,summary,token_count,created_at)
       VALUES ($1,$2,0,'summary',1,now())`,
      [`ctx-${sessionId}`, sessionId],
    );
    await pool.query(
      `INSERT INTO tool_attempts(id,run_id,tool_call_id,source,source_id,tool_name,request_digest,
        state,tool_effect_state,result_summary,started_at,finished_at,runtime_call_stopped,
        created_at,updated_at)
       VALUES ($1,$2,'call-1','runtime','runtime','bash','digest','completed','settled',
        '[]'::jsonb,now(),now(),true,now(),now())`,
      [`attempt-${runId}`, runId],
    );
  }

  async function seedLearning(
    taskId: string,
    runId: string,
    options: {
      taskState?: string;
      intentState?: string;
      callState?: string;
    } = {},
  ) {
    const run = await pool.query<{
      session_id: string;
      organization_id: string;
      agent_id: string;
    }>(
      `SELECT r.session_id,r.organization_id,r.agent_id FROM runs r WHERE r.id=$1`,
      [runId],
    );
    const { organization_id: org, agent_id: agent } = run.rows[0]!;
    const taskState = options.taskState ?? "completed";
    await pool.query(
      `INSERT INTO learning_tasks(id,organization_id,agent_id,owner_principal_id,source_run_id,
        trigger_kind,policy_revision,frozen_policy,review_prompt_version,package_rules_version,state)
       VALUES ($1,$2,$3,'owner-1',$4,'run_completed',$5,'{}'::jsonb,1,1,$6)`,
      [
        taskId,
        org,
        agent,
        runId,
        HEX,
        taskState === "running" ? "completed" : taskState,
      ],
    );
    await pool.query(
      `INSERT INTO learning_evidence_snapshots(task_id,source_run_id,claim_id,generation,digest,truncated)
       VALUES ($1,$2,'claim-1',1,$3,false)`,
      [taskId, runId, HEX],
    );
    await pool.query(
      `INSERT INTO learning_evidence_items(task_id,ordinal,evidence_id,source_id,kind,scope,text)
       VALUES ($1,0,$2,'user-1','authenticated_user','user_prompt','Inspect first')`,
      [taskId, `evidence_${"e".repeat(32)}`],
    );
    await pool.query(
      `INSERT INTO learning_model_calls(task_id,call_index,request_id,claim_id,generation,
        reserved_input_tokens,reserved_output_tokens,reserved_duration_ms,state,
        actual_input_tokens,actual_output_tokens,actual_duration_ms,review_decision,settled_at)
       VALUES ($1,1,'review-1','claim-1',1,100,100,1000,$2,
        CASE WHEN $2='settled' THEN 10 END,
        CASE WHEN $2='settled' THEN 10 END,
        CASE WHEN $2='settled' THEN 100 END,
        CASE WHEN $2='settled' THEN '{"decision":"skip","reason":"none"}'::jsonb END,
        CASE WHEN $2='settled' THEN now() END)`,
      [taskId, options.callState ?? "settled"],
    );
    await pool.query(
      `INSERT INTO learning_review_attempts(task_id,generation,started_at) VALUES ($1,1,now())`,
      [taskId],
    );
    await pool.query(
      `INSERT INTO learning_source_decisions(run_id,organization_id,agent_id,owner_principal_id,
        policy_revision,disposition,task_id)
       VALUES ($1,$2,$3,'owner-1',$4,'queued',$5)`,
      [runId, org, agent, HEX, taskId],
    );
    await pool.query(
      `INSERT INTO learning_maintenance_intents(request_id,task_id,claim_id,generation,action,
        execution_id,mcp_endpoint,body_sha256,request_facts,state,receipt,settled_at)
       VALUES ($1,$2,'claim-1',1,'commit','execution-1','http://runtime:8093/mcp',
        'sha256:${"b".repeat(64)}','{}'::jsonb,$3,$4::jsonb,
        CASE WHEN $3='settled' THEN now() END)`,
      [
        `intent-${taskId}`,
        taskId,
        options.intentState ?? "settled",
        (options.intentState ?? "settled") === "settled" ? "{}" : null,
      ],
    );
  }

  const evidenceId = `evidence_${"e".repeat(32)}`;
  const packageFixture = () =>
    buildLearningCandidatePackage(
      {
        decision: "propose",
        name: "inspect-first",
        description: "Inspect first.",
        instructions: "unused",
        rules: [{ text: "Inspect first", evidenceIds: [evidenceId] }],
      },
      {
        sourceRunId: "run-1",
        truncated: false,
        items: [
          {
            evidenceId,
            sourceId: "user-1",
            kind: "authenticated_user",
            scope: "user_prompt",
            text: "Inspect first",
          },
        ],
      },
    );

  async function seedPublished(
    taskId: string,
    sessionId: string,
    runId: string,
  ) {
    const session = await pool.query<{
      organization_id: string;
      agent_id: string;
      principal_id: string;
    }>(
      "SELECT organization_id,agent_id,principal_id FROM acp_sessions WHERE id=$1",
      [sessionId],
    );
    const { organization_id: org, agent_id: agent } = session.rows[0]!;
    const pkg = packageFixture();
    await seedLearning(taskId, runId);
    await pool.query(
      `INSERT INTO learning_candidates(candidate_id,task_id,claim_id,generation,package_path,
        expected_base_digest,target_digest,artifact_digest,package_rules_version,skill_text,
        artifact,evidence_ids,state)
       VALUES ('candidate-1',$1,'claim-1',1,$2,NULL,$3,$4,1,$5,$6,$7,'applied')`,
      [
        taskId,
        pkg.packagePath,
        pkg.targetDigest,
        pkg.artifactDigest,
        pkg.skillText,
        pkg.artifact,
        [evidenceId],
      ],
    );
    await pool.query(
      `INSERT INTO learning_changes(change_id,organization_id,agent_id,owner_principal_id,sequence,
        kind,source_run_id,source_session_id,task_id,candidate_id,effect_request_id,package_path,
        after_digest,policy_revision,apply_basis)
       VALUES ($1,$2,$3,'owner-1',1,'applied',$4,$5,$6,'candidate-1',$7,$8,$9,$10,'policy')`,
      [
        `change-${taskId}`,
        org,
        agent,
        runId,
        sessionId,
        taskId,
        `intent-${taskId}`,
        pkg.packagePath,
        pkg.targetDigest,
        HEX,
      ],
    );
    await pool.query(
      `INSERT INTO learning_managed_skills(organization_id,agent_id,owner_principal_id,package_path,
        origin,state,last_digest,last_candidate_id,policy_revision)
       VALUES ($1,$2,'owner-1',$3,'auto_generated','active',$4,'candidate-1',$5)`,
      [org, agent, pkg.packagePath, pkg.targetDigest, HEX],
    );
    const { recordSkillSourceProjection } =
      await import("../../../../../services/agent-acp-service/src/adapters/postgres/skill-source-projections.js");
    const client: PoolClient = await pool.connect();
    try {
      await recordSkillSourceProjection(client, {
        organizationId: org,
        agentId: agent,
        ownerId: "owner-1",
        candidateId: "candidate-1",
        skillText: pkg.skillText,
        contentDigest: pkg.targetDigest,
      });
    } finally {
      client.release();
    }
  }

  async function seedBudget(runId: string) {
    const run = await pool.query<{ organization_id: string; agent_id: string }>(
      "SELECT organization_id,agent_id FROM runs WHERE id=$1",
      [runId],
    );
    const { organization_id: org, agent_id: agent } = run.rows[0]!;
    await pool.query(
      `INSERT INTO run_usage(run_id,organization_id,agent_id,input_tokens,output_tokens,
        cost_usd_micros) VALUES ($1,$2,$3,10,20,30)`,
      [runId, org, agent],
    );
    await pool.query(
      `INSERT INTO organization_spend(organization_id,period,period_start,cost_usd_micros,
        unbounded_cost_attempts,unknown_attempts) VALUES ($1,'daily',current_date,40,0,1)`,
      [org],
    );
    await pool.query(
      `INSERT INTO model_budget_reservations(run_id,ordinal,organization_id,agent_id,
        policy_revision,input_tokens,output_tokens,cost_usd_micros,state,cost_unknown,
        day_start,month_start)
       VALUES ($1,1,$2,$3,1,10,10,NULL,'unresolved',true,current_date,date_trunc('month',current_date)::date)`,
      [runId, org, agent],
    );
    await pool.query(
      `INSERT INTO model_budget_baseline_attempts(start_id,run_id,organization_id,agent_id,ordinal,started_at)
       VALUES ('start-1',$1,$2,$3,1,now())`,
      [runId, org, agent],
    );
    await pool.query(
      `INSERT INTO model_budget_baseline_receipts(receipt_id,run_id,organization_id,agent_id,
        receipt_at,input_tokens) VALUES ('receipt-1',$1,$2,$3,now(),10)`,
      [runId, org, agent],
    );
  }

  async function budgetDump(): Promise<string> {
    const result = await pool.query<{ value: string }>(
      `SELECT jsonb_build_object(${BUDGET_TABLES.map(
        (name) =>
          `'${name}',(SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY 1),'[]'::jsonb) FROM ${name} t)`,
      ).join(",")})::text AS value`,
    );
    return result.rows[0]!.value;
  }

  const count = async (table: string) =>
    (
      await pool.query<{ count: number }>(
        `SELECT count(*)::integer AS count FROM ${table}`,
      )
    ).rows[0]!.count;

  it("stamps durable deleted_at once and keeps the first delete timestamp", async () => {
    await seedSession("s-1");
    const first = new Date("2026-01-01T00:00:00Z");
    await sessions.delete("s-1", first);
    await sessions.delete("s-1", new Date("2026-02-01T00:00:00Z"));
    const row = await pool.query<{ deleted_at: Date; state: string }>(
      "SELECT deleted_at,state FROM acp_sessions WHERE id='s-1'",
    );
    expect(row.rows[0]!.state).toBe("deleted");
    expect(row.rows[0]!.deleted_at.toISOString()).toBe(first.toISOString());
    await pool.query(
      "UPDATE acp_sessions SET state='deleted',deleted_at=NULL WHERE id='s-1'",
    );
    const preserved = await pool.query<{ deleted_at: Date }>(
      "SELECT deleted_at FROM acp_sessions WHERE id='s-1'",
    );
    expect(preserved.rows[0]!.deleted_at.toISOString()).toBe(
      first.toISOString(),
    );
    await expect(
      pool.query("UPDATE acp_sessions SET state='active' WHERE id='s-1'"),
    ).rejects.toThrow();
  });

  it("stamps deleted_at on raw delete writes outside the repository path", async () => {
    await seedSession("s-1");
    await pool.query("UPDATE acp_sessions SET state='deleted' WHERE id='s-1'");
    const row = await pool.query<{ deleted_at: Date | null }>(
      "SELECT deleted_at FROM acp_sessions WHERE id='s-1'",
    );
    expect(row.rows[0]!.deleted_at).not.toBeNull();
  });

  it("replays the real migration backfill onto a predecessor schema", async () => {
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    const migrationsDir = new URL(
      "../../../../../services/agent-acp-service/migrations/",
      import.meta.url,
    );
    const files = (await readdir(migrationsDir))
      .filter((name) => name.endsWith(".sql"))
      .sort();
    const predecessors = files.filter(
      (name) => name < "0035_content_retention.sql",
    );
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('antnest.fresh_database_install','true',true)",
      );
      for (const file of predecessors)
        await client.query(
          await readFile(new URL(file, migrationsDir), "utf8"),
        );
      await client.query(
        `INSERT INTO acp_sessions(id,organization_id,principal_id,agent_id,cwd,state,
          created_at,updated_at)
         VALUES ('pre-retention','org-1','user-1','agent-1','/workspace','deleted',
          '2000-01-01T00:00:00Z','2000-01-01T00:00:00Z')`,
      );
      const before = await client.query<{ started_at: Date }>(
        "SELECT clock_timestamp() AS started_at",
      );
      const startedAt = before.rows[0]!.started_at;
      await client.query(
        await readFile(
          new URL("0035_content_retention.sql", migrationsDir),
          "utf8",
        ),
      );
      await client.query("COMMIT");
      const row = await pool.query<{
        deleted_at: Date;
        state: string;
        updated_at: Date;
      }>(
        "SELECT deleted_at,state,updated_at FROM acp_sessions WHERE id='pre-retention'",
      );
      expect(row.rows[0]!.state).toBe("deleted");
      expect(row.rows[0]!.deleted_at.getTime()).toBeGreaterThanOrEqual(
        startedAt.getTime(),
      );
      expect(row.rows[0]!.updated_at.toISOString()).toBe(
        new Date("2000-01-01T00:00:00Z").toISOString(),
      );
      const outcome = await purge().batch({
        cutoff: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        limit: 500,
        dryRun: false,
        signal,
      });
      expect(outcome).toMatchObject({ scanned: 0, nextCursor: null });
    } finally {
      try {
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
      await pool.query("DROP SCHEMA public CASCADE");
      await pool.query("CREATE SCHEMA public");
      await migrate(pool);
    }
  });

  it("purges only expired deleted Sessions and keeps newer, active and closed rows", async () => {
    const old = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    for (const [id, state, deletedAt] of [
      ["expired", "deleted", old],
      ["recent", "deleted", new Date()],
      ["active", "active", null],
      ["closed", "closed", null],
    ] as const) {
      await seedSession(id, { state, deletedAt });
      await seedRun(`run-${id}`, id);
      await seedContent(id, `run-${id}`);
    }
    const outcome = await purge().batch({
      cutoff: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      limit: 500,
      dryRun: false,
      signal,
    });
    expect(outcome).toMatchObject({
      scanned: 1,
      blocked: 0,
      nextCursor: "expired",
    });
    expect(outcome.counts.sessions).toBe(1);
    const left = await pool.query<{ id: string }>(
      "SELECT id FROM acp_sessions ORDER BY id",
    );
    expect(left.rows.map((row) => row.id)).toEqual([
      "active",
      "closed",
      "recent",
    ]);
    for (const table of [
      "runs",
      "session_messages",
      "context_checkpoints",
      "client_mcp_revisions",
      "tool_attempts",
    ])
      expect(await count(table)).toBe(3);
    expect(await count("content_purge_audit")).toBe(1);
    expect(events).toEqual([
      expect.stringContaining("acp_content_purge_batch"),
    ]);
  });

  it("removes the complete execution and Learning evidence chain", async () => {
    await seedSession("s-1", { state: "deleted", deletedAt: new Date(0) });
    await seedRun("run-1", "s-1");
    await seedContent("s-1", "run-1");
    await seedLearning("task-1", "run-1");
    await pool.query(
      `INSERT INTO learning_candidates(candidate_id,task_id,claim_id,generation,package_path,
        target_digest,artifact_digest,package_rules_version,skill_text,artifact,evidence_ids,state)
       VALUES ('candidate-draft','task-1','claim-1',1,'.antnest/skills/inspect-first',
        $1,$2,1,'draft skill','\\x01',$3,'draft')`,
      [`sha256:${"d".repeat(64)}`, `sha256:${"e".repeat(64)}`, ["ev-1"]],
    );
    await pool.query(
      `INSERT INTO learning_apply_bases(candidate_id,task_id,check_request_id,policy_revision,
        package_path,target_digest,evidence_ids,execution_id)
       VALUES ('candidate-draft','task-1','intent-task-1',$1,'.antnest/skills/inspect-first',
        $2,$3,'execution-1')`,
      [HEX, `sha256:${"d".repeat(64)}`, ["ev-1"]],
    );
    await pool.query(
      `INSERT INTO tool_permissions(run_id,tool_call_id,request_payload,decision,reason,decided_at)
       VALUES ('run-1','call-1','{}'::jsonb,'allow_once','operator',now())`,
    );
    await pool.query(
      `INSERT INTO learning_scan_cursors(organization_id,agent_id,owner_principal_id,
        policy_revision,activated_at,cursor_created_at,cursor_run_id)
       VALUES ('org-1','agent-1','owner-1',$1,now(),now(),'run-1')`,
      [HEX],
    );
    const outcome = await purge().batch({
      cutoff: new Date(),
      limit: 500,
      dryRun: false,
      signal,
    });
    expect(outcome.counts).toMatchObject({
      sessions: 1,
      runs: 1,
      messages: 1,
      toolAttempts: 1,
      learningTasks: 1,
      evidenceItems: 1,
      evidenceSnapshots: 1,
    });
    for (const table of [
      "acp_sessions",
      "runs",
      "session_messages",
      "context_checkpoints",
      "client_mcp_revisions",
      "tool_attempts",
      "learning_tasks",
      "learning_evidence_items",
      "learning_evidence_snapshots",
      "learning_model_calls",
      "learning_review_attempts",
      "learning_maintenance_intents",
      "learning_source_decisions",
      "learning_candidates",
      "learning_changes",
      "learning_apply_bases",
      "learning_runtime_protections",
      "learning_owner_recoveries",
      "tool_permissions",
      "temporary_skill_scopes",
    ])
      expect(await count(table), table).toBe(0);
    const cursor = await pool.query<{ cursor_run_id: string | null }>(
      "SELECT cursor_run_id FROM learning_scan_cursors",
    );
    expect(cursor.rows[0]!.cursor_run_id).toBeNull();
  });

  it("keeps a published artifact readable and reprojectable with tombstoned provenance", async () => {
    await seedSession("s-1", { state: "deleted", deletedAt: new Date(0) });
    await seedRun("run-1", "s-1");
    await seedPublished("task-1", "s-1", "run-1");
    const key = { agent_id: "agent-1", name: "inspect-first" };
    const before = await projections.read("org-1", key);
    expect(before).not.toBeNull();
    const outcome = await purge().batch({
      cutoff: new Date(),
      limit: 500,
      dryRun: false,
      signal,
    });
    expect(outcome.counts.publishedCandidates).toBe(1);
    expect(outcome.counts.candidates).toBe(0);
    const tombstoned = await pool.query<Record<string, unknown>>(
      "SELECT task_id,provenance_purged_at IS NOT NULL AS purged,purged_task_id,purged_effect_request_id,cardinality(evidence_ids) AS evidence FROM learning_candidates WHERE candidate_id='candidate-1'",
    );
    expect(tombstoned.rows[0]).toMatchObject({
      task_id: null,
      purged: true,
      purged_task_id: "task-1",
      purged_effect_request_id: "intent-task-1",
      evidence: 0,
    });
    const change = await pool.query<Record<string, unknown>>(
      "SELECT task_id,effect_request_id,source_run_id,source_session_id,provenance_purged_at IS NOT NULL AS purged FROM learning_changes",
    );
    expect(change.rows[0]).toMatchObject({
      task_id: null,
      effect_request_id: null,
      source_run_id: null,
      source_session_id: null,
      purged: true,
    });
    expect(await count("learning_managed_skills")).toBe(1);
    const after = await projections.read("org-1", key);
    expect(after).not.toBeNull();
    expect(after!.package.artifact.equals(before!.package.artifact)).toBe(true);
    expect(after!.effectRequestId).toBe(before!.effectRequestId);
    expect(after!.taskId).toBe(before!.taskId);
    expect(after!.generation).toBe(before!.generation);
    await pool.query("DELETE FROM skill_source_projections");
    await projections.pending();
    expect(await projections.read("org-1", key)).not.toBeNull();
  });

  it("leaves budget and accounting rows byte-for-byte unchanged", async () => {
    await seedSession("s-1", { state: "deleted", deletedAt: new Date(0) });
    await seedRun("run-1", "s-1");
    await seedBudget("run-1");
    const before = await budgetDump();
    await purge().batch({
      cutoff: new Date(),
      limit: 500,
      dryRun: false,
      signal,
    });
    expect(await budgetDump()).toBe(before);
    expect(await count("run_usage")).toBe(1);
    expect(await count("organization_spend")).toBe(1);
  });

  it("resumes a bounded scan and a blocked leading row does not starve it", async () => {
    await seedSession("a-blocked", {
      state: "deleted",
      deletedAt: new Date(0),
    });
    await seedRun("run-blocked", "a-blocked", { state: "running" });
    await seedSession("b-safe", { state: "deleted", deletedAt: new Date(0) });
    await seedRun("run-safe", "b-safe");
    const first = await purge().batch({
      cutoff: new Date(),
      limit: 1,
      dryRun: false,
      signal,
    });
    expect(first).toMatchObject({
      scanned: 1,
      blocked: 1,
      nextCursor: "a-blocked",
    });
    expect(first.counts.sessions).toBe(0);
    const second = await purge().batch({
      cutoff: new Date(),
      after: first.nextCursor!,
      limit: 1,
      dryRun: false,
      signal,
    });
    expect(second).toMatchObject({
      scanned: 1,
      blocked: 0,
      nextCursor: "b-safe",
    });
    expect(second.counts.sessions).toBe(1);
    const third = await purge().batch({
      cutoff: new Date(),
      after: second.nextCursor!,
      limit: 1,
      dryRun: false,
      signal,
    });
    expect(third.nextCursor).toBeNull();
    const left = await pool.query<{ id: string }>(
      "SELECT id FROM acp_sessions ORDER BY id",
    );
    expect(left.rows.map((row) => row.id)).toEqual(["a-blocked"]);
  });

  it.each([
    ["running run", { state: "running" }],
    ["admitting run", { state: "admitting" }],
    ["unresolved run", { state: "unresolved" }],
  ])("skips a Session blocked by a %s", async (_name, run) => {
    await seedSession("s-1", { state: "deleted", deletedAt: new Date(0) });
    await seedRun("run-1", "s-1", run);
    const outcome = await purge().batch({
      cutoff: new Date(),
      limit: 500,
      dryRun: false,
      signal,
    });
    expect(outcome).toMatchObject({ scanned: 1, blocked: 1 });
    expect(outcome.counts.sessions).toBe(0);
    expect(await count("acp_sessions")).toBe(1);
    expect(await count("content_purge_audit")).toBe(0);
  });

  it.each([
    ["pending tool attempt", "pending"],
    ["in-progress tool attempt", "in_progress"],
  ])("skips a Session blocked by a %s", async (_name, attemptState) => {
    await seedSession("s-1", { state: "deleted", deletedAt: new Date(0) });
    await seedRun("run-1", "s-1");
    await pool.query(
      `INSERT INTO tool_attempts(id,run_id,tool_call_id,source,source_id,tool_name,request_digest,
        state,tool_effect_state,started_at,created_at,updated_at)
       VALUES ('attempt-1','run-1','call-1','runtime','runtime','bash','digest',$1,'settled',$2,now(),now())`,
      [attemptState, attemptState === "pending" ? null : new Date()],
    );
    const outcome = await purge().batch({
      cutoff: new Date(),
      limit: 500,
      dryRun: false,
      signal,
    });
    expect(outcome.blocked).toBe(1);
  });

  it("skips Sessions blocked by unreleased temporary Skills or unsettled Learning work", async () => {
    await seedSession("s-1", { state: "deleted", deletedAt: new Date(0) });
    await seedRun("run-1", "s-1");
    await pool.query(
      `INSERT INTO temporary_skill_scopes(run_id,organization_id,agent_id,execution_id,mcp_endpoint)
       VALUES ('run-1','org-1','agent-1','execution-1','http://runtime:8093/mcp')`,
    );
    await seedSession("s-2", { state: "deleted", deletedAt: new Date(0) });
    await seedRun("run-2", "s-2");
    await seedLearning("task-2", "run-2", { taskState: "running" });
    await pool.query(
      "UPDATE learning_tasks SET state='running',claim_id='claim-2',generation=1,started_at=now() WHERE id='task-2'",
    );
    await seedSession("s-3", { state: "deleted", deletedAt: new Date(0) });
    await seedRun("run-3", "s-3");
    await seedLearning("task-3", "run-3", { intentState: "pending" });
    await seedSession("s-5", { state: "deleted", deletedAt: new Date(0) });
    await seedRun("run-5", "s-5");
    await seedLearning("task-5", "run-5", { callState: "reserved" });
    await seedSession("s-4", { state: "deleted", deletedAt: new Date(0) });
    await seedRun("run-4", "s-4");
    const outcome = await purge().batch({
      cutoff: new Date(),
      limit: 500,
      dryRun: false,
      signal,
    });
    expect(outcome).toMatchObject({ scanned: 5, blocked: 4 });
    expect(outcome.counts.sessions).toBe(1);
    const left = await pool.query<{ id: string }>(
      "SELECT id FROM acp_sessions ORDER BY id",
    );
    expect(left.rows.map((row) => row.id)).toEqual([
      "s-1",
      "s-2",
      "s-3",
      "s-5",
    ]);
  });

  it("scopes erasure to the selected organization, principal or Session without a grace delay", async () => {
    for (const [id, org, principal] of [
      ["s-1", "org-1", "user-1"],
      ["s-2", "org-1", "user-2"],
      ["s-3", "org-2", "user-1"],
    ] as const) {
      await seedSession(id, { organization: org, principal });
      await seedRun(`run-${id}`, id);
    }
    const byOrg = await purge().batch({
      organizationId: "org-2",
      limit: 500,
      dryRun: false,
      signal,
    });
    expect(byOrg.counts.sessions).toBe(1);
    const byUser = await purge().batch({
      principalId: "user-2",
      limit: 500,
      dryRun: false,
      signal,
    });
    expect(byUser.counts.sessions).toBe(1);
    const left = await pool.query<{ id: string }>(
      "SELECT id FROM acp_sessions ORDER BY id",
    );
    expect(left.rows.map((row) => row.id)).toEqual(["s-1"]);
    const bySession = await purge().batch({
      sessionId: "s-1",
      limit: 500,
      dryRun: false,
      signal,
    });
    expect(bySession.counts.sessions).toBe(1);
    expect(await count("acp_sessions")).toBe(0);
  });

  it("erases an active Session under explicit selection without retention delay", async () => {
    await seedSession("s-1", { state: "active" });
    await seedRun("run-1", "s-1");
    const outcome = await purge().batch({
      sessionId: "s-1",
      limit: 500,
      dryRun: false,
      signal,
    });
    expect(outcome.counts.sessions).toBe(1);
    expect(await count("acp_sessions")).toBe(0);
  });

  it("dry-run reports counts without any mutation or audit row", async () => {
    await seedSession("s-1", { state: "deleted", deletedAt: new Date(0) });
    await seedRun("run-1", "s-1");
    await seedContent("s-1", "run-1");
    const outcome = await purge().batch({
      cutoff: new Date(),
      limit: 500,
      dryRun: true,
      signal,
    });
    expect(outcome).toMatchObject({
      scanned: 1,
      blocked: 0,
      nextCursor: "s-1",
    });
    expect(outcome.counts).toMatchObject({ sessions: 1, runs: 1, messages: 1 });
    expect(await count("acp_sessions")).toBe(1);
    expect(await count("content_purge_audit")).toBe(0);
    expect(events).toEqual([]);
  });

  it("writes one count-only audit row per committed batch", async () => {
    await seedSession("s-1", { state: "deleted", deletedAt: new Date(0) });
    await seedRun("run-1", "s-1");
    await seedContent("s-1", "run-1");
    await purge().batch({
      cutoff: new Date(),
      limit: 500,
      dryRun: false,
      signal,
    });
    const audit = await pool.query<Record<string, unknown>>(
      "SELECT batch_id,counts FROM content_purge_audit",
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.batch_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
    );
    const countsJson = audit.rows[0]!.counts as Record<string, number>;
    expect(Object.keys(countsJson).sort()).toEqual([...COUNT_KEYS].sort());
    expect(countsJson).toMatchObject({ sessions: 1, runs: 1, messages: 1 });
  });

  it("rolls back every deletion when the commit fails", async () => {
    await seedSession("s-1", { state: "deleted", deletedAt: new Date(0) });
    await seedRun("run-1", "s-1");
    await seedContent("s-1", "run-1");
    await pool.query("ALTER TABLE content_purge_audit RENAME TO audit_shadow");
    try {
      await expect(
        purge().batch({
          cutoff: new Date(),
          limit: 500,
          dryRun: false,
          signal,
        }),
      ).rejects.toThrow();
    } finally {
      await pool.query(
        "ALTER TABLE audit_shadow RENAME TO content_purge_audit",
      );
    }
    expect(await count("acp_sessions")).toBe(1);
    expect(await count("runs")).toBe(1);
    expect(await count("session_messages")).toBe(1);
    expect(await count("content_purge_audit")).toBe(0);
  });

  it("nulls the fork link of a surviving child Session", async () => {
    await seedSession("parent", { state: "deleted", deletedAt: new Date(0) });
    await seedRun("run-parent", "parent");
    await seedSession("child", { forkedFrom: "parent" });
    await pool.query(
      "UPDATE acp_sessions SET forked_from_session_id='parent' WHERE id='child'",
    );
    await purge().batch({
      cutoff: new Date(),
      limit: 500,
      dryRun: false,
      signal,
    });
    const child = await pool.query<{ forked_from_session_id: string | null }>(
      "SELECT forked_from_session_id FROM acp_sessions WHERE id='child'",
    );
    expect(child.rows[0]!.forked_from_session_id).toBeNull();
  });

  it("refuses to erase outside the owned fence and rolls back on an expired fence at commit", async () => {
    const leases = new PostgresAgentLeases(kernel);
    const scope = { organizationId: "org-1", agentId: "agent-1" };
    const incarnation = randomUUID();
    const lease = await leases.tryAcquire(scope, incarnation, 30_000);
    expect(lease).not.toBeNull();
    const authority = RunWriteAuthority.owned({
      registration: {
        registration_id: randomUUID(),
        member_id: "acp-a",
        incarnation_id: incarnation,
      },
      fence: lease!.fence,
    });
    await seedSession("s-1", { state: "deleted", deletedAt: new Date(0) });
    await seedRun("run-1", "s-1");
    await seedSession("foreign", {
      organization: "org-2",
      agent: "agent-2",
      state: "deleted",
      deletedAt: new Date(0),
    });
    const owned = new PostgresContentPurge(kernel, authority, telemetry);
    const outcome = await owned.batch({
      cutoff: new Date(),
      limit: 500,
      dryRun: false,
      signal,
    });
    expect(outcome.counts.sessions).toBe(1);
    const foreign = await pool.query(
      "SELECT id FROM acp_sessions WHERE id='foreign'",
    );
    expect(foreign.rows).toHaveLength(1);
    const outside = await owned.batch({
      organizationId: "org-2",
      limit: 500,
      dryRun: false,
      signal,
    });
    expect(outside).toMatchObject({ scanned: 0, blocked: 0, nextCursor: null });
    expect(outside.counts.sessions).toBe(0);
    expect(
      (await pool.query("SELECT id FROM acp_sessions WHERE id='foreign'")).rows,
    ).toHaveLength(1);

    await seedSession("s-2", { state: "deleted", deletedAt: new Date(0) });
    await seedRun("run-2", "s-2");
    await pool.query(
      "UPDATE agent_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE organization_id=$1 AND agent_id=$2",
      [scope.organizationId, scope.agentId],
    );
    await expect(
      owned.batch({ cutoff: new Date(), limit: 500, dryRun: false, signal }),
    ).rejects.toBeInstanceOf(AgentOwnershipLostError);
    expect(await count("acp_sessions")).toBe(2);
  });

  it("rolls back when the live fence expires during the locked batch", async () => {
    const leases = new PostgresAgentLeases(kernel);
    const scope = { organizationId: "org-1", agentId: "agent-1" };
    const incarnation = randomUUID();
    const lease = await leases.tryAcquire(scope, incarnation, 30_000);
    const authority = RunWriteAuthority.owned({
      registration: {
        registration_id: randomUUID(),
        member_id: "acp-a",
        incarnation_id: incarnation,
      },
      fence: lease!.fence,
    });
    await seedSession("s-1", { state: "deleted", deletedAt: new Date(0) });
    await seedRun("run-1", "s-1");
    await seedContent("s-1", "run-1");
    await pool.query(
      "UPDATE agent_leases SET expires_at=clock_timestamp()+interval '400 milliseconds' WHERE organization_id=$1 AND agent_id=$2",
      [scope.organizationId, scope.agentId],
    );
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM runs WHERE id='run-1' FOR UPDATE");
      const owned = new PostgresContentPurge(kernel, authority, telemetry);
      const pending = owned.batch({
        cutoff: new Date(),
        limit: 500,
        dryRun: false,
        signal,
      });
      void pending.catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 700));
      await holder.query("COMMIT");
      await expect(pending).rejects.toBeInstanceOf(AgentOwnershipLostError);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
    }
    expect(await count("acp_sessions")).toBe(1);
    expect(await count("runs")).toBe(1);
    expect(await count("content_purge_audit")).toBe(0);
    expect(events).toEqual([]);
  });

  it("keeps a failed cold-start Run purgeable", async () => {
    await seedSession("s-1", { state: "deleted", deletedAt: new Date(0) });
    await seedRun("run-1", "s-1", {
      state: "failed",
      executor: null,
      effect: null,
    });
    await pool.query(
      "UPDATE runs SET execution_snapshot=NULL,deadline_at=NULL,terminal_class=NULL,executor_state=NULL,tool_effect_state=NULL,error_class='start_failed' WHERE id='run-1'",
    );
    const outcome = await purge().batch({
      cutoff: new Date(),
      limit: 500,
      dryRun: false,
      signal,
    });
    expect(outcome.counts.sessions).toBe(1);
  });

  it("blocks purge while a settled Runtime attempt lacks a stopped call", async () => {
    await seedSession("s-1", { state: "deleted", deletedAt: new Date(0) });
    await seedRun("run-1", "s-1");
    await pool.query(
      `INSERT INTO tool_attempts(id,run_id,tool_call_id,source,source_id,tool_name,request_digest,
        state,tool_effect_state,started_at,finished_at,runtime_call_stopped,created_at,updated_at)
       VALUES ('attempt-1','run-1','call-1','runtime','runtime','bash','digest','completed',
        'settled',now(),now(),false,now(),now())`,
    );
    const blocked = await purge().batch({
      cutoff: new Date(),
      limit: 500,
      dryRun: false,
      signal,
    });
    expect(blocked).toMatchObject({ scanned: 1, blocked: 1 });
    expect(await count("acp_sessions")).toBe(1);
    await pool.query(
      "UPDATE tool_attempts SET runtime_call_stopped=true WHERE id='attempt-1'",
    );
    const released = await purge().batch({
      cutoff: new Date(),
      limit: 500,
      dryRun: false,
      signal,
    });
    expect(released.counts.sessions).toBe(1);
    expect(await count("acp_sessions")).toBe(0);
  });

  it("waits for a locked Session instead of skipping it when requested", async () => {
    await seedSession("s-1", { state: "deleted", deletedAt: new Date(0) });
    await seedRun("run-1", "s-1");
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(
        "UPDATE acp_sessions SET updated_at=clock_timestamp() WHERE id='s-1'",
      );
      const pending = purge().batch({
        sessionId: "s-1",
        limit: 500,
        dryRun: false,
        waitForLocks: true,
        signal,
      });
      void pending.catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 150));
      await holder.query("COMMIT");
      const outcome = await pending;
      expect(outcome).toMatchObject({ scanned: 1, blocked: 0 });
      expect(outcome.counts.sessions).toBe(1);
      expect(await count("acp_sessions")).toBe(0);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
    }
  });

  it("refuses an exclusive lock while a live shared worker owns the database", async () => {
    const shared = await PostgresWorkerLock.acquire(pool, { mode: "shared" });
    try {
      await expect(
        PostgresWorkerLock.acquire(pool, { mode: "exclusive" }),
      ).rejects.toThrow(/another Agent ACP worker/u);
    } finally {
      await shared.release();
    }
    const exclusive = await PostgresWorkerLock.acquire(pool, {
      mode: "exclusive",
    });
    try {
      await expect(
        PostgresWorkerLock.acquire(pool, { mode: "exclusive" }),
      ).rejects.toThrow(/another Agent ACP worker/u);
    } finally {
      await exclusive.release();
    }
  });
});
