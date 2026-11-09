import { randomBytes, randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { SecretBox } from "../../../../../services/agent-acp-service/src/adapters/postgres/secret-box.js";
import { migrate } from "../../../../../services/agent-acp-service/src/adapters/postgres/migrate.js";
import { PostgresKernel } from "../../../../../services/agent-acp-service/src/adapters/postgres/kernel.js";
import { createLegacySessionRepository } from "../../../../../services/agent-acp-service/src/adapters/postgres/session-repository.js";
import { createLegacyRunRepositories } from "../../../../../services/agent-acp-service/src/adapters/postgres/run-repositories.js";
import { PostgresBridgeObservationRepository } from "../../../../../services/agent-acp-service/src/adapters/postgres/bridge-observation-repository.js";
import { PostgresContentPurge } from "../../../../../services/agent-acp-service/src/adapters/postgres/content-purge.js";
import { RunWriteAuthority } from "../../../../../services/agent-acp-service/src/adapters/postgres/run-write-authority.js";
import { BridgeObservationService } from "../../../../../services/agent-acp-service/src/application/bridge-observation.js";
import { authorizeSession } from "../../../../../services/agent-acp-service/src/domain/session.js";
import { DomainError } from "../../../../../services/agent-acp-service/src/domain/errors.js";
import type { ConnectionBinding } from "../../../../../services/agent-acp-service/src/domain/types.js";
import { AgentAcpHttpServer } from "../../../../../services/agent-acp-service/src/transport/http-server.js";
import type { AcpApplicationPort } from "../../../../../services/agent-acp-service/src/ports/acp-application.js";
import {
  testAuthentication,
  testHeaders,
} from "../../../../../services/agent-acp-service/test/support/auth-fixture.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;

describe.skipIf(databaseUrl === undefined)(
  "Bridge intent receipt retention watermark",
  () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 4 });
    const kernel = new PostgresKernel(pool);
    const secretBox = new SecretBox(randomBytes(32));
    const sessions = createLegacySessionRepository(
      kernel,
      secretBox,
      new AbortController().signal,
    );
    const runs = createLegacyRunRepositories(
      kernel,
      new AbortController().signal,
    ).runs;
    const observations = new PostgresBridgeObservationRepository(kernel);
    const expected = {
      organizationId: "organization-1",
      principalId: "principal-1",
      agentId: "agent-1",
    };
    const access = {
      assert: vi.fn((binding: ConnectionBinding) =>
        binding.organizationId === expected.organizationId &&
        binding.principalId === expected.principalId &&
        binding.agentId === expected.agentId
          ? Promise.resolve()
          : Promise.reject(new DomainError("access_denied", "Denied")),
      ),
    };
    const service = new BridgeObservationService({
      access,
      sessions: {
        requireAuthorized: async (
          sessionId: string,
          binding: ConnectionBinding,
        ) => {
          const session = await sessions.get(sessionId);
          if (session === null)
            throw new DomainError(
              "session_not_found",
              "Session does not exist",
            );
          authorizeSession(session, binding);
          return session;
        },
      },
      repository: observations,
    });
    let server: AgentAcpHttpServer | undefined;

    beforeAll(async () => {
      await pool.query("DROP SCHEMA public CASCADE");
      await pool.query("CREATE SCHEMA public");
      await migrate(pool);
      server = new AgentAcpHttpServer({
        authentication: testAuthentication(),
        application: applicationPort(),
        ready: () => Promise.resolve(true),
        maxWebSocketPayloadBytes: 64 * 1024,
        bridgeObservation: service,
      });
      await server.listen("127.0.0.1", 0);
    });

    afterAll(async () => {
      try {
        await server?.close();
      } finally {
        await pool.end();
      }
    });

    const binding = { connectionId: "connection-1", ...expected };
    const headers = (agentId = "agent-1") =>
      testHeaders({
        "X-Antnest-Organization-Id": "organization-1",
        "X-Antnest-Principal-Id": "principal-1",
        "X-Antnest-Agent-Id": agentId,
      });
    const url = (sessionId: string, intentId: string) => {
      const address = server!.address();
      if (address === null || typeof address === "string")
        throw new Error("Expected TCP listener");
      return `http://127.0.0.1:${address.port}/rpc/agent-acp/workspace/sessions/${sessionId}/intents/${intentId}`;
    };
    const createSession = (sessionId: string, agentId = "agent-1") =>
      sessions.create({
        sessionId,
        binding: { ...binding, agentId },
        cwd: "/workspace",
        mcpRevisionId: randomUUID(),
        mcpSources: [],
      });
    const createIntent = (
      sessionId: string,
      runId: string,
      intentId: string,
      expectedAppendVersion: number,
      bridge = true,
    ) =>
      runs.createRunIntent({
        runId,
        requestId: randomUUID(),
        sessionId,
        expectedAccessRevision: "access-1",
        userMessageId: randomUUID(),
        prompt: [{ type: "text" as const, text: "hello" }],
        createdAt: new Date(),
        ...(bridge
          ? { bridgeIntent: { intentId, expectedAppendVersion } }
          : {}),
      });
    const settle = (runId: string) =>
      runs.rejectRun(runId, "provider_unavailable", new Date());
    const watermark = (sessionId: string) =>
      pool
        .query<{ receipt_retained_after_append_version: string | null }>(
          "SELECT receipt_retained_after_append_version FROM acp_sessions WHERE id = $1",
          [sessionId],
        )
        .then(
          (result) => result.rows[0]?.receipt_retained_after_append_version,
        );

    it("reports unknown, expired and retained outcomes from the real deletion trigger", async () => {
      const sessionId = randomUUID();
      const unpruned = randomUUID();
      const [runOld, runKept] = [randomUUID(), randomUUID()];
      await createSession(sessionId);
      await createSession(unpruned);
      expect(await watermark(sessionId)).toBeNull();

      const fresh = await fetch(url(sessionId, "intent-never"), {
        headers: headers(),
      });
      expect(fresh.status).toBe(404);
      await expect(fresh.json()).resolves.toMatchObject({
        code: "intent_unknown",
        retryable: true,
      });

      await createIntent(sessionId, runOld, "intent-pruned", 0);
      await settle(runOld);
      await createIntent(sessionId, runKept, "intent-kept", 1);
      await settle(runKept);
      const retained = await fetch(url(sessionId, "intent-kept"), {
        headers: headers(),
      });
      expect(retained.status).toBe(200);
      await expect(retained.json()).resolves.toMatchObject({
        intentId: "intent-kept",
      });

      await pool.query("DELETE FROM runs WHERE id = $1", [runOld]);
      expect(await watermark(sessionId)).toBe("1");

      const expired = await fetch(url(sessionId, "intent-pruned"), {
        headers: headers(),
      });
      expect(expired.status).toBe(410);
      await expect(expired.json()).resolves.toMatchObject({
        code: "intent_receipt_expired",
        category: "not_found",
        retryable: false,
      });
      const conservative = await fetch(url(sessionId, "intent-opaque"), {
        headers: headers(),
      });
      expect(conservative.status).toBe(410);
      await expect(conservative.json()).resolves.toMatchObject({
        code: "intent_receipt_expired",
      });
      const stillRetained = await fetch(url(sessionId, "intent-kept"), {
        headers: headers(),
      });
      expect(stillRetained.status).toBe(200);
      await expect(stillRetained.json()).resolves.toMatchObject({
        intentId: "intent-kept",
      });

      const pristine = await fetch(url(unpruned, "intent-any"), {
        headers: headers(),
      });
      expect(pristine.status).toBe(404);
      await expect(pristine.json()).resolves.toMatchObject({
        code: "intent_unknown",
      });
      expect(await watermark(unpruned)).toBeNull();
      await expect(
        observations.readIntent(sessionId, "intent-never"),
      ).resolves.toEqual({
        kind: "expired",
      });
    });

    it("keeps the watermark monotonic, bulk-maximal and atomic with Run deletions", async () => {
      const sessionId = randomUUID();
      const [runHigh, runLow, runPlain] = [
        randomUUID(),
        randomUUID(),
        randomUUID(),
      ];
      await createSession(sessionId);
      await createIntent(sessionId, runLow, "intent-low", 0);
      await settle(runLow);
      await createIntent(sessionId, runHigh, "intent-high", 1);
      await settle(runHigh);
      await createIntent(sessionId, runPlain, "intent-plain", 0, false);
      await settle(runPlain);

      await pool.query("DELETE FROM runs WHERE id = $1", [runHigh]);
      expect(await watermark(sessionId)).toBe("2");
      await pool.query("DELETE FROM runs WHERE id = $1", [runLow]);
      expect(await watermark(sessionId)).toBe("2");

      const rolledId = randomUUID();
      const [rollHigh, rollLow] = [randomUUID(), randomUUID()];
      await createSession(rolledId);
      await createIntent(rolledId, rollLow, "roll-low", 0);
      await settle(rollLow);
      await createIntent(rolledId, rollHigh, "roll-high", 1);
      await settle(rollHigh);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("DELETE FROM runs WHERE id = $1", [rollHigh]);
        await client.query("DELETE FROM runs WHERE id = $1", [rollLow]);
        const mid = await client.query<{ v: string }>(
          "SELECT receipt_retained_after_append_version AS v FROM acp_sessions WHERE id = $1",
          [rolledId],
        );
        expect(mid.rows[0]?.v).toBe("2");
      } finally {
        try {
          await client.query("ROLLBACK");
        } finally {
          client.release();
        }
      }
      expect(
        (
          await pool.query("SELECT id FROM runs WHERE session_id = $1", [
            rolledId,
          ])
        ).rowCount,
      ).toBe(2);
      expect(await watermark(rolledId)).toBeNull();

      await pool.query("DELETE FROM runs WHERE id = $1", [runPlain]);
      expect(await watermark(sessionId)).toBe("2");

      const bulkId = randomUUID();
      const [bulkOne, bulkTwo] = [randomUUID(), randomUUID()];
      await createSession(bulkId);
      await createIntent(bulkId, bulkOne, "bulk-one", 0);
      await settle(bulkOne);
      await createIntent(bulkId, bulkTwo, "bulk-two", 1);
      await settle(bulkTwo);
      await pool.query("DELETE FROM runs WHERE session_id = $1", [bulkId]);
      expect(await watermark(bulkId)).toBe("2");

      const pristineId = randomUUID();
      await createSession(pristineId);
      const plainRun = randomUUID();
      await createIntent(pristineId, plainRun, "plain", 0, false);
      await settle(plainRun);
      await pool.query("DELETE FROM runs WHERE id = $1", [plainRun]);
      expect(await watermark(pristineId)).toBeNull();

      await migrate(pool);
      expect(await watermark(sessionId)).toBe("2");
      expect(await watermark(pristineId)).toBeNull();
    });

    it("keeps missing, deleted, purged, foreign and revoked Sessions without storage leaks", async () => {
      const missing = await fetch(url(randomUUID(), "intent-1"), {
        headers: headers(),
      });
      expect(missing.status).toBe(404);
      await expect(missing.json()).resolves.toMatchObject({
        code: "session_not_found",
      });

      const softDeletedId = randomUUID();
      await createSession(softDeletedId);
      await pool.query(
        "UPDATE acp_sessions SET state = 'deleted' WHERE id = $1",
        [softDeletedId],
      );
      const softDeleted = await fetch(url(softDeletedId, "intent-1"), {
        headers: headers(),
      });
      expect(softDeleted.status).toBe(404);
      await expect(softDeleted.json()).resolves.toMatchObject({
        code: "session_not_found",
      });

      const purgedId = randomUUID();
      await createSession(purgedId);
      await pool.query(
        "UPDATE acp_sessions SET state = 'deleted', deleted_at = $2 WHERE id = $1",
        [purgedId, new Date(0)],
      );
      const purge = new PostgresContentPurge(
        kernel,
        RunWriteAuthority.legacy(new AbortController().signal),
      );
      const outcome = await purge.batch({
        sessionId: purgedId,
        cutoff: new Date(),
        limit: 500,
        dryRun: false,
        signal: new AbortController().signal,
      });
      expect(outcome.counts.sessions).toBe(1);
      const purged = await fetch(url(purgedId, "intent-1"), {
        headers: headers(),
      });
      expect(purged.status).toBe(404);
      await expect(purged.json()).resolves.toMatchObject({
        code: "session_not_found",
      });

      const foreignId = randomUUID();
      await createSession(foreignId, "agent-2");
      const foreign = await fetch(url(foreignId, "intent-1"), {
        headers: headers(),
      });
      expect(foreign.status).toBe(404);
      await expect(foreign.json()).resolves.toMatchObject({
        code: "session_not_found",
      });

      const spy = vi.spyOn(observations, "readIntent");
      try {
        const revoked = await fetch(url(foreignId, "intent-1"), {
          headers: headers("agent-3"),
        });
        expect(revoked.status).toBe(403);
        await expect(revoked.json()).resolves.toMatchObject({
          code: "access_denied",
        });
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });
  },
);

function applicationPort(): AcpApplicationPort {
  const unexpected = () =>
    Promise.reject(new Error("Unexpected application port call"));
  return {
    assertAccess: unexpected,
    createSession: unexpected,
    listSessions: unexpected,
    resumeSession: unexpected,
    closeSession: unexpected,
    deleteSession: unexpected,
    forkSession: unexpected,
    cancelRun: unexpected,
    acceptPrompt: unexpected,
    readSessionOutput: unexpected,
    getSessionConfiguration: unexpected,
    setSessionConfiguration: unexpected,
  };
}
