import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { shutdownInterruption } from "./shutdown-interruption.mjs";

function fixture() {
  const emitter = new EventEmitter();
  let deadline,
    cleared = false;
  const lifecycle = shutdownInterruption({
    emitter,
    setTimer(callback, milliseconds) {
      assert.equal(milliseconds, 180000);
      deadline = callback;
      return 7;
    },
    clearTimer(timer) {
      assert.equal(timer, 7);
      cleared = true;
    },
  });
  return {
    lifecycle,
    emitter,
    deadline: () => deadline(),
    cleared: () => cleared,
  };
}

for (const event of ["SIGINT", "SIGTERM", "deadline"])
  for (const phase of ["measurement", "cleanup"])
    test(`${event} during ${phase} stays a failure after cleanup joins`, () => {
      const f = fixture();
      if (phase === "cleanup") f.lifecycle.beginCleanup();
      if (event === "deadline") f.deadline();
      else f.emitter.emit(event);
      f.lifecycle.beginCleanup();
      assert.equal(f.lifecycle.signal.aborted, true);
      assert.match(f.lifecycle.finish()?.message ?? "", /interrupted/);
      assert.equal(f.cleared(), true);
      assert.equal(f.emitter.listenerCount("SIGINT"), 0);
      assert.equal(f.emitter.listenerCount("SIGTERM"), 0);
    });

test("normal cleanup abort does not become an external interruption", () => {
  const f = fixture();
  f.lifecycle.beginCleanup();
  assert.equal(f.lifecycle.signal.aborted, true);
  assert.equal(f.lifecycle.finish(), undefined);
  assert.equal(f.cleared(), true);
});

test("cleanup and external interruption failures are both preserved", () => {
  const f = fixture();
  const error = new Error("owned container removal failed");
  f.lifecycle.beginCleanup();
  f.emitter.emit("SIGTERM");
  const result = f.lifecycle.finish(error);
  assert(result instanceof AggregateError);
  assert.equal(result.errors[0], error);
  assert.match(result.errors[1].message, /interrupted/);
});

test("failure without interruption retains the original error", () => {
  const f = fixture();
  const error = new Error("wrong process identity");
  f.lifecycle.beginCleanup();
  assert.equal(f.lifecycle.finish(error), error);
});
