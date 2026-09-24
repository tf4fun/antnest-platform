import assert from "node:assert/strict";
import { test } from "node:test";
import { startWorkspaceService } from "../src/service-lifecycle.ts";

test("standalone Node service sweeps idle owners and stops its timer on close", async () => {
  let sweeps = 0;
  let handled = 0;
  let drainTimeout: number | undefined;
  const service = await startWorkspaceService({
    runtime: {
      async handle() {
        handled += 1;
        return null;
      },
      async sweep() {
        sweeps += 1;
      },
      async drain(timeoutMs) {
        drainTimeout = timeoutMs;
        return { forced: false };
      },
    },
    host: "127.0.0.1",
    port: 0,
    sweepIntervalMs: 5,
  });
  try {
    const response = await fetch(`http://127.0.0.1:${service.port}/status`);
    assert.equal(response.status, 200);
    assert.equal(handled, 0);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(sweeps > 0);
  } finally {
    await service.close();
  }
  const stoppedAt = sweeps;
  assert.equal(drainTimeout, 15_000);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sweeps, stoppedAt);
});

test("Bridge drain stops admitting requests while liveness remains available", async () => {
  let releaseDrain!: () => void;
  let drainStarted!: () => void;
  const started = new Promise<void>((resolve) => { drainStarted = resolve; });
  const draining = new Promise<void>((resolve) => { releaseDrain = resolve; });
  let handled = 0;
  const service = await startWorkspaceService({
    runtime: {
      async handle() { handled++; return Response.json({ ok: true }); },
      async sweep() {},
      async drain() { drainStarted(); await draining; return { forced: false }; },
    },
    host: "127.0.0.1",
    port: 0,
  });
  const base = `http://127.0.0.1:${service.port}`;
  try {
    assert.equal((await fetch(`${base}/status`)).status, 200);
    assert.equal((await fetch(`${base}/live`)).status, 200);
    const closing = service.close();
    await started;
    const readiness = await fetch(`${base}/status`);
    assert.equal(readiness.status, 503);
    assert.equal((await readiness.json()).status, "draining");
    assert.equal((await fetch(`${base}/live`)).status, 200);
    assert.equal((await fetch(`${base}/api/app/workspace/v1/bootstrap`)).status, 503);
    assert.equal(handled, 0);
    releaseDrain();
    await closing;
  } finally {
    releaseDrain();
    await service.close();
  }
});
