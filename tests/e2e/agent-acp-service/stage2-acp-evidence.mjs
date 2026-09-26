import assert from "node:assert/strict";
import { assertV2PromptAcknowledged } from "../../support/acp-v2-prompt.mjs";

export function assertPromptEvidence(response, events, sessionId) {
  assertV2PromptAcknowledged(response, events, sessionId);
  assert(
    events.every((e) => e.sessionId === sessionId),
    "foreign Session notification",
  );
  const updates = events.map((e) => e.update);
  const states = updates.filter((u) => u.sessionUpdate === "state_update");
  assert.deepEqual(
    states.map((u) => u.state),
    ["running", "idle"],
  );
  assert.equal(states[1].stopReason, "end_turn");
  assert.equal(updates.at(-1), states[1], "idle preceded output");
  const completed = updates.findLastIndex(
    (u) => u.sessionUpdate === "tool_call_update" && u.status === "completed",
  );
  assert(completed >= 0, "missing completed Tool");
  const firstTool = updates.findIndex(
    (u) => u.sessionUpdate === "tool_call_update",
  );
  assert(
    updates.indexOf(states[0]) < firstTool,
    "running preceded by Tool output",
  );
  const messages = new Map();
  for (const [index, update] of updates.entries()) {
    if (
      !["agent_message", "agent_message_chunk"].includes(update.sessionUpdate)
    )
      continue;
    assert(
      typeof update.messageId === "string" && update.messageId,
      "missing message identity",
    );
    const blocks = Array.isArray(update.content)
      ? update.content
      : [update.content];
    const text = blocks
      .filter((b) => b?.type === "text")
      .map((b) => b.text)
      .join("");
    const previous = messages.get(update.messageId);
    if (update.sessionUpdate === "agent_message")
      assert(!previous, "duplicate full message");
    else assert(!previous?.full, "chunks after full message");
    messages.set(update.messageId, {
      text: (previous?.text ?? "") + text,
      first: previous?.first ?? index,
      last: index,
      full: update.sessionUpdate === "agent_message",
    });
  }
  const final = [...messages.values()].sort((a, b) => a.last - b.last).at(-1);
  assert(final && final.first > completed, "answer preceded completed Tool");
  assert.equal(final.text, "Stage 2 Runtime Tool execution completed.");
  return final.text;
}
