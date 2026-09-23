import assert from "node:assert/strict";
import test from "node:test";
import { decide } from "./model.mjs";

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
  assert.equal(result.call.arguments.path.path, ".c3-run-effects");
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
