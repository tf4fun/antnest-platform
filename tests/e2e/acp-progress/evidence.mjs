import assert from "node:assert/strict";

export function terminalStatus(version, source, ending) {
  if (ending === "cancel") return version === 1 ? "failed" : "cancelled";
  return source === "bash" || ending === "success" ? "completed" : "failed";
}

export function toolUpdates(frames) {
  return frames
    .map((frame) => frame.update)
    .filter((update) =>
      ["tool_call", "tool_call_update"].includes(update?.sessionUpdate),
    );
}

export function previewReceived(frames, marker) {
  return toolUpdates(frames)
    .slice(1)
    .some(
      (update) =>
        update.status === "in_progress" &&
        JSON.stringify(update.content ?? []).includes(marker),
    );
}

export function assertEarly(frames, marker) {
  const updates = toolUpdates(frames);
  assert(updates.length >= 2, "missing early Tool update");
  assert.equal(new Set(updates.map((update) => update.toolCallId)).size, 1);
  assert(updates.every((update) => update.status === "in_progress"));
  assert(previewReceived(frames, marker), "missing preview content");
  return updates[0].toolCallId;
}

export function assertTerminal(frames, id, status) {
  const updates = toolUpdates(frames);
  assert.deepEqual(
    new Set(updates.map((update) => update.toolCallId)),
    new Set([id]),
  );
  assert.equal(updates[0].status, "in_progress");
  assert.equal(
    updates.filter((update) => update.status !== "in_progress").length,
    1,
  );
  assert.equal(updates.at(-1).status, status);
}
