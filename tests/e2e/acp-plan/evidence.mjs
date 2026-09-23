import assert from "node:assert/strict";
import { caseFor, stepsFor } from "./model.mjs";

export const planUpdates = (frames) =>
  frames
    .map((frame) => frame.update)
    .filter((update) =>
      ["plan", "plan_update"].includes(update?.sessionUpdate),
    );
export const relevantUpdates = (frames) =>
  frames
    .map((frame) => frame.update)
    .filter((update) =>
      ["plan", "plan_update", "tool_call", "tool_call_update"].includes(
        update?.sessionUpdate,
      ),
    );

export function appendRunEvidence(history, updates) {
  const previous = new Set(
    history.map((update) => update.toolCallId).filter(Boolean),
  );
  for (const update of updates)
    if (update.toolCallId)
      assert(!previous.has(update.toolCallId), "Tool ID reused by another Run");
  history.push(...updates);
}

export function assertPlanEvents(version, phase, frames) {
  const item = caseFor(phase);
  const plans = planUpdates(frames);
  assert.deepEqual(
    plans,
    item.plans.map((entries) =>
      version === 1
        ? { sessionUpdate: "plan", entries }
        : {
            sessionUpdate: "plan_update",
            plan: { type: "items", planId: "current", entries },
          },
    ),
    "missing, duplicate or incorrect plan",
  );
  const finals = frames
    .map((frame, index) => ({ ...frame.update, index }))
    .filter(
      (update) =>
        ["agent_message_chunk", "agent_message"].includes(
          update.sessionUpdate,
        ) && update.content?.type === "text",
    );
  assert.equal(
    finals.map((update) => update.content.text).join(""),
    `${phase} verified`,
    "verified final response missing",
  );
  const end = finals[0].index;
  const tools = relevantUpdates(frames).filter((update) =>
    ["tool_call", "tool_call_update"].includes(update.sessionUpdate),
  );
  const starts = tools.filter((update, index) =>
    version === 1
      ? update.sessionUpdate === "tool_call"
      : tools.findIndex((prior) => prior.toolCallId === update.toolCallId) ===
        index,
  );
  const steps = stepsFor(phase);
  assert.equal(
    starts.length,
    steps.length,
    "missing or duplicate Tool identity",
  );
  assert.equal(
    new Set(starts.map((update) => update.toolCallId)).size,
    starts.length,
  );
  let planIndex = 0;
  let previousTerminal = -1;
  for (const [index, step] of steps.entries()) {
    const start = starts[index];
    assert(
      frames.findIndex((frame) => frame.update === start) > previousTerminal,
      "Tool call order is invalid",
    );
    assert.deepEqual(start.rawInput, step.arguments);
    const history = tools.filter(
      (update) => update.toolCallId === start.toolCallId,
    );
    const terminal = history.filter(
      (update) => update.status !== "in_progress",
    );
    assert.equal(
      terminal.length,
      1,
      "missing or duplicate terminal Tool result",
    );
    assert.equal(terminal[0], history.at(-1));
    assert.equal(
      terminal[0].status,
      item.id === "invalid" ? "failed" : "completed",
    );
    const terminalIndex = frames.findIndex(
      (frame) => frame.update === terminal[0],
    );
    assert(terminalIndex < end, "Tool result followed final reply");
    if (step.name === "update_plan" && item.id !== "invalid") {
      assert.equal(history.length, 1, "local plan fabricated remote progress");
      assert.equal(start.title, "Update plan");
      assert.equal(start.kind, "other");
      assert.deepEqual(start.content, [
        { type: "content", content: { type: "text", text: "Plan updated." } },
      ]);
      const plan = plans[planIndex++];
      assert(
        frames.findIndex((frame) => frame.update === plan) > previousTerminal,
        "previous Tool result must precede plan",
      );
      assert(
        frames.findIndex((frame) => frame.update === plan) < terminalIndex,
        "plan followed its result",
      );
    }
    previousTerminal = terminalIndex;
  }
  assert.equal(
    new Set(tools.map((update) => update.toolCallId)).size,
    starts.length,
  );
  return {
    plans: plans.length,
    tool_calls: starts.length,
    remote_calls: item.remote,
  };
}
