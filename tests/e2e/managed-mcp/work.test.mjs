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
        assert(errors.includes(exporter));
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
