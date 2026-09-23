import assert from "node:assert/strict";
import { test } from "node:test";
import { assertHeldCompletion } from "./completion.mjs";
test("v2 may observe a committed terminal fact while execution still owns its slot", () => {
  const running = {
      sessionId: "s",
      update: { sessionUpdate: "state_update", state: "running" },
    },
    tool = {
      sessionId: "s",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "t",
        status: "completed",
      },
    },
    answer = {
      sessionId: "s",
      update: {
        sessionUpdate: "agent_message",
        messageId: "a",
        content: [{ type: "text", text: "v2-finish-fault verified" }],
      },
    },
    idle = {
      sessionId: "s",
      update: {
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: "end_turn",
      },
    };
  assert.equal(
    assertHeldCompletion({
      version: 2,
      response: {},
      updates: [running],
      phase: "v2-finish-fault",
      sessionId: "s",
      availability: "busy",
    }),
    false,
  );
  assert.equal(
    assertHeldCompletion({
      version: 2,
      response: {},
      updates: [running, tool, answer, idle],
      phase: "v2-finish-fault",
      sessionId: "s",
      availability: "busy",
    }),
    true,
  );
  assert.throws(() =>
    assertHeldCompletion({
      version: 2,
      response: {},
      updates: [running, idle],
      phase: "v2-finish-fault",
      sessionId: "s",
      availability: "busy",
    }),
  );
  assert.throws(() =>
    assertHeldCompletion({
      version: 2,
      response: {},
      updates: [running, tool, answer, idle],
      phase: "v2-finish-fault",
      sessionId: "s",
      availability: "ready",
    }),
  );
  assert.throws(() =>
    assertHeldCompletion({
      version: 1,
      resolved: true,
      updates: [],
      phase: "v1-finish-fault",
      sessionId: "s",
      availability: "busy",
    }),
  );
});
