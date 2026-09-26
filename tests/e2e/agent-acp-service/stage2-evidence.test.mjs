import assert from "node:assert/strict";
import { test } from "node:test";
import { assertPromptEvidence } from "./stage2-acp-evidence.mjs";

const accepted = { messageId: "input" };
const answer = "Stage 2 Runtime Tool execution completed.";
const event = (update) => ({ sessionId: "session", update });
function prompt(chunked = false) {
  return [
    event({
      sessionUpdate: "user_message",
      messageId: "input",
      content: [{ type: "text", text: "Stage 2 request" }],
    }),
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
    assert.equal(
      assertPromptEvidence(accepted, prompt(chunked), "session"),
      answer,
    );
  });

for (const [name, mutate] of [
  [
    "foreign Session",
    (updates) => {
      updates[3].sessionId = "foreign";
    },
  ],
  [
    "uncompleted Tool",
    (updates) => {
      updates[2].update.status = "in_progress";
    },
  ],
  [
    "answer before Tool completion",
    (updates) => {
      [updates[2], updates[3]] = [updates[3], updates[2]];
    },
  ],
  [
    "truncated answer",
    (updates) => {
      updates[3].update.content[0].text = "Stage 2";
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
    (updates) => updates.splice(4, 0, structuredClone(updates[3])),
  ],
])
  test(`Stage 2 rejects ${name}`, () => {
    const updates = prompt();
    mutate(updates);
    assert.throws(() => assertPromptEvidence(accepted, updates, "session"));
  });

test("Stage 2 must not combine chunks from unrelated responses", () => {
  const updates = prompt(true);
  updates[4].update.messageId = "another-answer";
  assert.throws(() => assertPromptEvidence(accepted, updates, "session"));
});

test("Stage 2 rejects running after Tool and answer", () => {
  const updates = prompt();
  updates.splice(3, 0, ...updates.splice(1, 1));
  assert.throws(() => assertPromptEvidence(accepted, updates, "session"));
});

test("Stage 2 selects the last emitted response rather than the last inserted message ID", () => {
  const updates = prompt();
  const chunk = (text) =>
    event({
      sessionUpdate: "agent_message_chunk",
      messageId: "interleaved",
      content: { type: "text", text },
    });
  updates.splice(3, 0, chunk("Earlier "));
  updates.splice(5, 0, chunk("incorrect answer"));
  assert.throws(() => assertPromptEvidence(accepted, updates, "session"));
});

test("Stage 2 rejects acknowledgments that do not identify the live user input", () => {
  for (const response of [
    {},
    { messageId: "" },
    { messageId: "answer" },
    { messageId: "foreign" },
  ])
    assert.throws(() => assertPromptEvidence(response, prompt(), "session"));
  assert.throws(() =>
    assertPromptEvidence(accepted, prompt().slice(1), "session"),
  );
});
