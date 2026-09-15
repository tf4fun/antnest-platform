import assert from "node:assert/strict";
import test from "node:test";
import { appendLocalUserPrompt, applySessionUpdate, resetConversationReplay } from "./acp-state.ts";
import type { Conversation } from "./types";

const empty = (): Conversation => ({ id: "s1", agentId: "a1", title: "Chat", updatedAt: "2026-09-15T00:00:00Z", messages: [] });

test("anonymous chunks append only to the current contiguous message, not an earlier response", () => {
  let state = appendLocalUserPrompt(empty(), "Hi", []);
  const chunk = (text: string) => ({ sessionUpdate: "agent_message_chunk" as const, content: { type: "text" as const, text } });
  state = applySessionUpdate(state, chunk("First"));
  state = applySessionUpdate(state, chunk(" answer"));
  state = appendLocalUserPrompt(state, "More", []);
  state = applySessionUpdate(state, chunk("Second answer"));
  assert.deepEqual(state.messages.map(message => message.content), ["Hi", "First answer", "More", "Second answer"]);
});

test("thoughts and plans are separate projections and replay resets stale plan state", () => {
  let state = applySessionUpdate(empty(), { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Consider the evidence" } });
  state = applySessionUpdate(state, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Answer" } });
  assert.equal(state.messages[0].presentation, "thought");
  assert.equal(state.messages[1].content, "Answer");
  state = applySessionUpdate(state, { sessionUpdate: "plan", entries: [{ content: "Check evidence", status: "in_progress", priority: "high" }] });
  assert.equal(state.plan?.[0].content, "Check evidence");
  assert.equal(resetConversationReplay(state).plan, undefined);
});

test("tool results do not erase the arguments that produced them", () => {
  let state = applySessionUpdate(empty(), { sessionUpdate: "tool_call", toolCallId: "t1", title: "Read", rawInput: { path: "/workspace/a.txt" } });
  state = applySessionUpdate(state, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", rawOutput: "contents" });
  const activity = state.messages[0].activities![0];
  assert.match(activity.input!, /\/workspace\/a.txt/);
  assert.equal(activity.output, "contents");
});
