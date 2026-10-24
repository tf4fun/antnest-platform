import { describe, expect, it } from "vitest";
import {
  PostgresWorkerLock,
  WorkerOwnershipLostError,
} from "../../../../../services/agent-acp-service/src/adapters/postgres/worker-lock.js";
import { RunRecovery } from "../../../../../services/agent-acp-service/src/application/run-recovery.js";
import {
  AgentOwnershipLostError,
  type AgentOwnershipScope,
} from "../../../../../services/agent-acp-service/src/domain/agent-ownership.js";
import { NOOP_TELEMETRY } from "../../../../../services/agent-acp-service/src/ports/telemetry.js";
import { withDatabase } from "../../support/run-fencing-fixture.js";
import {
  worker,
  run,
  permission,
  learning,
  task,
  unchanged,
} from "../../support/startup-recovery-fixture.js";
const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
const a = { organizationId: "organization-a", agentId: "shared-agent" };
const b = { organizationId: "organization-b", agentId: "shared-agent" };
const c = { organizationId: "organization-b", agentId: "agent-c" };

describe.skipIf(databaseUrl === undefined)(
  "scoped legacy startup recovery under the actual worker lock",
  () => {
    it("scopes pending permission cancellation by the complete org/Agent tuple and still rejects owned scopes", async () => {
      await withDatabase(async (f) => {
        const w = await worker(f);
        try {
          const owned = await run(f, a, w.signal, true);
          const healthy = await run(f, b, w.signal, false);
          const other = await run(f, c, w.signal, false);
          for (const current of [owned, healthy, other])
            await permission(current);
          const before = await unchanged(f);
          await expect(
            w.legacy.permissions.cancelAbandoned(),
          ).rejects.toBeInstanceOf(AgentOwnershipLostError);
          expect(await unchanged(f)).toEqual(before);
          await w.legacy.permissions.cancelAbandoned(b);
          const rows = (
            await f.observer.query(
              "SELECT r.organization_id,r.agent_id,p.decision,p.reason FROM tool_permissions p JOIN runs r ON r.id=p.run_id ORDER BY r.organization_id,r.agent_id",
            )
          ).rows;
          expect(rows).toEqual([
            {
              organization_id: a.organizationId,
              agent_id: a.agentId,
              decision: null,
              reason: null,
            },
            {
              organization_id: c.organizationId,
              agent_id: c.agentId,
              decision: null,
              reason: null,
            },
            {
              organization_id: b.organizationId,
              agent_id: b.agentId,
              decision: "cancelled",
              reason: "service_restarted",
            },
          ]);
          await expect(
            w.legacy.permissions.cancelAbandoned(a),
          ).rejects.toBeInstanceOf(AgentOwnershipLostError);
        } finally {
          await w.close();
        }
      });
    });

    it("lists only the selected legacy scope and keeps global mixed-database recovery fail closed", async () => {
      await withDatabase(async (f) => {
        const w = await worker(f);
        try {
          await run(f, a, w.signal, true);
          const healthy = await run(f, b, w.signal, false);
          await run(f, c, w.signal, false);
          const before = await unchanged(f);
          await expect(
            w.legacy.executions.listRecoveryWork(),
          ).rejects.toBeInstanceOf(AgentOwnershipLostError);
          expect(await w.legacy.executions.listRecoveryWork(b)).toEqual([
            { id: healthy.input.runId, kind: "running" },
          ]);
          await expect(
            w.legacy.executions.listRecoveryWork(a),
          ).rejects.toBeInstanceOf(AgentOwnershipLostError);
          expect(await unchanged(f)).toEqual(before);
        } finally {
          await w.close();
        }
      });
    });

    it("recovers B and admits its next Run without changing owned A or unrelated C", async () => {
      await withDatabase(async (f) => {
        const w = await worker(f);
        try {
          const owned = await run(f, a, w.signal, true);
          const healthy = await run(f, b, w.signal, false);
          const other = await run(f, c, w.signal, false);
          const original = await f.origin(owned.input.runId);
          const recovery = new RunRecovery({
            ...w.legacy,
            telemetry: NOOP_TELEMETRY,
            now: () => new Date(),
          });
          await recovery.recoverLegacyScope(b, w.signal);
          expect(
            (
              await f.observer.query("SELECT state FROM runs WHERE id=$1", [
                healthy.input.runId,
              ])
            ).rows,
          ).toEqual([{ state: "failed" }]);
          for (const untouched of [owned, other])
            expect(
              (
                await f.observer.query("SELECT state FROM runs WHERE id=$1", [
                  untouched.input.runId,
                ])
              ).rows,
            ).toEqual([{ state: "running" }]);
          expect(await f.origin(owned.input.runId)).toEqual(original);
          const next = f.input(healthy.session);
          await w.legacy.runs.createRunIntent(next);
          expect(
            await w.legacy.runs.acceptRun(
              f.acceptance(healthy.session, next.runId),
            ),
          ).toBe("accepted");
          expect(
            (
              await f.observer.query("SELECT state FROM runs WHERE id=$1", [
                next.runId,
              ])
            ).rows,
          ).toEqual([{ state: "running" }]);
        } finally {
          await w.close();
        }
      });
    });

    it("serializes different Learning scopes without borrowing another scope's result or touching owned tasks", async () => {
      await withDatabase(async (f) => {
        const w = await worker(f);
        try {
          const owned = await learning(f, a, w.signal, true);
          const before = await unchanged(f);
          await expect(
            w.lock.pauseAbandonedLearningTasks(),
          ).rejects.toBeInstanceOf(AgentOwnershipLostError);
          const rejected = w.lock.pauseAbandonedLearningTasks(a);
          const unrelated = w.lock.pauseAbandonedLearningTasks(c);
          await expect(rejected).rejects.toBeInstanceOf(
            AgentOwnershipLostError,
          );
          await expect(unrelated).resolves.toBe(0);
          expect(await unchanged(f)).toEqual(before);
          // The real scheduler permits only one running review. Release that slot
          // through the original owner before creating the legacy recovery case.
          await owned.repositories.outcomes.pauseRunning(
            owned.claim,
            "worker_lost",
          );
          const healthy = await learning(f, b, w.signal, false);
          const original = await task(f, owned.taskId);
          const mutable = { ...c };
          const first = w.lock.pauseAbandonedLearningTasks(mutable);
          const joined = w.lock.pauseAbandonedLearningTasks(c);
          const second = w.lock.pauseAbandonedLearningTasks(b);
          void first.catch(() => {});
          void second.catch(() => {});
          mutable.agentId = a.agentId;
          mutable.organizationId = a.organizationId;
          expect(joined).toBe(first);
          expect(second).not.toBe(first);
          expect(await Promise.all([first, second])).toEqual([0, 1]);
          expect(await task(f, owned.taskId)).toEqual(original);
          expect(await task(f, healthy.taskId)).toMatchObject({
            task: {
              state: "paused",
              pause_reason: "worker_lost",
              generation: 1,
              model_calls: 1,
            },
            calls: [{ state: "unknown", actual_input_tokens: null }],
          });
          expect(await task(f, owned.taskId)).toEqual(original);
        } finally {
          await w.close();
        }
      });
    });
    it("rejects invalid explicit scopes before any global recovery can run", async () => {
      await withDatabase(async (f) => {
        const w = await worker(f);
        try {
          const healthy = await run(f, b, w.signal, false);
          await permission(healthy);
          const before = await unchanged(f);
          const recovery = new RunRecovery({
            ...w.legacy,
            telemetry: NOOP_TELEMETRY,
            now: () => new Date(),
          });
          for (const invalid of [
            null,
            {},
            { organizationId: b.organizationId },
            { ...b, agentId: " " },
          ]) {
            const scope = invalid as AgentOwnershipScope;
            for (const operation of [
              () => w.lock.pauseAbandonedLearningTasks(scope),
              () => w.legacy.permissions.cancelAbandoned(scope),
              () => w.legacy.executions.listRecoveryWork(scope),
              () => recovery.recoverLegacyScope(scope, w.signal),
            ]) {
              await expect(
                Promise.resolve().then<unknown>(operation),
              ).rejects.toBeInstanceOf(TypeError);
              expect(await unchanged(f)).toEqual(before);
            }
          }
        } finally {
          await w.close();
        }
      });
    });

    it("joins a blocked original recovery and rejects queued scopes before releasing the worker connection", async () => {
      await withDatabase(async (f) => {
        const w = await worker(f);
        let held: Awaited<ReturnType<typeof f.holdSession>> | undefined;
        try {
          const healthy = await learning(f, b, w.signal, false);
          const before = await unchanged(f);
          held = await f.holdSession(healthy.source.session.sessionId);
          await held.query(
            "SELECT id FROM learning_tasks WHERE id=$1 FOR UPDATE",
            [healthy.taskId],
          );
          const original = f.observe(
            w.lock
              .pauseAbandonedLearningTasks(b)
              .catch((error: unknown) => error),
          );
          await f.waitForBlockedWriter();
          const queued = f.observe(
            w.lock
              .pauseAbandonedLearningTasks(c)
              .catch((error: unknown) => error),
          );
          let released = false;
          const release = f.observe(
            w.lock.release().then(() => {
              released = true;
            }),
          );
          let repeatedReleased = false;
          const repeatedRelease = f.observe(
            w.lock.release().then(() => {
              repeatedReleased = true;
            }),
          );
          expect(w.lock.isHeld()).toBe(false);
          await Promise.resolve();
          expect(released).toBe(false);
          expect(repeatedReleased).toBe(false);
          await f.release(held);
          held = undefined;
          await expect(original).resolves.toBeInstanceOf(
            WorkerOwnershipLostError,
          );
          await expect(queued).resolves.toBeInstanceOf(
            WorkerOwnershipLostError,
          );
          await release;
          await repeatedRelease;
          expect(released).toBe(true);
          expect(await unchanged(f)).toEqual(before);
          const replacement = await PostgresWorkerLock.acquire(f.b);
          await replacement.release();
        } finally {
          if (held !== undefined) await f.release(held);
          await w.close();
        }
      });
    });
  },
);
