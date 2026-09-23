import assert from "node:assert/strict";
import { inspectTrace } from "../managed-mcp/trace.mjs";
import { inspectAccessTrace } from "../identity-closeout/agent-access-evidence.mjs";
import {
  assertCaptureDisabled,
  owningServer,
  traceTree,
} from "../observability/trace-tree.mjs";
import { assertAdmissionEvidence } from "./admission-evidence.mjs";

export function inspectRunTrace(
  trace,
  requests,
  secrets,
  agentID,
  admissions,
  expectedTool = requests[0].phase === "c3-held-run" ? "bash" : "read",
) {
  const { parent, chain } = traceTree(trace);
  assertCaptureDisabled(trace);
  const result = inspectTrace(trace, requests, secrets);
  const tag = (span, key) => span.tags?.find((t) => t.key === key)?.value;
  const service = (span) => trace.processes[span.processID]?.serviceName;
  const tools = trace.spans.filter(
    (s) =>
      service(s) === "antnest-runtime" &&
      s.operationName === "runtime.mcp.tool",
  );
  assert.equal(
    tools.length,
    1,
    "Run must dispatch exactly one actual Runtime tool",
  );
  assert.equal(tag(tools[0], "antnest.agent.id"), agentID);
  assert.equal(tag(tools[0], "mcp.tool.name"), expectedTool);
  assert.equal(tag(tools[0], "mcp.tool.outcome"), "success");
  assert.notEqual(tag(tools[0], "error"), true);
  assertRunAncestry(trace, requests, tools[0]);
  const toolRun = chain(tools[0]).find(
    (span) =>
      span.operationName === "agent.run" &&
      service(span) === "agent-acp-service",
  );
  const rpcs = {};
  for (const method of ["acquire", "finish"]) {
    const route = `/rpc/agent-controller/${method}-run`;
    const expected = {
      traceID: trace.traceID,
      service: "agent-controller",
      method: "POST",
      route,
      rpcMethod: `POST ${route}`,
      clientService: "agent-acp-service",
      status: 200,
      via: ["agent-acp-service"],
    };
    const { server, client } = owningServer(trace, expected);
    assert.notEqual(tag(server, "error"), true);
    const rpc = parent(client);
    assert(rpc && service(rpc) === "agent-acp-service");
    assert.equal(rpc.operationName, `agent_controller.${method}_run`);
    assert.notEqual(tag(rpc, "error"), true);
    assert.equal(
      trace.spans.filter(
        (span) =>
          service(span) === "agent-acp-service" &&
          span.operationName === rpc.operationName,
      ).length,
      1,
      "duplicate ACP business request",
    );
    if (method === "finish")
      assert(chain(rpc).includes(toolRun), "finish RPC belongs to another Run");
    rpcs[method] = rpc;
    inspectAccessTrace(trace, expected, secrets);
  }
  assertFinishedAdmission(trace, rpcs.finish, requests);
  assert(
    tag(rpcs.acquire, "request.id") && tag(rpcs.acquire, "session.id"),
    "acquire identity missing",
  );
  assert.equal(tag(rpcs.acquire, "agent.id"), agentID);
  assertAdmissionEvidence(admissions, {
    admissionID: tag(rpcs.finish, "admission.id"),
    agentID,
    requestID: tag(rpcs.acquire, "request.id"),
    sessionID: tag(rpcs.acquire, "session.id"),
    state: "released",
    terminalClass: "completed",
    toolEffectState: "settled",
  });
  return {
    ...result,
    run_admission_closed: true,
    admission_evidence: "persisted",
    capture_rpc_content: false,
    actual_tool: tag(tools[0], "mcp.tool.name"),
  };
}

function assertFinishedAdmission(trace, rpc, requests) {
  const tag = (s, key) => s.tags?.find((t) => t.key === key)?.value;
  assert.equal(tag(rpc, "run.terminal_class"), "completed");
  assert.equal(tag(rpc, "run.tool_effect_state"), "settled");
  const spans = new Map(trace.spans.map((s) => [s.spanID, s]));
  assert(
    rpc && trace.processes[rpc.processID]?.serviceName === "agent-acp-service",
    "missing ACP finish RPC ancestor",
  );
  const admission = tag(rpc, "admission.id");
  assert(admission, "finish RPC admission missing");
  for (const request of requests)
    assert.equal(
      tag(spans.get(request.model_span_id), "admission.id"),
      admission,
      "finish RPC closed another admission",
    );
}

function assertRunAncestry(trace, requests, tool) {
  const spans = new Map(trace.spans.map((s) => [s.spanID, s]));
  const service = (s) => trace.processes[s.processID]?.serviceName;
  const chain = (span) => {
    const result = [];
    const seen = new Set();
    while (span) {
      assert.equal(span.traceID, trace.traceID, "foreign-trace span");
      assert(!seen.has(span.spanID), "cyclic span ancestry");
      seen.add(span.spanID);
      result.push(span);
      const parent = span.references?.find(
        (r) => r.refType === "CHILD_OF" && r.traceID === trace.traceID,
      );
      span = spans.get(parent?.spanID);
    }
    assert(
      result.some((s) => service(s) === "edge-gateway"),
      "missing same-trace Gateway ancestry",
    );
    return result;
  };
  const runOf = (span) => {
    const run = chain(span).find(
      (s) =>
        service(s) === "agent-acp-service" && s.operationName === "agent.run",
    );
    assert(run, "missing ACP Run ancestor");
    return run;
  };
  const runs = requests.map((r) => {
    assert.equal(r.trace_id, trace.traceID);
    const model = spans.get(r.model_span_id);
    assert(model, "correlated model span missing");
    const run = runOf(model);
    const admission = (s) =>
      s.tags?.find((t) => t.key === "admission.id")?.value;
    assert(admission(run), "Run admission missing");
    assert.equal(admission(model), admission(run));
    return run.spanID;
  });
  assert.equal(new Set(runs).size, 1, "model calls belong to different Runs");
  for (const span of trace.spans.filter(
    (s) =>
      service(s) === "agent-acp-service" &&
      ["mcp.runtime.info", "mcp.tools.list", "mcp.tools.call"].includes(
        s.operationName,
      ),
  ))
    assert.equal(
      runOf(span).spanID,
      runs[0],
      "Runtime preparation/dispatch belongs to another Run",
    );
  const ancestors = chain(tool);
  assert(
    ancestors.some(
      (s) =>
        service(s) === "agent-acp-service" &&
        s.operationName === "mcp.tools.call",
    ),
    "Runtime tool bypassed ACP dispatch",
  );
  assert.equal(
    runOf(tool).spanID,
    runs[0],
    "Runtime tool belongs to another Run",
  );
}
