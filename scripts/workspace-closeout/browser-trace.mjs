import assert from "node:assert/strict";
import {
  requestTraceBoundary,
  inspectCommandTrace,
} from "../acp-commands/trace.mjs";
import { timingEvidence } from "../acp-plan/requests.mjs";
import { tag } from "../observability/trace-tree.mjs";
import { inspectChatTraceTopology } from "./chat-trace.mjs";

export function inspectBrowserTrace(trace, expected, secrets, calls) {
  if (expected.kind !== "browser-no-tool")
    return inspectCommandTrace(trace, expected, secrets, calls);
  assert(
    ["c4-browser-attachments", "c4-browser-mobile"].includes(expected.phase),
  );
  const { tree, request, forwarded } = requestTraceBoundary(
    trace,
    expected,
    secrets,
  );
  inspectChatTraceTopology(trace, { sessionId: expected.sessionId, secrets });
  const acp = (name) =>
    trace.spans.filter(
      (s) =>
        tree.service(s) === "agent-acp-service" && s.operationName === name,
    );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].phase, expected.phase);
  assert.equal(calls[0].stage, "reply");
  assert.equal(calls[0].trace_id, trace.traceID);
  const models = acp("model.complete"),
    http = acp("HTTP POST model");
  assert.equal(models.length, 1);
  assert.equal(http.length, 1);
  assert.equal(http[0].spanID, calls[0].model_span_id);
  assert.equal(tree.parent(http[0]), models[0]);
  assert.equal(acp("mcp.tools.call").length, 0);
  assert(
    !trace.spans.some(
      (s) =>
        tree.service(s) === "antnest-runtime" &&
        tag(s, "rpc.method") === "tools/call",
    ),
  );
  const run = acp("agent.run")[0];
  assert.equal(
    acp("SELECT").filter(
      (s) =>
        tree.chain(s).includes(run) &&
        tag(s, "span.kind") === "client" &&
        tag(s, "db.system.name") === "postgresql" &&
        /^WITH finished AS \(UPDATE runs\b/i.test(
          (tag(s, "db.query.text") ?? "").replace(/\s+/g, " "),
        ),
    ).length,
    1,
  );
  return {
    trace_id: trace.traceID,
    label: expected.label,
    method: expected.method,
    run_id: tag(run, "antnest.run.id"),
    runs: 1,
    provider_requests: 1,
    runtime_tool_calls: 0,
    persistence: true,
    ...timingEvidence(trace, tree, request, forwarded),
  };
}
