import assert from "node:assert/strict";
import test from "node:test";
const url = new URL("./stage2-step.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
test("Stage2 always joins recovery and retains the original business and cleanup errors", async () => {
  assert.equal(typeof implementation.stage2Step, "function");
  const primary = new Error("original business"),
    cleanup = new Error("original recovery");
  for (const [businessFails, cleanupFails] of [
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ]) {
    const events = [];
    const operation = implementation.stage2Step(
      async () => {
        events.push("business");
        if (businessFails) throw primary;
        return 17;
      },
      async () => {
        events.push("cleanup-start");
        await Promise.resolve();
        events.push("cleanup-end");
        if (cleanupFails) throw cleanup;
      },
    );
    if (!businessFails && !cleanupFails) assert.equal(await operation, 17);
    else
      await assert.rejects(operation, (error) => {
        if (businessFails && cleanupFails)
          assert.deepEqual(error.errors, [primary, cleanup]);
        else assert.equal(error, businessFails ? primary : cleanup);
        return true;
      });
    assert.deepEqual(events, ["business", "cleanup-start", "cleanup-end"]);
  }
});
