import assert from "node:assert/strict";

// SDK 1.5 acknowledges durable input identity before the asynchronous Run ends.
// Completion and slot ownership are checked separately by each scenario.
export function assertV2PromptAcknowledged(response, updates, sessionId) {
  assert.equal(
    typeof response?.messageId,
    "string",
    "missing v2 input identity",
  );
  assert.ok(response.messageId.trim(), "empty v2 input identity");
  const matching = updates.filter(
    (item) =>
      item.sessionId === sessionId &&
      item.update.sessionUpdate === "user_message" &&
      item.update.messageId === response.messageId,
  );
  assert.equal(
    matching.length,
    1,
    "v2 acknowledgment must identify one live user message in its Session",
  );
}
