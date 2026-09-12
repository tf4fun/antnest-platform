import assert from "node:assert/strict";
import {
  assertCaptureDisabled,
  owningServer,
  traceTree,
} from "../observability/trace-tree.mjs";
import { assertAdmissionEvidence } from "../lifecycle-closeout/admission-evidence.mjs";

export function inspectUnresolvedAdmission(
  trace,
  requests,
  agentID,
  admissions,
) {
  const { chain: ancestry, parent } = traceTree(trace);
  assertCaptureDisabled(trace);
  assert(requests.length > 0, "cancel model evidence missing");
  const spans = new Map(trace.spans.map((span) => [span.spanID, span]));
  const service = (span) => trace.processes[span.processID]?.serviceName;
  const tag = (span, key) =>
    span?.tags?.find((item) => item.key === key)?.value;
  function chain(span) {
    const parents = ancestry(span);
    assert(
      parents.some((parent) => service(parent) === "edge-gateway"),
      "cancel trace lost Gateway ancestry",
    );
    return parents;
  }
  function exact(owner, name) {
    const matches = trace.spans.filter(
      (span) => service(span) === owner && span.operationName === name,
    );
    assert.equal(matches.length, 1, `missing/duplicate ${name}`);
    return matches[0];
  }
  const run = exact("agent-acp-service", "agent.run");
  const admission = tag(run, "admission.id");
  assert(admission);
  const route = "/rpc/agent-controller/finish-run";
  const { server: finish, client } = owningServer(trace, {
    service: "agent-controller",
    method: "POST",
    route,
    rpcMethod: `POST ${route}`,
    clientService: "agent-acp-service",
    status: 200,
  });
  assert.notEqual(tag(finish, "error"), true);
  const rpc = exact("agent-acp-service", "agent_controller.finish_run");
  assert(parent(client) === rpc, "finish CLIENT detached from ACP operation");
  assert.equal(tag(rpc, "admission.id"), admission);
  assert.equal(tag(rpc, "run.terminal_class"), "unresolved");
  assert.equal(tag(rpc, "run.tool_effect_state"), "unknown");
  assertAdmissionEvidence(admissions, {
    admissionID: admission,
    agentID,
    state: "blocked_unknown_effect",
    terminalClass: "unresolved",
    toolEffectState: "unknown",
  });
  assert(chain(finish).includes(rpc) && chain(rpc).includes(run));
  for (const request of requests) {
    assert.equal(request.trace_id, trace.traceID);
    const model = spans.get(request.model_span_id);
    assert.equal(tag(model, "admission.id"), admission);
    assert(chain(model).includes(run));
  }
  const tool = exact("antnest-runtime", "runtime.mcp.tool");
  assert.equal(tag(tool, "antnest.agent.id"), agentID);
  assert.equal(tag(tool, "mcp.tool.name"), "bash");
  assert(
    chain(tool).includes(exact("agent-acp-service", "mcp.tools.call")) &&
      chain(tool).includes(run),
  );
  return {
    admission_fenced: true,
    admission_evidence: "persisted",
    capture_rpc_content: false,
    terminal_class: "unresolved",
    tool_effect_state: "unknown",
  };
}
