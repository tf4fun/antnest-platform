import assert from "node:assert/strict";
import { assertTerminal, toolUpdates } from "../acp-progress/evidence.mjs";
import { assertSecretFree } from "../identity-closeout/evidence.mjs";

export function inspectReplayTrace(trace, secrets = []) {
  assert(trace?.spans?.length, "missing replay trace");
  const spans = new Map(trace.spans.map((span) => [span.spanID, span]));
  const service = (span) => trace.processes[span.processID]?.serviceName;
  const methods = new Set();
  for (const span of spans.values()) {
    assert.notEqual(
      service(span),
      "antnest-runtime",
      "replay contacted Runtime",
    );
    assert(
      !/^(model\.|mcp\.)/.test(span.operationName),
      "replay executed a model/Runtime operation",
    );
    if (
      service(span) !== "agent-acp-service" ||
      !["acp.session.resume", "acp.session.fork"].includes(span.operationName)
    )
      continue;
    methods.add(span.operationName);
    let parent = span;
    const seen = new Set();
    while (
      parent &&
      service(parent) !== "edge-gateway" &&
      !seen.has(parent.spanID)
    ) {
      seen.add(parent.spanID);
      parent = spans.get(
        parent.references?.find((ref) => ref.refType === "CHILD_OF")?.spanID,
      );
    }
    assert(
      parent && service(parent) === "edge-gateway",
      "missing replay Gateway ancestry",
    );
  }
  assert.deepEqual(
    methods,
    new Set(["acp.session.resume", "acp.session.fork"]),
  );
  assertSecretFree(JSON.stringify(trace), secrets);
  return { trace_id: trace.traceID, spans: spans.size, no_execution: true };
}

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
