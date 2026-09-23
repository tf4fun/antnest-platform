import assert from "node:assert/strict";
import { assertTerminal, toolUpdates } from "../acp-progress/evidence.mjs";

export function assertFileEvents(version, item, frames) {
  const updates = toolUpdates(frames);
  assert.equal(
    updates.length,
    2,
    "native file call must have one start and one end",
  );
  assertTerminal(
    frames,
    updates[0].toolCallId,
    item.error ? "failed" : "completed",
  );
  assert.equal(updates[0].kind, item.tool === "read" ? "read" : "edit");
  assert.deepEqual(updates[0].rawInput, item.args);
  assert(
    !(updates[0].content ?? []).some((content) => content.type === "diff"),
    "initial intent fabricated a completed file modification",
  );
  const final = updates.at(-1);
  if (item.error)
    assert.equal(
      final.locations,
      undefined,
      "failed operation fabricated observed location",
    );
  else assert.deepEqual(final.locations, [{ path: item.path }]);
  const diffs = (final.content ?? []).filter(
    (content) => content.type === "diff",
  );
  if (!item.change) {
    assert.equal(diffs.length, 0, "unexpected file modification");
    return;
  }
  assert.equal(diffs.length, 1, "missing or duplicate diff");
  const diff = diffs[0];
  if (version === 1) {
    assert.deepEqual(diff, {
      type: "diff",
      path: item.path,
      oldText: item.change.before,
      newText: item.change.after,
    });
    return;
  }
  assert.deepEqual(diff.changes, [
    {
      path: item.path,
      operation: item.change.before === null ? "add" : "modify",
      fileType: "text",
    },
  ]);
  assert.equal(diff.oldText, undefined);
  assert.equal(diff.newText, undefined);
  if (item.change.after === "") {
    assert.equal(diff.patch, undefined);
    return;
  }
  assert.equal(diff.patch?.format, "git_patch");
  assert(diff.patch.text.startsWith("diff --git "));
  return diff.patch.text;
}
