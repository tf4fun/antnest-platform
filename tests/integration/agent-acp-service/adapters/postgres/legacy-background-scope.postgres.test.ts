import { describe, expect, it } from "vitest";
import type { AgentOwnershipScope } from "../../../../../services/agent-acp-service/src/domain/agent-ownership.js";
import { withDatabase } from "../../support/run-fencing-fixture.js";
import {
  worker,
  run,
  learning,
  unchanged,
} from "../../support/startup-recovery-fixture.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
const a = { organizationId: "organization-a", agentId: "shared-agent" };
const b = { organizationId: "organization-b", agentId: "shared-agent" };
const c = { organizationId: "organization-b", agentId: "agent-c" };

describe.skipIf(databaseUrl === undefined)(
  "scoped legacy background recovery candidates",
  () => {
    it("selects only the requested legacy paused Learning without relabeling claims", async () => {
      await withDatabase(async (f) => {
        const w = await worker(f);
        try {
          const first = await learning(f, a, w.signal, false);
          await first.repositories.outcomes.pauseRunning(
            first.claim,
            "worker_lost",
          );
          const other = await learning(f, b, w.signal, false);
          await other.repositories.outcomes.pauseRunning(
            other.claim,
            "worker_lost",
          );
          const owned = await learning(f, c, w.signal, true);
          await owned.repositories.outcomes.pauseRunning(
            owned.claim,
            "worker_lost",
          );
          const before = await unchanged(f);
          const outcomes = first.repositories.outcomes as unknown as {
            listPaused(
              after: string | null,
              limit: number,
              scope?: AgentOwnershipScope,
            ): ReturnType<typeof first.repositories.outcomes.listPaused>;
          };
          expect(
            (await outcomes.listPaused(null, 100, a)).map((item) => item.claim),
          ).toEqual([first.claim]);
          expect(
            (await outcomes.listPaused(null, 100, b)).map((item) => item.claim),
          ).toEqual([other.claim]);
          expect(await outcomes.listPaused(null, 100, c)).toEqual([]);
          for (const invalid of [
            null,
            {},
            { organizationId: a.organizationId },
            { ...a, agentId: " " },
          ])
            await expect(
              outcomes.listPaused(null, 100, invalid as AgentOwnershipScope),
            ).rejects.toBeInstanceOf(TypeError);
          expect(await unchanged(f)).toEqual(before);
        } finally {
          await w.close();
        }
      });
    });

    it("partitions Temporary cleanup candidates by authority and complete scope while retaining all protection reads", async () => {
      await withDatabase(async (f) => {
        const w = await worker(f);
        try {
          const values = [];
          for (const [scope, owned] of [
            [a, false],
            [b, false],
            [c, true],
          ] as const) {
            const current = await run(f, scope, w.signal, owned);
            const temporary =
              await current.repositories.temporarySkills.reserve({
                runId: current.input.runId,
                snapshot: f.acceptance(current.session, current.input.runId)
                  .snapshot,
                signal: w.signal,
              });
            await current.repositories.executions.finish({
              runId: current.input.runId,
              terminalClass: "unresolved",
              executorState: "quiescent",
              toolEffectState: "unknown",
              unknownEffectSource: "runtime_mcp",
              errorClass: "background_scope_fixture",
              finishedAt: new Date(),
            });
            values.push({ current, temporary });
          }
          const before = await unchanged(f);
          const legacy = values[0]!.current.repositories.temporarySkills;
          for (const [index, scope] of [a, b].entries())
            expect(await legacy.next(null, w.signal, scope)).toEqual(
              values[index]!.temporary,
            );
          expect(await legacy.next(null, w.signal, c)).toBeNull();
          const owned = values[2]!.current.repositories.temporarySkills;
          expect(await owned.next(null, w.signal)).toEqual(
            values[2]!.temporary,
          );
          expect(
            await owned.next(values[2]!.temporary.runId, w.signal),
          ).toBeNull();
          // Legacy protection reads must still expose an owned effect; filtering
          // candidate dispatch must not turn an outstanding effect into "clear".
          expect(await w.legacy.temporarySkills.forAgent(c, w.signal)).toEqual([
            values[2]!.temporary,
          ]);
          for (const invalid of [
            null,
            {},
            { organizationId: a.organizationId },
            { ...a, agentId: " " },
          ])
            await expect(
              legacy.next(null, w.signal, invalid as AgentOwnershipScope),
            ).rejects.toBeInstanceOf(TypeError);
          expect(await unchanged(f)).toEqual(before);
        } finally {
          await w.close();
        }
      });
    });
  },
);
