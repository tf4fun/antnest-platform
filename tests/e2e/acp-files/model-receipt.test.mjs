import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import * as model from "./model.mjs";

function payload(phase) {
  const item = model.caseFor(phase);
  const toolCallId = createHash("sha256")
    .update(JSON.stringify([`fixture-run:${phase}`, 0, phase]))
    .digest("hex");
  return {
    stream: true,
    tools: ["read", "write", "edit"].map((name) => ({ function: { name } })),
    messages: [
      { role: "user", content: phase },
      {
        role: "assistant",
        tool_calls: [
          {
            id: toolCallId,
            type: "function",
            function: { name: item.tool, arguments: JSON.stringify(item.args) },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: toolCallId,
        content: JSON.stringify(item.result),
      },
    ],
  };
}
function observe(value) {
  assert.equal(typeof model.observeFileModelRequest, "function");
  return model.observeFileModelRequest(value);
}
for (const version of [1, 2])
  for (const item of model.cases)
    test(
      "Files model archives its original parsed " +
        version +
        " " +
        item.id +
        " result",
      () => {
        const phase = "v" + version + "-" + item.id;
        const input = payload(phase);
        const before = structuredClone(input);
        const observation = observe(input);
        assert.deepEqual(observation.tool_result, {
          tool_call_id: input.messages[2].tool_call_id,
          tool: item.tool,
          result: JSON.parse(input.messages[2].content),
        });
        assert.equal(observation.text, phase + " verified");
        assert.deepEqual(input, before);
        const first = { ...input, messages: input.messages.slice(0, 1) };
        assert.equal(observe(first).tool_result, undefined);
        assert.deepEqual(observe(first).call, {
          name: item.tool,
          arguments: item.args,
        });
      },
    );
for (const [name, mutate] of [
  [
    "unnormalized provider ID",
    (p) => {
      p.messages[1].tool_calls[0].id = "v1-read";
      p.messages[2].tool_call_id = "v1-read";
    },
  ],
  ["missing call", (p) => p.messages.splice(1, 1)],
  [
    "duplicate call",
    (p) =>
      p.messages[1].tool_calls.push(
        structuredClone(p.messages[1].tool_calls[0]),
      ),
  ],
  [
    "foreign original call ID",
    (p) => {
      p.messages[1].tool_calls[0].id = "foreign";
    },
  ],
  [
    "foreign original result ID",
    (p) => {
      p.messages[2].tool_call_id = "foreign";
    },
  ],
  [
    "another tool",
    (p) => {
      p.messages[1].tool_calls[0].function.name = "write";
    },
  ],
  [
    "another input path",
    (p) => {
      p.messages[1].tool_calls[0].function.arguments = '{"path":"foreign"}';
    },
  ],
  [
    "result before original call",
    (p) => {
      [p.messages[1], p.messages[2]] = [p.messages[2], p.messages[1]];
    },
  ],
])
  test("Files actual model receipt rejects " + name, () => {
    const p = payload("v1-read");
    observe(p);
    mutate(p);
    assert.throws(() => observe(p));
  });
test("Files model result archive preserves actual extra fields instead of rebuilding the oracle", () => {
  const p = payload("v2-read");
  const result = JSON.parse(p.messages[2].content);
  result.observation_marker = "original-model-result";
  p.messages[2].content = JSON.stringify(result);
  const actual = observe(p);
  assert.deepEqual(actual.tool_result.result, result);
  result.content = "later mutation";
  assert.notEqual(actual.tool_result.result.content, result.content);
});
