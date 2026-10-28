import assert from "node:assert/strict";
import test from "node:test";
import { phaseTiming, readinessTiming, timingMarkdown } from "./timing.mjs";

test("phase and polling clocks preserve outcomes and keep overlapping observations separate", async () => {
  let now = 0;
  const clock = phaseTiming(() => now);
  const value = await clock.measure("ready", async () => {
    await clock.measure(
      "readySleep",
      async () => {
        now += 50;
      },
      "polls",
    );
    now += 10;
    return "original result";
  });
  assert.equal(value, "original result");
  now += 5;
  clock.finish();
  assert.equal(clock.values.phases.ready, 60);
  assert.deepEqual(clock.values.polls.readySleep, { ms: 50, count: 1 });
  assert.equal(clock.values.totalMs, 65);
  assert.equal(clock.values.unattributedMs, 5);
  assert.equal(clock.values.phases.create, null);
  const failure = new Error("original business failure");
  await assert.rejects(
    clock.measure("create", async () => {
      now += 3;
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.equal(clock.values.phases.create, 3);
});

test("diagnostic clock failures do not skip or replace business work", async () => {
  const clock = phaseTiming(() => {
    throw new Error("clock unavailable");
  });
  assert.equal(await clock.measure("prompt", async () => 42), 42);
  clock.finish();
  assert.equal(clock.values.totalMs, null);
  assert.equal(clock.values.phases.prompt, null);
});

test("public timing contains only allowlisted numbers, not round identities or payloads", () => {
  const secret = "secret-shaped-canary";
  const result = readinessTiming({
    rounds: [
      {
        index: 1,
        agentId: secret,
        round: {
          totalMs: 100,
          phases: { ready: 80, prompt: secret },
          polls: {},
        },
        publication: {
          delayStartedAt: 10,
          forwardedAt: 2010,
          upstreamCompletedAt: 2040,
          completedAt: 2041,
          secret,
        },
        host: {
          totalMs: 120,
          phases: { clientRound: 110, resourceCleanup: 5 },
        },
      },
    ],
    completed: 1,
    business: "failed",
    cleanup: "passed",
    cleanupMs: 10,
  });
  assert.equal(result.rounds[0].publication.injectedDelayMs, 2000);
  assert.equal(result.rounds[0].publication.upstreamRoundTripMs, 30);
  assert.equal(result.rounds[0].clientCommandOverheadMs.round, 10);
  assert.equal(result.rounds[0].round.phases.prompt, null);
  assert.equal(result.rounds[0].serviceWorkMs, null);
  assert.equal(result.business, "failed");
  assert.equal(result.cleanup, "passed");
  assert.equal(result.completed, 1);
  assert.equal(result.required, 100);
  assert(!JSON.stringify(result).includes(secret));
  assert(!timingMarkdown(result).includes(secret));
  assert.match(timingMarkdown(result), /overlap/);
});
