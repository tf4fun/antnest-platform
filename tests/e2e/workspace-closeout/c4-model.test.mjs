import assert from "node:assert/strict";
import test from "node:test";
import { createC4Model, decide } from "./c4-model.mjs";
import { note } from "./browser-model.mjs";

const payload = (phase) => ({
  model: "stage3-model",
  messages: [{ role: "user", content: phase }],
  tools: [{ function: { name: "read" } }, { function: { name: "bash" } }],
});

test("C4 holds only named recovery phases and validates post-rebuild context", () => {
  assert.equal(decide(payload("c4-browser-hold-cancel")).hold, true);
  assert.equal(decide(payload("c4-browser-hold-offline")).hold, true);
  assert.equal(decide(payload("c4-browser-hold-close")).hold, true);
  assert.throws(() => decide(payload("c4-browser-hold-unknown")));
  assert.throws(() => decide(payload("c4-browser-after-rebuild")));
  const rebuilt = payload("c4-browser-after-rebuild");
  rebuilt.messages.unshift({
    role: "system",
    content: "isolated execution environment was rebuilt",
  });
  assert.equal(decide(rebuilt).call.name, "read");
});

test("C4 approval requires the actual retained file result", () => {
  const request = payload("c4-browser-approve");
  const { call } = decide(request);
  assert.equal(call.name, "read");
  request.messages.push(
    {
      role: "assistant",
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
  assert.match(decide(request).text, /verified/);
  request.messages.at(-1).content = JSON.stringify({
    content: "wrong",
    effect_state: "settled",
  });
  assert.throws(() => decide(request));
});

test("held model responses release once, disconnect cleanly and reject replay", async (t) => {
  const server = createC4Model();
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const status = async () => (await fetch(base + "/status")).json();
  const send = (phase, signal) =>
    fetch(base + "/v1/chat/completions", {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer stage3-model-secret",
        traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
      },
      body: JSON.stringify(payload(phase)),
    });
  const first = send("c4-browser-hold-offline");
  for (let i = 0; i < 100 && !(await status()).pending.length; i++)
    await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual((await status()).pending, ["c4-browser-hold-offline"]);
  assert.equal(
    (await fetch(base + "/release/c4-browser-hold-offline", { method: "POST" }))
      .status,
    200,
  );
  assert.match(
    (await (await first).json()).choices[0].message.content,
    /offline completed/,
  );
  assert.equal((await send("c4-browser-hold-offline")).status, 400);
  const abort = new AbortController();
  const stopped = send("c4-browser-hold-cancel", abort.signal).catch(
    (e) => e.name,
  );
  for (
    let i = 0;
    i < 100 && !(await status()).pending.includes("c4-browser-hold-cancel");
    i++
  )
    await new Promise((r) => setTimeout(r, 5));
  abort.abort();
  assert.equal(await stopped, "AbortError");
  for (let i = 0; i < 100 && (await status()).pending.length; i++)
    await new Promise((r) => setTimeout(r, 5));
  const final = await status();
  assert.deepEqual(final.pending, []);
  assert(
    final.requests.find((r) => r.phase === "c4-browser-hold-cancel")
      .disconnected,
  );
  assert.equal(final.requests.length, 2);
  assert.equal(final.errors.length, 1);
});
