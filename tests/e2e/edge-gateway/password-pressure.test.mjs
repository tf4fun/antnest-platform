import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { startPasswordPressure } from "./password-pressure.mjs";

test("pressure bounds active requests and stop joins every started request", async () => {
  const gates = [],
    launched = Promise.withResolvers();
  const pressure = startPasswordPressure({
    concurrency: 3,
    maximum: 100,
    intervalMS: 1,
    timeoutMS: 1000,
    run: async () => {
      const gate = Promise.withResolvers();
      gates.push(gate);
      if (gates.length === 3) launched.resolve();
      await gate.promise;
    },
  });
  await launched.promise;
  assert.equal(gates.length, 3);
  let closed = false;
  const stopped = pressure.stop().then(() => {
    closed = true;
  });
  await Promise.resolve();
  assert.equal(closed, false);
  gates.forEach((gate) => gate.resolve());
  await stopped;
  assert.deepEqual(pressure.state(), {
    started: 3,
    peak: 3,
    active: 0,
    stopped: true,
    exhausted: false,
  });
});

test("one failed pressure request still joins its pending siblings", async () => {
  const gate = Promise.withResolvers(),
    entered = Promise.withResolvers();
  const pressure = startPasswordPressure({
    concurrency: 2,
    maximum: 100,
    intervalMS: 1,
    timeoutMS: 1000,
    run: async (index) => {
      if (index === 0) {
        await entered.promise;
        throw new Error("controlled request failure");
      }
      entered.resolve();
      await gate.promise;
    },
  });
  await entered.promise;
  await Promise.resolve();
  let finished = false;
  const close = pressure.stop().catch((error) => {
    finished = true;
    assert(
      error.errors.some((e) => e.message === "controlled request failure"),
    );
  });
  await Promise.resolve();
  assert.equal(finished, false);
  gate.resolve();
  await close;
  assert.equal(finished, true);
  assert.equal(pressure.state().active, 0);
});

test("exhausting the fixed request budget fails instead of silently draining before targets", async () => {
  const pressure = startPasswordPressure({
    concurrency: 2,
    maximum: 3,
    intervalMS: 0,
    timeoutMS: 1000,
    run: async () => {},
  });
  await pressure.completed;
  await assert.rejects(pressure.stop(), /pressure/i);
  assert.equal(pressure.state().started, 3);
  assert.equal(pressure.state().exhausted, true);
});

test("stop retains an AbortError from an already-started request", async () => {
  const gate = Promise.withResolvers();
  const failure = new DOMException(
    "request aborted independently",
    "AbortError",
  );
  const pressure = startPasswordPressure({
    concurrency: 1,
    run: () => gate.promise,
  });
  const stopped = pressure.stop();
  gate.reject(failure);
  await assert.rejects(stopped, (error) => error.errors.includes(failure));
  assert.equal(pressure.state().active, 0);
});

test("the time budget expires while requests are held and still joins them", async () => {
  const gate = Promise.withResolvers();
  const pressure = startPasswordPressure({
    concurrency: 1,
    timeoutMS: 10,
    run: () => gate.promise,
  });
  await delay(25);
  const stopped = pressure.stop();
  gate.resolve();
  await assert.rejects(stopped, /pressure/i);
  assert.equal(pressure.state().exhausted, true);
  assert.equal(pressure.state().active, 0);
});

test("stop observes an elapsed budget before the deadline timer can run", async () => {
  const gate = Promise.withResolvers();
  const pressure = startPasswordPressure({
    concurrency: 1,
    timeoutMS: 2,
    run: () => gate.promise,
  });
  const started = performance.now();
  while (performance.now() - started < 10) {
    // Hold this call stack so the timer cannot classify the elapsed deadline.
  }
  const stopped = pressure.stop();
  gate.resolve();
  await assert.rejects(stopped, /pressure/i);
  assert.equal(pressure.state().exhausted, true);
  assert.equal(pressure.state().active, 0);
});
