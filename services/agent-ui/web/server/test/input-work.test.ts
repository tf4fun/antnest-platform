import assert from "node:assert/strict";
import { test } from "node:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { setImmediate as turn } from "node:timers/promises";
import { runInputWork } from "../src/http/input-work.ts";

test("large input work admits ready I/O between consecutive synchronous preparations", async () => {
  const events: string[] = [];
  const first = runInputWork(() => {
    events.push("first");
    setImmediate(() => events.push("control"));
    return 1;
  });
  const second = runInputWork(() => { events.push("second"); return 2; });
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.deepEqual(events, ["first", "control", "second"]);
});
test("queued input preserves each request's async context", async () => {
  const context = new AsyncLocalStorage<string>();
  const results = await Promise.all(["owner-a", "owner-b"].map((owner) =>
    context.run(owner, () => runInputWork(() => context.getStore()))));
  assert.deepEqual(results, ["owner-a", "owner-b"]);
});
test("an aborted queued request does no work and cannot stall later requests", async () => {
  const abort = new AbortController(), reason = new Error("original disconnect");
  let visited = false;
  const first = runInputWork(() => abort.abort(reason));
  const cancelled = runInputWork(() => { visited = true; }, abort.signal);
  const following = runInputWork(() => "following");
  const results = await Promise.allSettled([first, cancelled, following]);
  assert.equal(visited, false);
  assert.equal(results[1].status, "rejected");
  assert.equal((results[1] as PromiseRejectedResult).reason, reason);
  assert.deepEqual(results[2], { status: "fulfilled", value: "following" });
});
test("a synchronous validation failure retains its identity and releases the queue", async () => {
  const reason = new SyntaxError("original parse failure");
  const failed = runInputWork(() => { throw reason; });
  const following = runInputWork(() => 42);
  const results = await Promise.allSettled([failed, following]);
  assert.deepEqual(results, [{ status: "rejected", reason }, { status: "fulfilled", value: 42 }]);
});

test("an asynchronous preparation retains the queue while control I/O proceeds", async () => {
  const gate = Promise.withResolvers<void>(), started = Promise.withResolvers<void>();
  const events: string[] = [];
  const context = new AsyncLocalStorage<string>();
  const first = context.run("upload", () => runInputWork(async () => {
    events.push("prepare"); started.resolve(); await gate.promise;
    assert.equal(context.getStore(), "upload"); events.push("commit"); return 1;
  }));
  const following = runInputWork(() => { events.push("next"); return 2; });
  try {
    await started.promise; await turn(); await turn(); events.push("control");
    assert.deepEqual(events, ["prepare", "control"]);
    gate.resolve(); assert.deepEqual(await Promise.all([first, following]), [1, 2]);
    assert.deepEqual(events, ["prepare", "control", "commit", "next"]);
  } finally { gate.resolve(); await Promise.allSettled([first, following]); }
});

test("an asynchronous rejection preserves the error and releases the next preparation", async () => {
  const reason = new Error("preparation aborted");
  const failed = runInputWork(async () => { await turn(); throw reason; });
  const following = runInputWork(() => "following");
  assert.deepEqual(await Promise.allSettled([failed, following]), [
    { status: "rejected", reason }, { status: "fulfilled", value: "following" },
  ]);
});
