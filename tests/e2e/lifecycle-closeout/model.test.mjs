import assert from "node:assert/strict";
import test from "node:test";
import { createLifecycleModel, decide } from "./model.mjs";

function payload(phase, result) {
  const system =
    phase === "c3-held-run"
      ? "Synthetic lifecycle test"
      : "Revised immutable fixture. The isolated execution environment was rebuilt.";
  return {
    model: "stage3-model",
    tools: ["bash", "read"].map((name) => ({
      type: "function",
      function: { name },
    })),
    messages: [
      { role: "system", content: system },
      { role: "user", content: phase },
      ...(result === undefined ? [] : [{ role: "tool", content: result }]),
    ],
  };
}
test("held Run advertises a real bounded bash file barrier", () => {
  const result = decide(payload("c3-held-run"));
  assert.equal(result.call.name, "bash");
  assert.match(
    result.call.arguments.command,
    /while \[ ! -e \/workspace\/\.c3-run-release \]/,
  );
  assert.equal(result.call.arguments.timeout_ms, 120000);
  assert.equal(
    decide(payload("c3-held-run", "c3-held-complete")).text,
    "c3-held-run completed",
  );
});
test("new revision requires an environment notice and a real workspace read", () => {
  const result = decide(payload("c3-after-rebuild"));
  assert.equal(result.call.name, "read");
  assert.equal(result.call.arguments.path, ".c3-run-effects");
  assert.equal(
    decide(
      payload(
        "c3-after-rebuild",
        JSON.stringify({ content: "held\nfinished\n" }),
      ),
    ).text,
    "c3-after-rebuild completed",
  );
});
for (const [name, input] of [
  ["denied prompt leaked to model", payload("c3-denied")],
  [
    "stale configuration",
    {
      ...payload("c3-after-rebuild"),
      messages: payload("c3-after-rebuild").messages.slice(1),
    },
  ],
  [
    "duplicate physical effect",
    payload(
      "c3-after-rebuild",
      JSON.stringify({ content: "held\nheld\nfinished\n" }),
    ),
  ],
  [
    "old Run saw new config",
    {
      ...payload("c3-held-run"),
      messages: [
        { role: "system", content: "Revised immutable fixture" },
        ...payload("c3-held-run").messages.slice(1),
      ],
    },
  ],
  ["missing tools", { ...payload("c3-held-run"), tools: [] }],
  ["premature completion", payload("c3-held-run", "timeout")],
])
  test(`rejects model evidence: ${name}`, () =>
    assert.throws(() => decide(input)));

for (const [label, traceparent] of [
  ["with Trace", `00-${"a".repeat(32)}-${"b".repeat(16)}-01`],
  ["without Trace", undefined],
]) {
  test(`HTTP model records the first received time ${label} and preserves it across inventory reads`, async (t) => {
    const server = createLifecycleModel();
    t.after(async () => {
      server.closeAllConnections();
      if (server.listening)
        await new Promise((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    assert(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const before = Date.now();
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      signal: AbortSignal.timeout(5000),
      headers: {
        authorization: "Bearer stage3-model-secret",
        "content-type": "application/json",
        ...(traceparent === undefined ? {} : { traceparent }),
      },
      body: JSON.stringify(payload("c3-held-run")),
    });
    const completion = await response.json();
    const after = Date.now();
    assert.equal(response.status, 200);
    assert.equal(completion.choices[0].finish_reason, "tool_calls");
    assert.equal(
      completion.choices[0].message.tool_calls[0].function.name,
      "bash",
    );

    // Reading the inventory must not create or refresh the request timestamp.
    let readTime = after + 1000;
    t.mock.method(Date, "now", () => readTime);
    const state = async () => {
      const result = await fetch(`${base}/status`, {
        signal: AbortSignal.timeout(5000),
      });
      const body = await result.json();
      assert.equal(result.status, 200);
      assert.deepEqual(body.errors, []);
      return body;
    };
    const first = await state();
    assert.equal(first.requests.length, 1);
    const row = first.requests[0];
    assert.equal(row.phase, "c3-held-run");
    assert.equal(row.stage, "tool");
    assert(Number.isFinite(row.received_at_ms));
    assert(row.received_at_ms >= 0);
    assert(
      row.received_at_ms >= before && row.received_at_ms <= after,
      "received_at_ms must record the original HTTP request time",
    );
    readTime += 1000;
    const repeated = await state();
    assert.equal(repeated.requests[0].received_at_ms, row.received_at_ms);
    assert.deepEqual(repeated.requests, first.requests);
  });
}
