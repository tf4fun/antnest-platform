import assert from "node:assert/strict";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createSurvivorModel } from "./model.mjs";

const request = (phase, signal) => ({
  method: "POST",
  headers: {
    authorization: "Bearer stage3-model-secret",
    "content-type": "application/json",
  },
  body: JSON.stringify({
    model: "stage3-model",
    messages: [{ role: "user", content: phase }],
  }),
  signal,
});

async function withModel(work) {
  const server = createSurvivorModel();
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert(address && typeof address !== "string");
    await work(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    if (server.listening)
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
  }
}

async function status(base, signal = AbortSignal.timeout(2000)) {
  const response = await fetch(`${base}/status`, { signal });
  const body = await response.json();
  assert.equal(response.status, 200);
  return body;
}

async function waitForHeld(base, expected) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const body = await status(
      base,
      AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    );
    if (body.held === expected) return body;
    await delay(10);
  }
  throw new Error(`Model held state did not become ${String(expected)}`);
}

test("survivor business succeeds without Trace and retains its auxiliary diagnostic", async () => {
  await withModel(async (base) => {
    const phase = "survivor-a-before";
    const response = await fetch(
      `${base}/v1/chat/completions`,
      request(phase, AbortSignal.timeout(2000)),
    );
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.choices[0].finish_reason, "stop");
    assert.equal(body.choices[0].message.content, `${phase} completed`);
    const inventory = await status(base);
    assert.deepEqual(inventory.errors, []);
    assert.equal(inventory.requests.length, 1);
    assert.equal(inventory.requests[0].phase, phase);
    assert.equal(typeof inventory.requests[0].trace_diagnostic, "string");
    assert(inventory.requests[0].trace_diagnostic.length > 0);
    assert.equal(inventory.held, null);
  });
});

test("aborting the held original model request releases its response but never permits replay", async () => {
  await withModel(async (base) => {
    const phase = "survivor-b-held";
    const abort = new AbortController();
    let settled = false;
    const original = fetch(
      `${base}/v1/chat/completions`,
      request(phase, abort.signal),
    )
      .then(async (response) => ({
        status: response.status,
        body: await response.text(),
      }))
      .then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
    void original.then(() => {
      settled = true;
    });
    try {
      const held = await waitForHeld(base, phase);
      assert.deepEqual(held.errors, []);
      assert.equal(held.requests.length, 1);
      assert.equal(held.requests[0].phase, phase);
      assert.equal(
        settled,
        false,
        "the original HTTP response must remain held",
      );
      abort.abort();
      const outcome = await original;
      assert.equal(outcome.error?.name, "AbortError");
      const cancelled = await waitForHeld(base, null);
      assert.deepEqual(cancelled.errors, []);
      assert.equal(cancelled.requests.length, 1);
      const replay = await fetch(
        `${base}/v1/chat/completions`,
        request(phase, AbortSignal.timeout(2000)),
      );
      await replay.text();
      assert.equal(replay.status, 400);
      const rejected = await status(base);
      assert(rejected.errors.length > 0);
      assert.equal(rejected.requests.length, 1);
      assert.equal(rejected.held, null);
    } finally {
      abort.abort();
      await original;
    }
  });
});
