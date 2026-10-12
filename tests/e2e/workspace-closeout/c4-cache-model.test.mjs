import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createC4Model, decide } from "./c4-model.mjs";
import { note } from "./browser-model.mjs";

const phase = "c4-cache-outage";
const text = `${phase}: fresh output before cancellation.`;
const call = {
  name: "read",
  arguments: { path: ".c4-browser-note", offset: 1, limit: 4096 },
};
const payload = () => ({
  model: "stage3-model",
  messages: [{ role: "user", content: phase }],
  tools: [{ function: { name: "read" } }],
});
function afterRead() {
  const value = payload();
  value.messages.push(
    {
      role: "assistant",
      content: text,
      tool_calls: [
        {
          id: "b".repeat(64),
          type: "function",
          function: {
            name: call.name,
            arguments: JSON.stringify(call.arguments),
          },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "b".repeat(64),
      content: JSON.stringify({ content: note, effect_state: "settled" }),
    },
  );
  return value;
}

test("cache outage emits fresh text plus a real read and holds the following model request", () => {
  assert.deepEqual(decide(payload()), { phase, hold: true, text, call });
  const second = decide(afterRead());
  assert.equal(second.phase, phase);
  assert.equal(second.hold, true);
  assert.equal(second.call, undefined);
  for (const mutate of [
    (value) => {
      value.messages[1].content = "missing fresh output";
    },
    (value) => {
      value.messages[2].content = JSON.stringify({
        content: "wrong",
        effect_state: "settled",
      });
    },
    (value) => {
      value.messages[2].content = JSON.stringify({
        content: note,
        effect_state: "unknown",
      });
    },
    (value) => {
      value.messages[2].tool_call_id = "c".repeat(64);
    },
  ]) {
    const value = afterRead();
    mutate(value);
    assert.throws(() => decide(value));
  }
});

test("a released first response cannot erase or relabel the same phase's second held request", async (t) => {
  const server = createC4Model();
  const abort = new AbortController(),
    pendingRequests = [];
  let deferredClose, restoreClose;
  // Delay only the old response's close notification to reproduce its overlap
  // with a later request. Both requests and cancellation still use real HTTP.
  server.on("request", (request, response) => {
    if (request.headers.traceparent?.includes("-1111111111111111-")) {
      const emit = response.emit;
      restoreClose = () => {
        response.emit = emit;
      };
      response.emit = function (event, ...args) {
        if (event === "close") {
          deferredClose = () => Reflect.apply(emit, response, [event, ...args]);
          return true;
        }
        return Reflect.apply(emit, response, [event, ...args]);
      };
    }
  });
  t.after(async () => {
    restoreClose?.();
    deferredClose?.();
    abort.abort();
    server.closeAllConnections();
    await Promise.allSettled(pendingRequests);
    await new Promise((resolve) => server.close(resolve));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const status = async () => (await fetch(base + "/status")).json();
  const wait = async (check) => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const value = await check();
      if (value) return value;
      await delay(5);
    }
    assert.fail("controlled model observation timed out");
  };
  const send = (body, span) => {
    const result = fetch(base + "/v1/chat/completions", {
      method: "POST",
      signal: abort.signal,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer stage3-model-secret",
        traceparent: `00-${"a".repeat(32)}-${span}-01`,
      },
      body: JSON.stringify(body),
    }).then(
      async (response) => ({
        status: response.status,
        body: await response.json(),
      }),
      (error) => ({ error }),
    );
    pendingRequests.push(result);
    return result;
  };
  const first = send(payload(), "1".repeat(16));
  await wait(async () => (await status()).pending.includes(phase));
  const releasedAt = Date.now();
  const release = await fetch(base + `/release/${phase}`, { method: "POST" });
  assert.equal(release.status, 200);
  await release.arrayBuffer();
  const reply = await first;
  assert.equal(reply.status, 200);
  assert.equal(reply.body.choices[0].message.content, text);
  assert.equal(
    reply.body.choices[0].message.tool_calls[0].function.name,
    "read",
  );
  await wait(() => deferredClose);
  const second = send(afterRead(), "2".repeat(16));
  await wait(async () => (await status()).requests.length === 2);
  deferredClose();
  deferredClose = undefined;
  restoreClose();
  const held = await status();
  assert.deepEqual(held.pending, [phase]);
  assert.equal(held.requests[0].disconnected, undefined);
  assert(held.requests[0].released_at_ms >= releasedAt);
  assert.equal(held.requests[1].stage, "reply");
  assert.equal(held.requests[1].model_span_id, "2".repeat(16));
  assert.equal(held.requests[1].released_at_ms, undefined);
  const cancelledAt = Date.now();
  abort.abort();
  assert.equal((await second).error.name, "AbortError");
  await wait(async () => (await status()).requests[1].disconnected === true);
  const final = await status();
  assert.deepEqual(final.pending, []);
  assert.deepEqual(final.errors, []);
  assert(final.requests[1].disconnected_at_ms >= cancelledAt);
  assert.equal(final.requests[0].disconnected, undefined);
});

test("a second model request cannot replace an unreleased or cancelled first stage", async (t) => {
  const server = createC4Model(),
    abort = new AbortController();
  let first;
  t.after(async () => {
    abort.abort();
    server.closeAllConnections();
    await first;
    await new Promise((resolve) => server.close(resolve));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const status = async () => (await fetch(base + "/status")).json();
  const send = (body, signal) =>
    fetch(base + "/v1/chat/completions", {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer stage3-model-secret",
        traceparent: `00-${"a".repeat(32)}-${"3".repeat(16)}-01`,
      },
      body: JSON.stringify(body),
    });
  first = send(payload(), abort.signal).catch((error) => error.name);
  for (let i = 0; i < 100 && !(await status()).pending.length; i++)
    await delay(5);
  assert.deepEqual((await status()).pending, [phase]);
  const tooEarly = await send(afterRead(), AbortSignal.timeout(1000));
  assert.equal(tooEarly.status, 400);
  await tooEarly.arrayBuffer();
  assert.equal((await status()).requests.length, 1);
  abort.abort();
  assert.equal(await first, "AbortError");
  for (let i = 0; i < 100 && !(await status()).requests[0].disconnected; i++)
    await delay(5);
  assert.equal((await status()).requests[0].disconnected, true);
  const tooLate = await send(afterRead(), AbortSignal.timeout(1000));
  assert.equal(tooLate.status, 400);
  await tooLate.arrayBuffer();
  const final = await status();
  assert.equal(final.requests.length, 1);
  assert.deepEqual(final.pending, []);
});
