import assert from "node:assert/strict";
import { test } from "node:test";
import { assertV1Completion } from "./stage2-protocol.mjs";

test("v1 completion requires a successful Tool update and final response", () => {
  const events = [
    { sessionUpdate: "tool_call", toolCallId: "tool" },
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool",
      status: "completed",
    },
    {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: "Stage 2 Runtime Tool execution completed.",
      },
    },
  ];
  assert.doesNotThrow(() =>
    assertV1Completion({ stopReason: "end_turn" }, events),
  );
  assert.throws(() => assertV1Completion({ stopReason: "cancelled" }, events));
  assert.throws(() =>
    assertV1Completion(
      { stopReason: "end_turn" },
      events.filter((event) => event.sessionUpdate !== "tool_call_update"),
    ),
  );
  assert.throws(() =>
    assertV1Completion({ stopReason: "end_turn" }, events.slice(0, -1)),
  );
});
