import assert from "node:assert/strict";
import { test } from "node:test";
import { decide, encodeCompletion } from "./model.mjs";
import {
  assertEarly,
  assertTerminal,
  toolUpdates,
  terminalStatus,
  previewReceived,
} from "./evidence.mjs";

test("a command containing the marker is not an observed preview", () => {
  const frames = [update("start"), update("in_progress")];
  for (const frame of frames)
    frame.update.rawInput = { command: "echo partial" };
  assert.equal(previewReceived(frames, "partial"), false);
  assert.throws(() => assertEarly(frames, "partial"));
  frames.push(update("in_progress", "partial"));
  assert.equal(previewReceived(frames, "partial"), true);
});

const update = (status, text, id = "call") => ({
  update: {
    sessionUpdate: status === "start" ? "tool_call" : "tool_call_update",
    toolCallId: id,
    status: status === "start" ? "in_progress" : status,
    ...(text
      ? { content: [{ type: "content", content: { type: "text", text } }] }
      : {}),
  },
});
test("oracle requires real early content and one Tool identity", () => {
  assert.throws(() => assertEarly([update("start")], "partial"));
  assert.throws(() => assertEarly([update("completed", "partial")], "partial"));
  assert.throws(() =>
    assertEarly(
      [update("start"), update("in_progress", "partial", "other")],
      "partial",
    ),
  );
  assert.equal(
    assertEarly([update("start"), update("in_progress", "partial")], "partial"),
    "call",
  );
});
test("oracle rejects duplicate terminal, late preview and final-result pollution", () => {
  const valid = [
    update("start"),
    update("in_progress", "partial"),
    update("completed", "done"),
  ];
  assertTerminal(valid, "call", "completed");
  assert.throws(() =>
    assertTerminal(
      [...valid, update("completed", "done")],
      "call",
      "completed",
    ),
  );
  assert.throws(() =>
    assertTerminal(
      [...valid, update("in_progress", "late")],
      "call",
      "completed",
    ),
  );
  assert.equal(toolUpdates(valid).length, 3);
});
function payload(phase, results = []) {
  return {
    stream: true,
    tools: ["bash", "mcp__fixture__progress"].map((name) => ({
      function: { name },
    })),
    messages: [
      { role: "user", content: phase },
      ...results.map((content) => ({ role: "tool", content })),
    ],
  };
}
test("model requests actual tools and validates returned results instead of unconditional success", () => {
  for (const version of [1, 2])
    for (const source of ["bash", "managed"])
      for (const ending of ["success", "failure", "cancel"]) {
        const phase = `v${version}-${source}-${ending}`;
        const result = decide(payload(phase));
        assert.equal(
          result.call.name,
          source === "bash" ? "bash" : "mcp__fixture__progress",
        );
        assert.match(encodeCompletion(result), /tool_calls/);
      }
  assert.equal(
    decide(payload("v1-managed-success", ["done"])).text,
    "v1-managed-success verified",
  );
  assert.throws(() => decide(payload("v1-managed-success", ["wrong"])));
  assert.throws(() =>
    decide(payload("v1-managed-success", ["done progress-payload-canary"])),
  );
  assert.throws(() => decide(payload("v1-managed-success", ["done", "done"])));
  assert.throws(() => decide(payload("invalid")));
});

test("both protocol representations preserve early and terminal ordering", () => {
  const frames = [
    update("start"),
    update("in_progress", "partial"),
    update("failed", "error"),
  ];
  frames[0].update.sessionUpdate = "tool_call_update";
  assert.equal(assertEarly(frames.slice(0, 2), "partial"), "call");
  assertTerminal(frames, "call", "failed");
});

test("Tool cancellation mapping is separate from unresolved Run outcome", () => {
  for (const source of ["bash", "managed"]) {
    assert.equal(terminalStatus(1, source, "cancel"), "failed");
    assert.equal(terminalStatus(2, source, "cancel"), "cancelled");
  }
  assert.equal(terminalStatus(1, "bash", "failure"), "completed");
  assert.equal(terminalStatus(2, "managed", "failure"), "failed");
});

test("model rejects preview pollution in any message role", () => {
  for (const role of ["system", "assistant", "tool"]) {
    const value = payload("v1-managed-success", ["done"]);
    value.messages.unshift({ role, content: "progress-payload-canary" });
    assert.throws(() => decide(value), /progress polluted/);
  }
});

test("nonzero Bash exit is verified as a result, not a transport error", () => {
  const result = JSON.stringify({
    exit_code: 7,
    stdout: "v2-bash-failure-partial",
    stderr: "v2-bash-failure-tail",
  });
  assert.equal(
    decide(payload("v2-bash-failure", [result])).text,
    "v2-bash-failure verified",
  );
  assert.throws(() =>
    decide(
      payload("v2-bash-failure", [
        result.replace('"exit_code":7', '"exit_code":0'),
      ]),
    ),
  );
  assert.throws(() => decide(payload("v2-bash-cancel", [result])));
});
