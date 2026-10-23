import { describe, expect, it } from "vitest";
import { AgentGenerations } from "../../../../../services/agent-acp-service/src/application/agent-generations.js";
import { createOwnedRunRepositories } from "../../../../../services/agent-acp-service/src/adapters/postgres/run-repositories.js";
import { AgentOwnershipLostError } from "../../../../../services/agent-acp-service/src/domain/agent-ownership.js";
import {
  expectedOrigin,
  registration,
  scope,
  withDatabase,
} from "../../support/run-fencing-fixture.js";

type Repositories = ReturnType<typeof createOwnedRunRepositories>;
const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;

describe.skipIf(databaseUrl === undefined)(
  "Agent generation with real lease and Run persistence",
  () => {
    it("keeps the captured owner through intent/accept and releases only that lease after drain", async () => {
      await withDatabase(async (fixture) => {
        const session = await fixture.session(scope("generation-original"));
        const owner = registration();
        const manager = new AgentGenerations<Repositories>({
          registration: owner,
          leases: fixture.leasesA,
        });
        try {
          const generation = await manager.prepare(
            session.binding,
            (generation) =>
              Promise.resolve(
                createOwnedRunRepositories(
                  fixture.kernelA,
                  generation.authority,
                ),
              ),
          );
          const input = fixture.input(session);
          await generation.dispatch((repositories) =>
            repositories.runs.createRunIntent(input),
          );
          expect(
            await generation.dispatch((repositories) =>
              repositories.runs.acceptRun(
                fixture.acceptance(session, input.runId),
              ),
            ),
          ).toBe("accepted");
          expect(await fixture.origin(input.runId)).toEqual(
            expectedOrigin({
              authority: generation.authority,
              runs: createOwnedRunRepositories(
                fixture.kernelA,
                generation.authority,
              ).runs,
            }),
          );
          expect((await fixture.leasesB.read(session.binding))?.fence).toEqual(
            generation.authority.fence,
          );
          await manager.drain();
          const next = await fixture.leasesB.tryAcquire(
            session.binding,
            registration("acp-next").incarnation_id,
            30_000,
          );
          expect(next?.fence.epoch).toBe("2");
          await expect(
            generation.dispatch(() => Promise.resolve()),
          ).rejects.toBeInstanceOf(AgentOwnershipLostError);
          expect(await fixture.origin(input.runId)).toMatchObject({
            execution_owner_incarnation_id: owner.incarnation_id,
            execution_owner_epoch: "1",
          });
          if (next !== null) await fixture.leasesB.release(next.fence);
        } finally {
          await manager.drain();
        }
      });
    });

    it("joins a real Session-lock-blocked acceptance before releasing the lease and preserves its original commit", async () => {
      await withDatabase(async (fixture) => {
        const session = await fixture.session(scope("generation-held-sql"));
        const owner = registration();
        const manager = new AgentGenerations<Repositories>({
          registration: owner,
          leases: fixture.leasesA,
        });
        try {
          const generation = await manager.prepare(
            session.binding,
            (generation) =>
              Promise.resolve(
                createOwnedRunRepositories(
                  fixture.kernelA,
                  generation.authority,
                ),
              ),
          );
          const input = fixture.input(session);
          await generation.dispatch((repositories) =>
            repositories.runs.createRunIntent(input),
          );
          const origin = await fixture.origin(input.runId);
          const held = await fixture.holdSession(session.sessionId);
          const original = generation.dispatch((repositories) =>
            repositories.runs.acceptRun(
              fixture.acceptance(session, input.runId),
            ),
          );
          const denied = fixture.observe(
            expect(original).rejects.toBeInstanceOf(AgentOwnershipLostError),
          );
          let stopped: Promise<void> | undefined;
          try {
            await fixture.waitForBlockedWriter();
            let closed = false;
            stopped = manager.closeScope(session.binding).then(() => {
              closed = true;
            });
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(generation.signal.aborted).toBe(true);
            expect(closed).toBe(false);
            const live = await fixture.leasesB.read(session.binding);
            expect(live?.fence).toEqual(generation.authority.fence);
            expect(live !== null && live.expiresAt > live.observedAt).toBe(
              true,
            );
            expect(
              (
                await fixture.observer.query(
                  "SELECT state FROM runs WHERE id=$1",
                  [input.runId],
                )
              ).rows,
            ).toEqual([{ state: "admitting" }]);
            await fixture.release(held);
            await denied;
            await stopped;
            // The original transaction already held the lease lock. Its commit is
            // valid; local cancellation does not undo that database linearization.
            expect(
              (
                await fixture.observer.query(
                  "SELECT state FROM runs WHERE id=$1",
                  [input.runId],
                )
              ).rows,
            ).toEqual([{ state: "running" }]);
            expect(await fixture.origin(input.runId)).toEqual(origin);
            const released = await fixture.leasesB.read(session.binding);
            expect(
              released !== null && released.expiresAt <= released.observedAt,
            ).toBe(true);
          } finally {
            await fixture.release(held);
            await Promise.allSettled([original, denied]);
            await stopped;
            await manager.drain();
          }
        } finally {
          await manager.drain();
        }
      });
    });
  },
);
