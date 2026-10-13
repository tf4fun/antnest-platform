import assert from "node:assert/strict";
import test from "node:test";
import { withPasswordHolder } from "./password-pressure.mjs";

function fixture(overrides = {}) {
  const holder = Promise.withResolvers();
  const target = Promise.withResolvers();
  const events = [];
  const options = {
    timeoutMS: 1000,
    throttle: async () => {
      events.push("throttle");
    },
    start: async () => {
      events.push("start");
      await holder.promise;
      events.push("holder-joined");
    },
    exercise: async (assertHeld) => {
      assertHeld();
      events.push("target");
      return "receipt";
    },
    restore: async () => {
      events.push("restore");
      holder.resolve();
      target.resolve();
    },
    drain: async () => {
      assert(events.includes("holder-joined"));
      events.push("server-drained");
    },
    ...overrides,
  };
  return { holder, target, events, options };
}

test("one real holder stays pending until CPU restoration, then both HTTP and server join", async () => {
  const f = fixture();
  assert.equal(await withPasswordHolder(f.options), "receipt");
  assert.deepEqual(f.events, [
    "throttle",
    "start",
    "target",
    "restore",
    "holder-joined",
    "server-drained",
  ]);
});

test("a phase deadline restores CPU while target and noninterruptible holder are still pending", async () => {
  const f = fixture({ timeoutMS: 10 });
  f.options.exercise = async (assertHeld) => {
    f.events.push("target");
    await f.target.promise;
    assertHeld();
  };
  await assert.rejects(withPasswordHolder(f.options), /holder phase failed/u);
  assert.equal(f.events.filter((s) => s === "start").length, 1);
  assert.equal(f.events.filter((s) => s === "restore").length, 1);
  assert.equal(f.events.at(-1), "server-drained");
});

test("caller cancellation restores CPU before joining existing work and prevents later targets", async () => {
  const controller = new AbortController();
  const f = fixture({ signal: controller.signal });
  f.options.exercise = async (assertHeld) => {
    controller.abort(new Error("caller cancelled"));
    await f.target.promise;
    assertHeld();
    f.events.push("forbidden-target");
  };
  await assert.rejects(withPasswordHolder(f.options), (error) =>
    error.errors.some((cause) => cause.message === "caller cancelled"),
  );
  assert(!f.events.includes("forbidden-target"));
  assert.equal(f.events.at(-1), "server-drained");
});

test("a completed holder cannot be treated as continuing pressure or restarted", async () => {
  const f = fixture();
  f.holder.resolve();
  f.options.exercise = async (assertHeld) => {
    await new Promise((resolve) => setImmediate(resolve));
    assertHeld();
    f.events.push("forbidden-target");
  };
  await assert.rejects(withPasswordHolder(f.options), /holder phase failed/u);
  assert(!f.events.includes("forbidden-target"));
  assert.equal(f.events.filter((s) => s === "start").length, 1);
  assert.equal(f.events.at(-1), "server-drained");
});

test("target and restore errors both survive cleanup and actual server join", async () => {
  const targetError = new Error("target failure"),
    restoreError = new Error("restore failure");
  const f = fixture();
  f.options.exercise = async () => {
    throw targetError;
  };
  f.options.restore = async () => {
    f.holder.resolve();
    throw restoreError;
  };
  await assert.rejects(
    withPasswordHolder(f.options),
    (error) =>
      error.errors.includes(targetError) && error.errors.includes(restoreError),
  );
  assert.equal(f.events.at(-1), "server-drained");
});

test("failed CPU setup still restores the original quota without starting a holder", async () => {
  const f = fixture({
    throttle: async () => {
      throw new Error("partial update");
    },
    drain: async () => {},
  });
  await assert.rejects(withPasswordHolder(f.options), /holder phase failed/u);
  assert.deepEqual(f.events, ["restore"]);
});

test("an HTTP result is insufficient when the actual server transaction did not drain", async () => {
  const failure = new Error("server still active");
  const f = fixture({
    drain: async () => {
      throw failure;
    },
  });
  await assert.rejects(withPasswordHolder(f.options), (error) =>
    error.errors.includes(failure),
  );
  assert.equal(f.events.at(-1), "holder-joined");
});

test("completion after a blocked event loop deadline cannot bypass the timer", async () => {
  const f = fixture({ timeoutMS: 5 });
  f.options.exercise = async () => {
    const end = performance.now() + 15;
    while (performance.now() < end) {
      /* Hold the event loop past the deadline. */
    }
  };
  await assert.rejects(withPasswordHolder(f.options), /holder phase failed/u);
  assert.equal(f.events.at(-1), "server-drained");
});
