import assert from "node:assert/strict";

export function assertV1Completion(result, events) {
  assert.deepEqual(result, { stopReason: "end_turn" });
  const started = new Set(
    events
      .filter((event) => event.sessionUpdate === "tool_call")
      .map((event) => event.toolCallId),
  );
  assert(
    events.some(
      (event) =>
        event.sessionUpdate === "tool_call_update" &&
        event.status === "completed" &&
        started.has(event.toolCallId),
    ),
    "successful Tool result missing",
  );
  const text = events
    .filter(
      (event) =>
        event.sessionUpdate === "agent_message_chunk" &&
        event.content.type === "text",
    )
    .map((event) => event.content.text)
    .join("");
  assert.match(text, /Stage 2 Runtime Tool execution completed\./u);
}
