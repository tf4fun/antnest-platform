import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createLegacyRunRepositories,
  createOwnedRunRepositories,
} from "../../../../../services/agent-acp-service/src/adapters/postgres/run-repositories.js";
import { AgentOwnershipLostError } from "../../../../../services/agent-acp-service/src/domain/agent-ownership.js";
import {
  scope,
  withDatabase,
  type FencingFixture,
} from "../../support/run-fencing-fixture.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
async function running(f: FencingFixture, agent = "context") {
  const session = await f.session(scope(agent));
  const owner = await f.owner(session.binding);
  const repositories = createOwnedRunRepositories(f.kernelA, owner.authority);
  const intent = f.input(session);
  await repositories.runs.createRunIntent(intent);
  await repositories.runs.acceptRun(f.acceptance(session, intent.runId));
  return { session, owner, runId: intent.runId, ...repositories };
}
function input(sessionId: string, runId: string) {
  return {
    id: randomUUID(),
    sessionId,
    runId,
    throughSequence: 1,
    summary: "original summary",
    tokenCount: 3,
    createdAt: new Date(),
  };
}
async function denied(f: FencingFixture, work: () => Promise<void>) {
  const before = await f.snapshot();
  await expect(work()).rejects.toBeInstanceOf(AgentOwnershipLostError);
  expect(await f.snapshot()).toBe(before);
}

describe.skipIf(databaseUrl === undefined)(
  "original Run-bound context checkpoints",
  () => {
    it("requires the original Run tuple and live lease even for a duplicate checkpoint", async () => {
      await withDatabase(async (f) => {
        const a = await running(f);
        const checkpoint = input(a.session.sessionId, a.runId);
        await a.contexts.saveCheckpoint(checkpoint);
        const committed = await f.snapshot();
        await a.contexts.saveCheckpoint(checkpoint);
        expect(await f.snapshot()).toBe(committed);
        const b = await f.successor(a.owner, a.owner.authority.registration);
        await denied(f, () => a.contexts.saveCheckpoint(checkpoint));
        await denied(f, () =>
          createOwnedRunRepositories(
            f.kernelB,
            b.authority,
          ).contexts.saveCheckpoint(checkpoint),
        );
        await denied(f, () =>
          createLegacyRunRepositories(
            f.kernelA,
            new AbortController().signal,
          ).contexts.saveCheckpoint(checkpoint),
        );
      });
    });

    it("cannot bind a checkpoint to another Session or a Session's newer Run", async () => {
      await withDatabase(async (f) => {
        const a = await running(f, "context-a");
        const b = await running(f, "context-b");
        await denied(f, () =>
          a.contexts.saveCheckpoint(input(b.session.sessionId, a.runId)),
        );
        await denied(f, () =>
          a.contexts.saveCheckpoint(input(a.session.sessionId, b.runId)),
        );
        await a.executions.finish({
          runId: a.runId,
          terminalClass: "completed",
          executorState: "quiescent",
          toolEffectState: "none",
          stopReason: "end_turn",
          finishedAt: new Date(),
        });
        const successor = await f.successor(a.owner);
        const next = createOwnedRunRepositories(f.kernelB, successor.authority);
        const intent = f.input(a.session);
        await next.runs.createRunIntent(intent);
        await next.runs.acceptRun(f.acceptance(a.session, intent.runId));
        await denied(f, () =>
          next.contexts.saveCheckpoint(input(a.session.sessionId, a.runId)),
        );
        await next.contexts.saveCheckpoint(
          input(a.session.sessionId, intent.runId),
        );
      });
    });

    it("captures the Run, Session, summary and Date before waiting, and retains the lease until commit", async () => {
      await withDatabase(async (f) => {
        const a = await running(f, "capture-a");
        const b = await running(f, "capture-b");
        const checkpoint = input(a.session.sessionId, a.runId);
        const original = structuredClone(checkpoint);
        const held = await f.holdSession(a.session.sessionId);
        const writing = f.observe(a.contexts.saveCheckpoint(checkpoint));
        await f.waitForBlockedWriter();
        let released = false;
        const releasing = f.observe(
          f.leasesB.release(a.owner.authority.fence).then((value) => {
            released = true;
            return value;
          }),
        );
        await f.waitForBlockedWriter(f.nameB);
        expect(released).toBe(false);
        checkpoint.runId = b.runId;
        checkpoint.sessionId = b.session.sessionId;
        checkpoint.summary = "changed";
        checkpoint.createdAt.setTime(0);
        await f.release(held);
        await writing;
        expect(await releasing).toBe(true);
        expect(
          (
            await f.observer.query(
              "SELECT session_id,summary,created_at FROM context_checkpoints WHERE id=$1",
              [original.id],
            )
          ).rows,
        ).toEqual([
          {
            session_id: original.sessionId,
            summary: original.summary,
            created_at: original.createdAt,
          },
        ]);
      });
    });

    it("does not recreate checkpoints after refusal invalidated the original Run's context", async () => {
      await withDatabase(async (f) => {
        const a = await running(f);
        const checkpoint = input(a.session.sessionId, a.runId);
        await a.contexts.saveCheckpoint(checkpoint);
        await a.executions.finish({
          runId: a.runId,
          terminalClass: "completed",
          executorState: "quiescent",
          toolEffectState: "none",
          stopReason: "refusal",
          finishedAt: new Date(),
        });
        const before = await f.snapshot();
        await expect(a.contexts.saveCheckpoint(checkpoint)).rejects.toThrow(
          "Run is not running",
        );
        expect(await f.snapshot()).toBe(before);
        expect(
          (
            await f.observer.query(
              "SELECT count(*)::int AS n FROM context_checkpoints",
            )
          ).rows,
        ).toEqual([{ n: 0 }]);
      });
    });
  },
);
