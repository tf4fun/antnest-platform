import assert from "node:assert/strict";
import test from "node:test";
import { emptyPresentation, reduceSessionPresentation, sessionKey } from "./session-presentation.ts";

test("Session drafts and interaction phases never cross Agent or Session boundaries", () => {
  const a = sessionKey("a1", "s1");
  const b = sessionKey("a2", "s1");
  let state = reduceSessionPresentation({}, { type: "draft", key: a, text: "Only A" });
  state = reduceSessionPresentation(state, { type: "phase", key: a, phase: "running" });
  state = reduceSessionPresentation(state, { type: "draft", key: b, text: "Only B" });
  assert.equal(state[a].text, "Only A");
  assert.equal(state[a].phase, "running");
  assert.equal(state[b].phase, "idle");
  assert.notEqual(sessionKey("a", null), sessionKey("a", ""));
});

test("connection disposal retains drafts but clears transient request state", () => {
  const key = sessionKey("a1", "s1");
  let state = reduceSessionPresentation({}, { type: "draft", key, text: "Draft" });
  state = reduceSessionPresentation(state, { type: "phase", key, phase: "running" });
  state = reduceSessionPresentation(state, { type: "disconnected", agentId: "a1" });
  assert.deepEqual(state[key], { ...emptyPresentation(), text: "Draft" });
  assert.deepEqual(reduceSessionPresentation(state, { type: "clear" }), {});
});
