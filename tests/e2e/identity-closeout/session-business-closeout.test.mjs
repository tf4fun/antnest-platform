import assert from "node:assert/strict";
import test from "node:test";
import * as implementation from "./session-business-closeout.mjs";

test("Session business publication waits for actual cleanup and carries auxiliary warnings", async () => {
  assert.equal(typeof implementation.runSessionBusiness, "function");
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const events = [];
  const result = implementation.runSessionBusiness({
    run: async () => {
      events.push("business");
      return { model_requests: 8 };
    },
    cleanup: async () => {
      events.push("cleanup-start");
      await held;
      events.push("cleanup-joined");
      return { telemetry: { role: "auxiliary", status: "warning" } };
    },
    publish: async (business, cleanup) => {
      events.push("published");
      return { business, cleanup };
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["business", "cleanup-start"]);
  release();
  assert.deepEqual(await result, {
    business: { model_requests: 8 },
    cleanup: { telemetry: { role: "auxiliary", status: "warning" } },
  });
  assert.deepEqual(events, [
    "business",
    "cleanup-start",
    "cleanup-joined",
    "published",
  ]);
});

for (const phase of ["business", "cleanup", "archive"]) {
  test(`Session ${phase} failure cannot publish a successful result`, async () => {
    assert.equal(typeof implementation.runSessionBusiness, "function");
    const expected = new Error(phase);
    let joined = false,
      published = false;
    await assert.rejects(
      implementation.runSessionBusiness({
        run: async () => {
          if (phase === "business") throw expected;
          return {};
        },
        cleanup: async () => {
          joined = true;
          if (phase === "cleanup") throw expected;
          return {};
        },
        publish: async () => {
          if (phase === "archive") throw expected;
          published = true;
        },
      }),
      (error) => error === expected,
    );
    assert.equal(joined, true);
    assert.equal(published, false);
  });
}

test("Session retains both business and cleanup failures after joining", async () => {
  assert.equal(typeof implementation.runSessionBusiness, "function");
  const business = new Error("business"),
    cleanup = new Error("cleanup");
  await assert.rejects(
    implementation.runSessionBusiness({
      run: async () => {
        throw business;
      },
      cleanup: async () => {
        throw cleanup;
      },
      publish: () => assert.fail("unexecuted business must not pass"),
    }),
    (error) =>
      error instanceof AggregateError &&
      error.errors[0] === business &&
      error.errors[1] === cleanup,
  );
});

test("Session fault operations start asynchronously and retain successful result order", async () => {
  assert.equal(typeof implementation.joinSessionFaults, "function");
  let release, entered;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const events = [];
  const result = implementation.joinSessionFaults([
    async () => {
      events.push("first-started");
      await held;
      events.push("first-joined");
      return "first";
    },
    () => {
      events.push("second-started");
      entered();
      return "second";
    },
  ]);
  const joined = Promise.resolve(result).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  try {
    assert.deepEqual(events, []);
    await started;
    assert.deepEqual(events, ["first-started", "second-started"]);
    release();
    assert.deepEqual(await joined, { value: ["first", "second"] });
    assert.deepEqual(events, [
      "first-started",
      "second-started",
      "first-joined",
    ]);
  } finally {
    release();
    await joined;
  }
});

test("Session fault synchronous failure still starts every sibling and retains the original error", async () => {
  assert.equal(typeof implementation.joinSessionFaults, "function");
  const expected = new Error("synchronous fault");
  const started = [];
  await assert.rejects(
    async () =>
      implementation.joinSessionFaults([
        () => {
          started.push("failed");
          throw expected;
        },
        () => {
          started.push("sibling");
          return "joined";
        },
      ]),
    (error) => error === expected,
  );
  assert.deepEqual(started, ["failed", "sibling"]);
});

test("Session fault multiple failures retain every original error in operation order", async () => {
  assert.equal(typeof implementation.joinSessionFaults, "function");
  const first = new Error("first fault"),
    second = new Error("second fault");
  let siblingJoined = false;
  await assert.rejects(
    async () =>
      implementation.joinSessionFaults([
        async () => {
          await Promise.resolve();
          throw first;
        },
        () => {
          throw second;
        },
        async () => {
          await Promise.resolve();
          siblingJoined = true;
        },
      ]),
    (error) => {
      assert(error instanceof AggregateError);
      assert.equal(error.errors.length, 2);
      assert.equal(error.errors[0], first);
      assert.equal(error.errors[1], second);
      return true;
    },
  );
  assert.equal(siblingJoined, true);
});

test("Session fault failure joins a held sibling before business cleanup and never publishes", async () => {
  assert.equal(typeof implementation.joinSessionFaults, "function");
  const expected = new Error("fault failed");
  let release, entered;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const events = [];
  const result = implementation.runSessionBusiness({
    run: () =>
      implementation.joinSessionFaults([
        () => {
          events.push("fault-failed");
          return Promise.reject(expected);
        },
        async () => {
          events.push("sibling-started");
          entered();
          await held;
          events.push("sibling-joined");
        },
      ]),
    cleanup: async () => {
      events.push("cleanup-started");
      await Promise.resolve();
      events.push("cleanup-joined");
    },
    publish: () => {
      events.push("published");
    },
  });
  const joined = result.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  try {
    await started;
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ["fault-failed", "sibling-started"]);
    release();
    assert.equal((await joined).error, expected);
    assert.deepEqual(events, [
      "fault-failed",
      "sibling-started",
      "sibling-joined",
      "cleanup-started",
      "cleanup-joined",
    ]);
  } finally {
    release();
    await joined;
  }
});
