import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { decide, createSessionModel } from "./acp-session-model.mjs";
import { assertStoredSessionEffects } from "./acp-session-effects.mjs";

function payload(phase, results = []) {
  return {
    messages: [
      { role: "tool", content: "previous-run" },
      { role: "user", content: phase },
      ...results.map((content) => ({ role: "tool", content })),
    ],
    tools: [{ function: { name: "bash" } }],
  };
}

function bashResult(phase, overrides = {}) {
  const phases = ["v1-admitted", "v1-recovered", "v2-admitted", "v2-recovered"];
  return JSON.stringify({
    exit_code: 0,
    stdout: phases.slice(0, phases.indexOf(phase) + 1).join("\n") + "\n",
    stderr: "",
    truncated: false,
    effect_state: "settled",
    ...overrides,
  });
}

test("only admitted first requests wait; recovery and real Tool results progress", () => {
  for (const version of [1, 2]) {
    const phase = `v${version}-admitted`;
    const first = decide(payload(phase));
    assert.equal(first.hold, true);
    assert.equal(first.call.name, "bash");
    assert(
      first.call.arguments.command.includes(
        ">> /workspace/session-effects.log",
      ),
    );
    assert.equal(
      decide(payload(phase, [bashResult(phase)])).text,
      `${phase} verified`,
    );
    assert.equal(decide(payload(`v${version}-recovered`)).hold, false);
  }
});

test("Tool evidence requires successful Bash stdout, not a marker in arbitrary text", () => {
  const phase = "v1-admitted";
  for (const result of [
    "error: v1-admitted was not executed",
    bashResult(phase, { exit_code: 1 }),
    bashResult(phase, { stdout: "", stderr: `${phase}\n` }),
    bashResult(phase, { stdout: `error: ${phase} was not executed\n` }),
    bashResult(phase, { stdout: `${phase}\n${phase}\n` }),
    bashResult(phase, { stdout: `${phase}\\n` }),
    bashResult(phase, { stdout: undefined }),
    bashResult(phase, { truncated: true }),
    bashResult(phase, { effect_state: "unknown" }),
  ])
    assert.throws(() => decide(payload(phase, [result])));
});

test("persisted Tool evidence must contain one structured successful result", () => {
  const phase = "v1-recovered";
  const block = { type: "text", text: bashResult(phase) };
  assertStoredSessionEffects([block], phase);
  for (const blocks of [
    null,
    [],
    [block, block],
    [{ ...block, type: "image" }],
    [{ type: "text", text: "error: v1-recovered was not executed" }],
    [{ type: "text", text: bashResult(phase, { exit_code: 1 }) }],
    [{ type: "text", text: bashResult("v1-admitted") }],
  ])
    assert.throws(() => assertStoredSessionEffects(blocks, phase));
});

test("model fixture rejects unintended prompts, absent tools and duplicate effects", () => {
  for (const input of [
    payload("revoked-must-not-run"),
    payload("v1-admitted", ["wrong"]),
    payload("v1-admitted", ["v1-admitted v1-admitted"]),
    payload("v1-admitted", ["one", "two"]),
    { ...payload("v1-admitted"), tools: [] },
  ])
    assert.throws(() => decide(input));
});

test("HTTP barrier must be observed, explicitly released once, and rejects replay", async (t) => {
  const server = createSessionModel().listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const base = `http://127.0.0.1:${server.address().port}`;
  const options = {
    method: "POST",
    signal: AbortSignal.timeout(3000),
    headers: {
      "content-type": "application/json",
      authorization: "Bearer acp-session-model",
      traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
    },
    body: JSON.stringify(payload("v1-admitted")),
  };
  const pending = fetch(`${base}/v1/chat/completions`, options);
  let held = false;
  for (let i = 0; i < 100; i++) {
    const state = await (await fetch(`${base}/status`)).json();
    held = state.held.includes("v1-admitted");
    if (held) break;
    await delay(5);
  }
  assert(held, "request was not held");
  assert.equal(
    (await fetch(`${base}/release/v1-admitted`, { method: "POST" })).status,
    200,
  );
  const result = await (await pending).json();
  assert.equal(result.choices[0].message.tool_calls[0].function.name, "bash");
  assert.equal(
    (await fetch(`${base}/release/v1-admitted`, { method: "POST" })).status,
    409,
  );
  assert.equal(
    (await fetch(`${base}/v1/chat/completions`, options)).status,
    400,
  );
});
