import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresExecutionAudits } from "../../../../../services/agent-acp-service/src/adapters/postgres/execution-audit.js";
import { PostgresKernel } from "../../../../../services/agent-acp-service/src/adapters/postgres/kernel.js";
import { migrate } from "../../../../../services/agent-acp-service/src/adapters/postgres/migrate.js";
import { PostgresRunRepository } from "../../../../../services/agent-acp-service/src/adapters/postgres/run-repository.js";
import { PostgresSessionRepository } from "../../../../../services/agent-acp-service/src/adapters/postgres/session-repository.js";
import { PostgresToolPermissions } from "../../../../../services/agent-acp-service/src/adapters/postgres/tool-permissions.js";
import { SecretBox } from "../../../../../services/agent-acp-service/src/adapters/postgres/secret-box.js";
import { encodeSessionEvent } from "../../../../../services/agent-acp-service/src/adapters/postgres/session-event-codec.js";
import { ExecutionAudits } from "../../../../../services/agent-acp-service/src/application/execution-audit.js";
import {
  auditEventsSchema,
  type AuditPrincipal,
} from "../../../../../services/agent-acp-service/src/domain/execution-audit.js";
import { snapshot } from "../../../../../services/agent-acp-service/test/support/fixtures.js";

const url = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
describe.skipIf(url === undefined)(
  "ACP historical administrative audit",
  () => {
    const pool = new Pool({ connectionString: url, max: 3 });
    const kernel = new PostgresKernel(pool);
    const sessions = new PostgresSessionRepository(
      kernel,
      new SecretBox(randomBytes(32)),
    );
    const runs = new PostgresRunRepository(kernel);
    const repository = new PostgresExecutionAudits(kernel);
    const queries = new ExecutionAudits(repository);
    const signal = new AbortController().signal;
    const admin: AuditPrincipal = {
      organizationId: "audit-org",
      principalId: "audit-admin",
      membershipId: "audit-membership",
      systemRole: "user",
      organizationRole: "admin",
    };
    beforeAll(async () => {
      await pool.query("DROP SCHEMA public CASCADE");
      await pool.query("CREATE SCHEMA public");
      await migrate(pool);
    });
    afterAll(async () => {
      await pool.end();
    });

    async function create(
      organizationId = admin.organizationId,
      accept = false,
    ) {
      const id = randomUUID(),
        sessionId = randomUUID(),
        revisionId = randomUUID();
      await sessions.create({
        sessionId,
        binding: {
          connectionId: randomUUID(),
          organizationId,
          principalId: "owner-1",
          agentId: "agent-removed",
        },
        cwd: "/workspace",
        mcpRevisionId: revisionId,
        mcpSources: [],
      });
      await runs.createRunIntent({
        runId: id,
        requestId: randomUUID(),
        sessionId,
        expectedAccessRevision: "access-1",
        userMessageId: randomUUID(),
        prompt: [{ type: "text", text: `trigger-${id}` }],
        createdAt: new Date("2026-09-14T00:00:00Z"),
      });
      if (accept)
        await runs.acceptRun({
          runId: id,
          snapshot: {
            ...snapshot(),
            clientMcpRevisionId: revisionId,
            deadlineAt: new Date(Date.now() + 3_600_000),
          },
          environmentFact: null,
          acceptedAt: new Date(),
        });
      else await runs.rejectRun(id, "provider_unavailable", new Date());
      return { id, sessionId };
    }

    it("reads rejected triggers after Session deletion and repository recreation with no live Agent config", async () => {
      const run = await create();
      await pool.query(
        "UPDATE acp_sessions SET state = 'deleted' WHERE id = $1",
        [run.sessionId],
      );
      const fresh = new ExecutionAudits(new PostgresExecutionAudits(kernel));
      const detail = await fresh.get(admin, { run_id: run.id }, signal);
      expect(detail).toMatchObject({
        run_id: run.id,
        state: "failed",
        input: [{ type: "text", text: `trigger-${run.id}` }],
        execution_snapshot: null,
        error_class: "provider_unavailable",
        usage_measurements: [],
      });
      expect(await sessions.replay(run.sessionId)).toEqual([]);
      expect(
        (
          await pool.query("SELECT state FROM acp_sessions WHERE id = $1", [
            run.sessionId,
          ])
        ).rows[0],
      ).toEqual({ state: "deleted" });
    });

    it("isolates get/list/events/permissions using immutable Session organization", async () => {
      const other = await create("other-org");
      await expect(
        queries.get(admin, { run_id: other.id }, signal),
      ).rejects.toMatchObject({
        code: "audit_not_found",
      });
      for (const stream of ["execution", "permissions"])
        await expect(
          queries.events(admin, { run_id: other.id, stream }, signal),
        ).rejects.toMatchObject({ code: "audit_not_found" });
      const page = await queries.list(admin, {}, signal);
      expect(page.items.map((row) => row.run_id)).not.toContain(other.id);
    });

    it("paginates tied creation times without gaps and applies time/Session filters", async () => {
      const org = randomUUID();
      const actor = { ...admin, organizationId: org };
      const first = await create(org),
        second = await create(org),
        third = await create(org);
      await pool.query(
        "UPDATE runs SET created_at = '2026-09-14T00:00:00.123456Z' WHERE id = ANY($1::text[])",
        [[first.id, second.id, third.id]],
      );
      const filter = {
        agent_id: "agent-removed",
        created_from: "2026-09-14T00:00:00.123Z",
        created_until: "2026-09-14T00:00:00.123999Z",
        limit: 1,
      };
      const one = await queries.list(actor, filter, signal);
      const two = await queries.list(
        actor,
        { ...filter, cursor: one.next_cursor },
        signal,
      );
      const three = await queries.list(
        actor,
        { ...filter, cursor: two.next_cursor },
        signal,
      );
      expect([
        one.items[0]!.run_id,
        two.items[0]!.run_id,
        three.items[0]!.run_id,
      ]).toEqual([first.id, second.id, third.id].sort().reverse());
      expect(three.next_cursor).toBeNull();
      const scoped = await queries.list(
        actor,
        { session_id: first.sessionId },
        signal,
      );
      expect(scoped.items.map((item) => item.run_id)).toEqual([first.id]);
      expect(
        (
          await queries.list(
            actor,
            { created_until: "2026-09-13T00:00:00Z" },
            signal,
          )
        ).items,
      ).toEqual([]);
    });

    it("decodes tool details and permissions, retaining per-call usage without copied fork messages", async () => {
      const run = await create(admin.organizationId, true);
      const toolEvent = {
        kind: "tool_call" as const,
        initial: true as const,
        toolCallId: "call-1",
        title: "bash",
        arguments: { command: "printf '\\0'" },
        rawOutput: "a\u0000b",
        status: "completed" as const,
        content: [{ type: "text", text: "done" }],
      };
      await pool.query(
        "INSERT INTO session_messages(id, session_id, run_id, sequence, kind, visible, payload, created_at) VALUES ($1,$2,$3,2,'tool_call',true,$4::jsonb,now()), ($5,$2,$3,3,'usage',true,$6::jsonb,now())",
        [
          randomUUID(),
          run.sessionId,
          run.id,
          JSON.stringify(encodeSessionEvent(toolEvent)),
          randomUUID(),
          JSON.stringify({
            kind: "usage",
            used: 3,
            size: 100,
            measurement: {
              inputTokens: 1,
              outputTokens: 2,
              cost: {
                amount: 0.001,
                currency: "USD",
                source: "provider_reported",
              },
            },
            cost: { amount: 999, currency: "USD" },
          }),
        ],
      );
      const copied = await create();
      await pool.query(
        "INSERT INTO session_messages(id,session_id,run_id,sequence,kind,visible,payload,created_at) VALUES ($1,$2,$3,1,'agent_message',true,$4::jsonb,now())",
        [
          randomUUID(),
          copied.sessionId,
          run.id,
          JSON.stringify({
            kind: "agent_message",
            content: [{ type: "text", text: "copied-fork-only" }],
          }),
        ],
      );
      const permission = new PostgresToolPermissions(kernel);
      const request = {
        runId: run.id,
        sessionId: run.sessionId,
        call: {
          id: "call-1",
          name: "bash",
          arguments: { command: "echo hello" },
        },
        tool: {
          source: "runtime" as const,
          sourceId: "runtime",
          name: "bash",
          modelName: "bash",
          description: "Run a command",
        },
      };
      await permission.open(request);
      await permission.decide({
        request,
        result: { decision: "allow_once", reason: "user_approved" },
      });
      const events = await queries.events(admin, { run_id: run.id }, signal);
      expect(events.items).toHaveLength(3);
      expect(events.items[1]).toMatchObject({
        kind: "tool_call",
        payload: toolEvent,
      });
      expect(JSON.stringify(events)).not.toContain("copied-fork-only");
      const decisions = await queries.events(
        admin,
        { run_id: run.id, stream: "permissions" },
        signal,
      );
      expect(decisions.items).toEqual([
        expect.objectContaining({
          tool_call_id: "call-1",
          request,
          decision: "allow_once",
          reason: "user_approved",
        }),
      ]);
      const otherRequest = {
        ...request,
        call: { ...request.call, id: "call+外部=" },
      };
      await permission.open(otherRequest);
      await pool.query(
        "UPDATE tool_permissions SET created_at = '2026-09-14T00:00:00.123456Z' WHERE run_id = $1",
        [run.id],
      );
      const filter = { run_id: run.id, stream: "permissions", limit: 1 };
      const first = auditEventsSchema.parse(
        await queries.events(admin, filter, signal),
      );
      const second = auditEventsSchema.parse(
        await queries.events(
          admin,
          { ...filter, cursor: first.next_cursor },
          signal,
        ),
      );
      expect(first.stream).toBe("permissions");
      expect(second.stream).toBe("permissions");
      if (first.stream !== "permissions" || second.stream !== "permissions")
        throw new Error("Wrong stream");
      expect(
        new Set(
          [...first.items, ...second.items].map((item) => item.tool_call_id),
        ),
      ).toEqual(new Set([request.call.id, otherRequest.call.id]));
      expect(second.next_cursor).toBeNull();
      const firstEvent = await queries.events(
        admin,
        { run_id: run.id, limit: 1 },
        signal,
      );
      const remainingEvents = await queries.events(
        admin,
        { run_id: run.id, cursor: firstEvent.next_cursor },
        signal,
      );
      expect([...firstEvent.items, ...remainingEvents.items]).toEqual(
        events.items,
      );
      expect(remainingEvents.next_cursor).toBeNull();
      const detail = await queries.get(admin, { run_id: run.id }, signal);
      expect(detail.usage_measurements).toEqual([
        {
          inputTokens: 1,
          outputTokens: 2,
          cost: { amount: 0.001, currency: "USD", source: "provider_reported" },
        },
      ]);
      expect(detail.execution_snapshot).not.toHaveProperty("credential");
    });
  },
);
