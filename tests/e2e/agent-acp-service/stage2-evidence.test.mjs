import assert from "node:assert/strict";
import { test } from "node:test";
import { assertPromptEvidence } from "./stage2-acp-evidence.mjs";

const answer = "Stage 2 Runtime Tool execution completed.";
const event = (update) => ({ sessionId: "session", update });
function prompt(chunked = false) {
  return [
    event({ sessionUpdate: "state_update", state: "running" }),
    event({
      sessionUpdate: "tool_call_update",
      toolCallId: "write",
      status: "completed",
    }),
    ...(chunked
      ? [answer.slice(0, 12), answer.slice(12)].map((text) =>
          event({
            sessionUpdate: "agent_message_chunk",
            messageId: "answer",
            content: { type: "text", text },
          }),
        )
      : [
          event({
            sessionUpdate: "agent_message",
            messageId: "answer",
            content: [{ type: "text", text: answer }],
          }),
        ]),
    event({
      sessionUpdate: "state_update",
      state: "idle",
      stopReason: "end_turn",
    }),
  ];
}

for (const chunked of [false, true])
  test(`Stage 2 accepts complete v2 ${chunked ? "chunks" : "message"}`, () => {
    assert.equal(assertPromptEvidence({}, prompt(chunked), "session"), answer);
  });

for (const [name, mutate] of [
  [
    "foreign Session",
    (updates) => {
      updates[2].sessionId = "foreign";
    },
  ],
  [
    "uncompleted Tool",
    (updates) => {
      updates[1].update.status = "in_progress";
    },
  ],
  [
    "answer before Tool completion",
    (updates) => {
      [updates[1], updates[2]] = [updates[2], updates[1]];
    },
  ],
  [
    "truncated answer",
    (updates) => {
      updates[2].update.content[0].text = "Stage 2";
    },
  ],
  ["missing idle", (updates) => updates.pop()],
  [
    "failed Run",
    (updates) => {
      updates.at(-1).update.stopReason = "error";
    },
  ],
  [
    "duplicate answer",
    (updates) => updates.splice(3, 0, structuredClone(updates[2])),
  ],
])
  test(`Stage 2 rejects ${name}`, () => {
    const updates = prompt();
    mutate(updates);
    assert.throws(() => assertPromptEvidence({}, updates, "session"));
  });

test("Stage 2 must not combine chunks from unrelated responses", () => {
  const updates = prompt(true);
  updates[3].update.messageId = "another-answer";
  assert.throws(() => assertPromptEvidence({}, updates, "session"));
});

test("Stage 2 rejects running after Tool and answer", () => {
  const updates = prompt();
  updates.splice(2, 0, updates.shift());
  assert.throws(() => assertPromptEvidence({}, updates, "session"));
});

test("Stage 2 selects the last emitted response rather than the last inserted message ID", () => {
  const updates = prompt();
  const chunk = (text) =>
    event({
      sessionUpdate: "agent_message_chunk",
      messageId: "interleaved",
      content: { type: "text", text },
    });
  updates.splice(2, 0, chunk("Earlier "));
  updates.splice(4, 0, chunk("incorrect answer"));
  assert.throws(() => assertPromptEvidence({}, updates, "session"));
});
