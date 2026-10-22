import assert from "node:assert/strict";
import test from "node:test";
const url = new URL("./work.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
const flatten = (error) =>
  error instanceof AggregateError ? error.errors.flatMap(flatten) : [error];
test(
  "Managed failure stops and joins v2 idle polling and retains cleanup failures",
  { timeout: 3000 },
  async () => {
    assert.equal(typeof implementation.createManagedWork, "function");
    const work = implementation.createManagedWork(),
      primary = new Error("primary"),
      close = new Error("close"),
      exporter = new Error("exporter");
    let probes = 0,
      stopped = false,
      shutdown = false;
    await assert.rejects(
      implementation.runManagedWork(
        work,
        new Set([
          {
            async closeAndWait() {
              stopped = work.signal.aborted;
              throw close;
            },
          },
        ]),
        {
          async shutdown() {
            shutdown = true;
            throw exporter;
          },
        },
        async () => {
          work.track(
            work.wait(
              () => {
                probes++;
                return false;
              },
              "v2 idle",
              120000,
            ),
          );
          throw primary;
        },
      ),
      (error) => {
        const errors = flatten(error);
        assert(errors.includes(primary));
        assert(errors.includes(close));
        assert(
          !errors.includes(exporter),
          "exporter diagnostics must not replace business cleanup failures",
        );
        assert(errors.includes(work.signal.reason));
        return true;
      },
    );
    assert.equal(stopped, true);
    assert.equal(shutdown, true);
    assert.equal(probes, 1);
    assert.equal(work.pending(), 0);
  },
);
test("Managed cleanup closes transport before joining an outstanding v1 request", async () => {
  assert.equal(typeof implementation.createManagedWork, "function");
  const work = implementation.createManagedWork(),
    request = Promise.withResolvers(),
    primary = new Error("primary"),
    closed = new Error("request closed");
  await assert.rejects(
    implementation.runManagedWork(
      work,
      new Set([
        {
          async closeAndWait() {
            request.reject(closed);
          },
        },
      ]),
      { async shutdown() {} },
      async () => {
        work.track(request.promise);
        throw primary;
      },
    ),
    (error) => {
      assert.deepEqual(flatten(error), [primary, closed]);
      return true;
    },
  );
  assert.equal(work.pending(), 0);
});
test("Managed normal completion returns only after joined work and exporter shutdown", async () => {
  assert.equal(typeof implementation.createManagedWork, "function");
  const work = implementation.createManagedWork();
  let shutdown = false;
  const value = await implementation.runManagedWork(
    work,
    new Set(),
    {
      async shutdown() {
        shutdown = true;
      },
    },
    async () => {
      assert.equal(
        await work.track(work.wait(() => "idle", "idle", 120000)),
        "idle",
      );
      return "complete";
    },
  );
  assert.equal(value, "complete");
  assert.equal(shutdown, true);
  assert.equal(work.pending(), 0);
});

test("Managed exporter rejection is archived as auxiliary after actual shutdown", async (t) => {
  const original = new Error("PRIVATE_MANAGED_EXPORTER_CANARY");
  const warnings = [];
  t.mock.method(console, "warn", (...args) => warnings.push(args.join(" ")));
  const observed = [];
  const work = implementation.createManagedWork();
  const result = await implementation.runManagedWork(
    work,
    new Set(),
    {
      async shutdown() {
        throw original;
      },
    },
    async () => "business completed",
    {
      traceDiagnostics: {
        async run(label, check) {
          assert.equal(label, "telemetry-shutdown");
          try {
            await check();
          } catch (error) {
            observed.push(error);
          }
          return { status: "failed" };
        },
      },
    },
  );
  assert.equal(result, "business completed");
  assert.deepEqual(observed, [original]);
  assert(warnings.length > 0);
  assert(!warnings.join("\n").includes("PRIVATE_MANAGED_EXPORTER_CANARY"));
  assert.equal(work.pending(), 0);
});

test(
  "Managed exhausted diagnostic budget cannot skip or abandon held exporter shutdown",
  { timeout: 3000 },
  async (t) => {
    t.mock.method(console, "warn", () => {});
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const original = new Error("exporter failed after joining");
    let settled = false;
    const task = implementation.runManagedWork(
      implementation.createManagedWork(),
      new Set(),
      {
        async shutdown() {
          entered.resolve();
          await release.promise;
          throw original;
        },
      },
      async () => "complete",
      {
        traceDiagnostics: {
          async run() {
            return { status: "not_collected" };
          },
        },
      },
    );
    void task.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      await entered.promise;
      await Promise.resolve();
      assert.equal(settled, false);
      release.resolve();
      assert.equal(await task, "complete");
    } finally {
      release.resolve();
      await Promise.allSettled([task]);
    }
  },
);

test("Managed diagnostic archive failure remains auxiliary and preserves original business error", async (t) => {
  t.mock.method(console, "warn", () => {});
  const business = new Error("business failed");
  const exporter = new Error("exporter failed");
  let archiveAttempted = false;
  await assert.rejects(
    implementation.runManagedWork(
      implementation.createManagedWork(),
      new Set(),
      {
        async shutdown() {
          throw exporter;
        },
      },
      async () => {
        throw business;
      },
      {
        traceDiagnostics: {
          async run() {
            archiveAttempted = true;
            throw new Error("archive unavailable");
          },
        },
      },
    ),
    (error) => error === business,
  );
  assert.equal(archiveAttempted, true);
});

test("Managed closes every real connection before exporter diagnostics and keeps close rejection fatal", async (t) => {
  t.mock.method(console, "warn", () => {});
  const order = [];
  const close = new Error("client close failed");
  const clients = new Set([
    {
      async closeAndWait() {
        order.push("first");
        throw close;
      },
    },
    {
      async closeAndWait() {
        order.push("second");
      },
    },
  ]);
  await assert.rejects(
    implementation.runManagedWork(
      implementation.createManagedWork(),
      clients,
      {
        async shutdown() {
          order.push("exporter");
          throw new Error("auxiliary");
        },
      },
      async () => "complete",
    ),
    (error) => error === close,
  );
  assert.deepEqual(order, ["first", "second", "exporter"]);
  assert.equal(clients.size, 0);
});
