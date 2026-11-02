import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { postgresPoolOptions } from "../../../../../services/agent-acp-service/src/adapters/postgres/kernel.js";
import { PostgresWorkerLock } from "../../../../../services/agent-acp-service/src/adapters/postgres/worker-lock.js";
import { migrate } from "../../../../../services/agent-acp-service/src/adapters/postgres/migrate.js";
import { runOfflineContentPurge } from "../../../../../services/agent-acp-service/src/purge.js";

const url = process.env.ANTNEST_ACP_TEST_DATABASE_URL;

describe.skipIf(url === undefined)(
  "PostgreSQL offline content purge command",
  () => {
    const seedPool = new Pool({ connectionString: url, max: 4 });

    beforeEach(async () => {
      await seedPool.query("DROP SCHEMA public CASCADE");
      await seedPool.query("CREATE SCHEMA public");
      await migrate(seedPool);
    });
    afterAll(() => seedPool.end());

    async function seedSession(
      id: string,
      organization: string,
      principal: string,
    ) {
      await seedPool.query(
        `INSERT INTO acp_sessions(id,organization_id,principal_id,agent_id,cwd,state,created_at,updated_at)
       VALUES ($1,$2,$3,'agent-command','/workspace','active',now(),now())`,
        [id, organization, principal],
      );
      await seedPool.query(
        `INSERT INTO client_mcp_revisions(id,session_id,revision,encrypted_sources,nonce,created_at)
       VALUES ($1,$2,1,decode('00','hex'),decode('00','hex'),now())`,
        [`mcp-${id}`, id],
      );
      await seedPool.query(
        "UPDATE acp_sessions SET client_mcp_revision_id=$2 WHERE id=$1",
        [id, `mcp-${id}`],
      );
      await seedPool.query(
        `INSERT INTO session_messages(id,session_id,sequence,kind,visible,payload,created_at)
       VALUES ($1,$2,1,'user_message',true,'{"text":"command privacy fixture"}'::jsonb,now())`,
        [`message-${id}`, id],
      );
      await seedPool.query(
        `INSERT INTO context_checkpoints(id,session_id,through_sequence,summary,token_count,created_at)
       VALUES ($1,$2,1,'private summary',2,now())`,
        [`checkpoint-${id}`, id],
      );
    }

    async function seedBlocked(id: string, organization: string) {
      await seedPool.query(
        `INSERT INTO runs(id,request_id,session_id,client_mcp_revision_id,expected_access_revision,
        state,pending_user_message_id,input_prompt,created_at,updated_at,organization_id,agent_id)
       VALUES ('run-command','request-command',$1,$2,'access-command','admitting',
        'pending-command','[]'::jsonb,now(),now(),$3,'agent-command')`,
        [id, `mcp-${id}`, organization],
      );
    }

    const sessions = async () =>
      (
        await seedPool.query<{ id: string }>(
          "SELECT id FROM acp_sessions ORDER BY id",
        )
      ).rows.map((row) => row.id);
    const audit = async () =>
      (
        await seedPool.query<{ counts: Record<string, number> }>(
          "SELECT counts FROM content_purge_audit ORDER BY occurred_at,batch_id",
        )
      ).rows.map((row) => row.counts);
    const sessionCount = async (table: string, id: string) =>
      (
        await seedPool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM ${table} WHERE session_id=$1`,
          [id],
        )
      ).rows[0]!.count;

    function command(args: string[], batchLimit = 1) {
      const pool = new Pool(postgresPoolOptions(url!, 1000));
      const lines: string[] = [];
      const run = runOfflineContentPurge({
        args,
        batchLimit,
        out: (line) => lines.push(line),
        pool,
        ownership: new AbortController(),
      });
      return { pool, lines, run };
    }

    it("dry-run reports scoped counts without mutating or auditing", async () => {
      await seedSession("session-a", "org-a", "user-one");
      await seedSession("session-b", "org-a", "user-two");
      await seedSession("session-c", "org-b", "user-one");
      const c = command(["--user", "user-one", "--dry-run"]);
      await expect(c.run).resolves.toBe(0);
      expect(c.pool.totalCount).toBe(0);
      expect(c.lines).toHaveLength(1);
      const summary = JSON.parse(c.lines[0]!) as {
        dryRun: boolean;
        scanned: number;
        blocked: number;
        counts: Record<string, number>;
      };
      expect(summary).toMatchObject({
        dryRun: true,
        scanned: 2,
        blocked: 0,
        counts: { sessions: 2, messages: 2 },
      });
      expect(c.lines[0]).not.toMatch(
        /session-a|session-c|user-one|privacy|private/iu,
      );
      expect(await sessions()).toEqual(["session-a", "session-b", "session-c"]);
      expect(await sessionCount("session_messages", "session-a")).toBe("1");
      expect(await sessionCount("context_checkpoints", "session-a")).toBe("1");
      expect(await audit()).toEqual([]);
    });

    it("confirmed erasure removes the scoped principal and audits count-only", async () => {
      await seedSession("session-a", "org-a", "user-one");
      await seedSession("session-b", "org-a", "user-two");
      await seedSession("session-c", "org-b", "user-one");
      const c = command(["--user", "user-one", "--confirm"]);
      await expect(c.run).resolves.toBe(0);
      expect(c.pool.totalCount).toBe(0);
      expect(await sessions()).toEqual(["session-b"]);
      expect(await sessionCount("session_messages", "session-a")).toBe("0");
      expect(await sessionCount("context_checkpoints", "session-c")).toBe("0");
      const rows = await audit();
      expect(rows).toHaveLength(2);
      for (const row of rows)
        expect(row).toMatchObject({ sessions: 1, messages: 1 });
      const surface = `${c.lines.join("\n")}${JSON.stringify(rows)}`;
      expect(surface).not.toMatch(
        /session-a|session-c|user-one|org-a|privacy|private/iu,
      );
    });

    it("organization selector erases every principal of that organization only", async () => {
      await seedSession("session-a", "org-a", "user-one");
      await seedSession("session-b", "org-a", "user-two");
      await seedSession("session-c", "org-b", "user-one");
      const c = command(["--organization", "org-a", "--confirm"]);
      await expect(c.run).resolves.toBe(0);
      expect(c.pool.totalCount).toBe(0);
      expect(await sessions()).toEqual(["session-c"]);
      const bySession = command(["--session", "session-c", "--confirm"]);
      await expect(bySession.run).resolves.toBe(0);
      expect(bySession.pool.totalCount).toBe(0);
      expect(await sessions()).toEqual([]);
    });

    it("a blocked Session exits nonzero, keeps all content and writes no audit", async () => {
      await seedSession("session-a", "org-a", "user-one");
      await seedBlocked("session-a", "org-a");
      const c = command(["--session", "session-a", "--confirm"]);
      await expect(c.run).resolves.toBe(1);
      expect(c.pool.totalCount).toBe(0);
      const summary = JSON.parse(c.lines[0]!) as {
        blocked: number;
        counts: Record<string, number>;
      };
      expect(summary).toMatchObject({ blocked: 1, counts: { sessions: 0 } });
      expect(await sessions()).toEqual(["session-a"]);
      expect(await sessionCount("session_messages", "session-a")).toBe("1");
      expect(await audit()).toEqual([]);
    });

    it("refuses a live shared worker lock then proceeds once released", async () => {
      await seedSession("session-a", "org-a", "user-one");
      const shared = await PostgresWorkerLock.acquire(seedPool, {
        mode: "shared",
      });
      try {
        const c = command(["--session", "session-a", "--dry-run"]);
        await expect(c.run).rejects.toThrow();
        expect(c.pool.totalCount).toBe(0);
        expect(c.lines).toEqual([]);
        expect(await sessions()).toEqual(["session-a"]);
      } finally {
        await shared.release();
      }
      const after = command(["--session", "session-a", "--dry-run"]);
      await expect(after.run).resolves.toBe(0);
      expect(after.pool.totalCount).toBe(0);
      expect(await sessions()).toEqual(["session-a"]);
    });

    it("rejects missing confirmation arguments before any database work", async () => {
      await seedSession("session-a", "org-a", "user-one");
      const c = command(["--session", "session-a"]);
      await expect(c.run).rejects.toThrow();
      expect(c.pool.totalCount).toBe(0);
      expect(c.lines).toEqual([]);
      expect(await sessions()).toEqual(["session-a"]);
      expect(await audit()).toEqual([]);
    });
  },
);
