import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createLegacyRunRepositories,
  createOwnedRunRepositories,
} from "../../../../../services/agent-acp-service/src/adapters/postgres/run-repositories.js";
import { lockRuntimeBarrierOrganization } from "../../../../../services/agent-acp-service/src/adapters/postgres/runtime-barrier.js";
import { AgentOwnershipLostError } from "../../../../../services/agent-acp-service/src/domain/agent-ownership.js";
import type {
  RunEventRepository,
  StartToolAttemptInput,
} from "../../../../../services/agent-acp-service/src/ports/run-event-repository.js";
import type { FinishLocalRunInput } from "../../../../../services/agent-acp-service/src/ports/execution-repository.js";
import {
  scope,
  withDatabase,
  type FencingFixture,
} from "../../support/run-fencing-fixture.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
const kinds = [
  "message",
  "thought",
  "usage",
  "plan",
  "rejected",
  "start",
  "progress",
  "finish",
  "interrupt",
] as const;
type Kind = (typeof kinds)[number];

async function running(f: FencingFixture, agent = "events") {
  const session = await f.session(scope(agent));
  const owner = await f.owner(session.binding);
  const input = f.input(session);
  const repositories = createOwnedRunRepositories(f.kernelA, owner.authority);
  await repositories.runs.createRunIntent(input);
  await repositories.runs.acceptRun(f.acceptance(session, input.runId));
  return { session, owner, runId: input.runId, ...repositories };
}

function toolStart(runId: string): StartToolAttemptInput {
  return {
    id: randomUUID(),
    runId,
    toolCallId: randomUUID(),
    tool: {
      source: "runtime",
      sourceId: "runtime",
      name: "bash",
      modelName: "runtime_bash",
      description: "Owned tool",
    },
    arguments: { command: "original" },
    requestDigest: "a".repeat(64),
    createdAt: new Date(),
  };
}

async function operation(
  events: RunEventRepository,
  runId: string,
  kind: Kind,
) {
  const input = {
    id: randomUUID(),
    runId,
    content: [{ type: "text" as const, text: "original event" }],
    createdAt: new Date(),
  };
  const start = toolStart(runId);
  if (["progress", "finish", "interrupt"].includes(kind))
    await events.startToolAttempt(start);
  return (repository: RunEventRepository): Promise<unknown> => {
    switch (kind) {
      case "message":
        return repository.appendAgentMessage(input);
      case "thought":
        return repository.appendAgentThought(input);
      case "usage":
        return repository.appendUsage({
          ...input,
          usage: { inputTokens: 100, outputTokens: 10 },
          contextSize: 1000,
        });
      case "plan":
        return repository.appendPlan({
          ...input,
          events: [
            {
              kind: "plan",
              entries: [
                {
                  content: "original plan",
                  priority: "high",
                  status: "pending",
                },
              ],
            },
            {
              kind: "tool_call",
              initial: true,
              toolCallId: "plan",
              title: "Plan",
              modelName: "update_plan",
              arguments: {},
              status: "completed",
            },
          ],
        });
      case "rejected":
        return repository.appendRejectedToolCall({
          ...input,
          call: { id: "refused", name: "refused", arguments: {} },
          message: "not available",
        });
      case "start":
        return repository.startToolAttempt(start);
      case "progress":
        return repository.appendToolProgress({
          ...input,
          toolCallId: start.toolCallId,
        });
      case "finish":
        return repository.finishToolAttempt({
          ...input,
          toolCallId: start.toolCallId,
          status: "completed",
          resultSummary: input.content,
          toolEffectState: "settled",
          runtimeCallStopped: true,
        });
      case "interrupt":
        return repository.interruptToolAttempts(
          runId,
          input.createdAt,
          "persistence_failure",
        );
    }
  };
}

async function snapshot(f: FencingFixture) {
  return JSON.stringify({
    core: await f.snapshot(),
    permissions: (
      await f.observer.query(
        "SELECT to_jsonb(p) AS fact FROM tool_permissions p ORDER BY run_id, tool_call_id",
      )
    ).rows,
    barriers: (
      await f.observer.query(
        "SELECT to_jsonb(b) AS fact FROM runtime_barrier_cycles b ORDER BY barrier_id",
      )
    ).rows,
  });
}

async function denied(f: FencingFixture, work: () => Promise<unknown>) {
  const before = await snapshot(f);
  await expect(work()).rejects.toBeInstanceOf(AgentOwnershipLostError);
  expect(await snapshot(f)).toBe(before);
}

function terminal(runId: string): FinishLocalRunInput {
  return {
    runId,
    terminalClass: "completed",
    executorState: "quiescent",
    toolEffectState: "settled",
    stopReason: "refusal",
    finishedAt: new Date(),
  };
}

describe.skipIf(databaseUrl === undefined)(
  "owned Run event and terminal writes",
  () => {
    it.each(kinds)(
      "guards %s before mutation, duplicate receipt and successor access",
      async (kind) => {
        await withDatabase(async (f) => {
          const run = await running(f);
          const write = await operation(run.events, run.runId, kind);
          const receipt = await write(run.events);
          const committed = await snapshot(f);
          expect(await write(run.events)).toEqual(receipt);
          expect(await snapshot(f)).toBe(committed);
          const successor = await f.successor(run.owner);
          await denied(f, () => write(run.events));
          await denied(f, () =>
            write(
              createOwnedRunRepositories(f.kernelB, successor.authority).events,
            ),
          );
          await denied(f, () =>
            write(
              createLegacyRunRepositories(
                f.kernelA,
                new AbortController().signal,
              ).events,
            ),
          );
          const foreign = await f.owner(scope("other-agent"));
          await denied(f, () =>
            write(
              createOwnedRunRepositories(f.kernelA, foreign.authority).events,
            ),
          );
        });
      },
    );

    it("rejects missing/expired leases and wrong registration before all event side effects", async () => {
      await withDatabase(async (f) => {
        const run = await running(f);
        const pending = [];
        for (const kind of kinds)
          pending.push(await operation(run.events, run.runId, kind));
        const mismatched = createOwnedRunRepositories(f.kernelA, {
          ...run.owner.authority,
          registration: {
            ...run.owner.authority.registration,
            registration_id: randomUUID(),
          },
        });
        for (const write of pending)
          await denied(f, () => write(mismatched.events));
        await f.observer.query(
          "UPDATE agent_leases SET expires_at=clock_timestamp()-interval '1 second'",
        );
        for (const write of pending) await denied(f, () => write(run.events));
        await f.observer.query("DELETE FROM agent_leases");
        for (const write of pending) await denied(f, () => write(run.events));
      });
    });

    it("captures event payload, target and timestamp before waiting on the Session", async () => {
      await withDatabase(async (f) => {
        const a = await running(f, "input-a");
        const b = await running(f, "input-b");
        const input = {
          id: randomUUID(),
          runId: a.runId,
          content: [{ type: "text" as const, text: "original" }],
          createdAt: new Date(),
        };
        const original = structuredClone(input);
        const held = await f.holdSession(a.session.sessionId);
        const pending = f.observe(a.events.appendAgentMessage(input));
        await f.waitForBlockedWriter();
        input.runId = b.runId;
        input.id = randomUUID();
        input.content[0]!.text = "changed";
        input.createdAt.setTime(0);
        await f.release(held);
        await pending;
        expect(
          (
            await f.observer.query(
              "SELECT run_id, payload->'content' AS content, created_at FROM session_messages WHERE id=$1",
              [original.id],
            )
          ).rows,
        ).toEqual([
          {
            run_id: a.runId,
            content: original.content,
            created_at: original.createdAt,
          },
        ]);
        expect(
          (
            await f.observer.query(
              "SELECT count(*)::int AS n FROM session_messages WHERE run_id=$1 AND kind='agent_message'",
              [b.runId],
            )
          ).rows,
        ).toEqual([{ n: 0 }]);
      });
    });

    it("fences terminal atomic effects and checks authority before identical terminal replay", async () => {
      await withDatabase(async (f) => {
        const run = await running(f);
        await run.events.startToolAttempt(toolStart(run.runId));
        await f.observer.query(
          "INSERT INTO tool_permissions(run_id,tool_call_id,request_payload) VALUES($1,'pending','{}')",
          [run.runId],
        );
        await f.observer.query(
          "INSERT INTO context_checkpoints(id,session_id,through_sequence,summary,token_count,created_at) VALUES($1,$2,1,'original',1,now())",
          [randomUUID(), run.session.sessionId],
        );
        const finish = terminal(run.runId);
        const wrong = await f.owner(scope("wrong-finish"));
        await denied(f, () =>
          createOwnedRunRepositories(
            f.kernelA,
            wrong.authority,
          ).executions.finish(finish),
        );
        await run.executions.finish(finish);
        expect(
          (
            await f.observer.query<{ context_excluded: boolean }>(
              "SELECT context_excluded FROM session_messages WHERE run_id=$1",
              [run.runId],
            )
          ).rows.every((r) => r.context_excluded === true),
        ).toBe(true);
        expect(
          (
            await f.observer.query(
              "SELECT count(*)::int AS n FROM context_checkpoints",
            )
          ).rows,
        ).toEqual([{ n: 0 }]);
        expect(
          (
            await f.observer.query(
              "SELECT decision, reason FROM tool_permissions WHERE run_id=$1",
              [run.runId],
            )
          ).rows,
        ).toEqual([{ decision: "cancelled", reason: "run_finished" }]);
        expect(
          (
            await f.observer.query(
              "SELECT count(*)::int AS n FROM runtime_barrier_cycles",
            )
          ).rows,
        ).toEqual([{ n: 1 }]);
        const committed = await snapshot(f);
        await run.executions.finish(finish);
        expect(await snapshot(f)).toBe(committed);
        const next = await f.successor(
          run.owner,
          run.owner.authority.registration,
        );
        await denied(f, () => run.executions.finish(finish));
        await denied(f, () =>
          createOwnedRunRepositories(
            f.kernelB,
            next.authority,
          ).executions.finish(finish),
        );
        await denied(f, () =>
          createLegacyRunRepositories(
            f.kernelA,
            new AbortController().signal,
          ).executions.finish(finish),
        );
      });
    });

    it("takes the organization barrier before the lease and checks takeover after that wait", async () => {
      await withDatabase(async (f) => {
        const run = await running(f);
        // This held Session is an unrelated fixture lock only used to own/join the
        // observer transaction. The organization advisory lock is the finish gate.
        const unrelated = await f.session(scope("barrier-holder"));
        const held = await f.holdSession(unrelated.sessionId);
        await lockRuntimeBarrierOrganization(
          held,
          run.session.binding.organizationId,
        );
        const pending = f.observe(
          run.executions.finish(terminal(run.runId)).then(
            () => ({ error: undefined }),
            (error: unknown) => ({ error }),
          ),
        );
        await f.waitForBlockedWriter();
        // If finish held the lease while waiting for organization, release would
        // block here and the real database timeout would fail this assertion.
        const next = await f.successor(run.owner);
        expect(next.authority.fence.epoch).not.toBe(
          run.owner.authority.fence.epoch,
        );
        const before = await snapshot(f);
        await f.release(held);
        expect((await pending).error).toBeInstanceOf(AgentOwnershipLostError);
        expect(await snapshot(f)).toBe(before);
      });
    });

    it("captures finish input before locks and leaves legacy recovery fail-closed on owned work", async () => {
      await withDatabase(async (f) => {
        const run = await running(f);
        const legacy = createLegacyRunRepositories(
          f.kernelA,
          new AbortController().signal,
        );
        const before = await snapshot(f);
        await expect(
          legacy.executions.listRecoveryWork(),
        ).rejects.toBeInstanceOf(AgentOwnershipLostError);
        expect(await snapshot(f)).toBe(before);
        const input = terminal(run.runId);
        const original = structuredClone(input);
        const held = await f.holdSession(run.session.sessionId);
        const pending = f.observe(run.executions.finish(input));
        await f.waitForBlockedWriter();
        input.runId = "changed-run";
        input.finishedAt.setTime(0);
        await f.release(held);
        await pending;
        expect(
          (
            await f.observer.query(
              "SELECT state, updated_at FROM runs WHERE id=$1",
              [original.runId],
            )
          ).rows,
        ).toEqual([{ state: "completed", updated_at: original.finishedAt }]);
      });
    });
  },
);
