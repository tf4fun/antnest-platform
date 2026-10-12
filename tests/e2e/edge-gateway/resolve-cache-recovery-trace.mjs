import assert from "node:assert/strict";
import { tag, traceTopology } from "../observability/trace-tree.mjs";
import { inspectWorkspaceChatTrace } from "../workspace-closeout/chat-trace.mjs";
import { inspectRecoveryWindow } from "./resolve-cache-recovery.mjs";

export function inspectRecoveryRunTraces(evidence, collection, secrets = []) {
  const business = inspectRecoveryWindow(evidence);
  const runs = evidence.recovery.cases.map((c) => {
    const trace = collection.traces.get(c.prompt.trace_id);
    assert(
      trace && collection.archivedTraceIDs.has(trace.traceID),
      "actual recovery Run Trace not archived",
    );
    const expected = {
      traceID: c.prompt.trace_id,
      agentId: evidence.agent_id,
      sessionId: c.session_id,
      runId: c.run_id,
      bridge: true,
      phase: c.phase,
      ...(c.name === "deactivate"
        ? { cancellationCause: "principal_revocation" }
        : {}),
      requests: c.model_terminal.state.requests.filter(
        (r) => r.phase === c.phase,
      ),
      audit: c.audit_terminal,
      resolveTTLMS: 10000,
    };
    const report = inspectWorkspaceChatTrace(
      trace,
      expected,
      secrets,
      collection,
    );
    const tree = traceTopology(trace);
    const run = trace.spans.filter(
      (s) =>
        tree.service(s) === "agent-acp-service" &&
        s.operationName === "agent.run",
    );
    assert.equal(run.length, 1);
    assert.equal(tag(run[0], "antnest.run.id"), c.run_id);
    for (const [key, value] of Object.entries({
      "run.terminal_class": c.audit_terminal.body.terminal_class,
      "run.executor_state": "quiescent",
      "run.tool_effect_state": "none",
      "antnest.outcome": c.name === "deactivate" ? "cancelled" : "ok",
    }))
      assert.equal(tag(run[0], key), value);
    assert(
      !trace.spans.some((s) =>
        ["mcp.tools.call", "runtime.mcp.tool"].includes(s.operationName),
      ),
      "held recovery Run unexpectedly executed a Tool",
    );
    return { name: c.name, ...report };
  });
  return {
    status: "passed",
    business,
    runs,
    owned_error_spans: runs.flatMap((run) => run.owned_error_spans),
  };
}
