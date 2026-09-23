import { workflowFixture } from "../observability/workflow-fixtures.mjs";
import { tag } from "../observability/trace-tree.mjs";
import { createHash } from "node:crypto";
function lifecycleFixture(kind) {
  const trace = workflowFixture(kind);
  for (const span of trace.spans) {
    delete span.logs;
    if (span.operationName === "postgresql transaction")
      span.tags.push(
        { key: "db.system.name", value: "postgresql" },
        { key: "antnest.transaction.outcome", value: "committed" },
      );
    if (span.operationName === "UPDATE")
      span.tags.push(
        { key: "span.kind", value: "client" },
        { key: "db.system.name", value: "postgresql" },
        { key: "db.operation.name", value: "UPDATE" },
      );
    if (
      /^client-rpc-(?:lifecycle\.)?runtime_/.test(span.spanID) &&
      !tag(span, "antnest.operation.request_id")
    ) {
      const phase = span.spanID.slice(span.spanID.indexOf("runtime_"));
      span.tags.push(
        {
          key: "antnest.operation.request_id",
          value:
            "acr_" +
            createHash("sha256")
              .update(`request-test\0${phase}`)
              .digest("hex")
              .slice(0, 32),
        },
        { key: "antnest.agent.id", value: "agent-test" },
      );
    }
  }
  trace.spans
    .find((s) => s.spanID === "gateway")
    .tags.push({ key: "http.route", value: "/api/admin/{path...}" });
  trace.spans
    .find((s) => s.spanID === "console")
    .tags.push({
      key: "http.route",
      value:
        kind === "create"
          ? "/api/admin/agents"
          : `/api/admin/agents/{agent_id}/${kind}`,
    });
  const drain = trace.spans.find((s) => s.spanID === "lifecycle.drain");
  if (drain) {
    trace.processes["agent-acp-service"] = { serviceName: "agent-acp-service" };
    for (const [index, method] of [
      "apply-execution-snapshot",
      "settle-agent",
    ].entries()) {
      const add = (id, service, parent, tags) =>
        trace.spans.push({
          traceID: trace.traceID,
          spanID: id,
          processID: service,
          operationName: `POST ${method}`,
          startTime: drain.startTime + index * 2,
          duration: 1,
          references: [
            { refType: "CHILD_OF", traceID: trace.traceID, spanID: parent },
          ],
          tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
        });
      add(`${method}-client`, "agent-controller", drain.spanID, {
        "span.kind": "client",
        "http.request.method": "POST",
        "antnest.operation.id": "request-test",
        "antnest.agent.id": "agent-test",
        "antnest.configuration.revision": 5,
        "antnest.configuration.applied_revision": 5,
        "antnest.settlement.outcome": "settled",
      });
      add(method, "agent-acp-service", `${method}-client`, {
        "span.kind": "server",
        "http.request.method": "POST",
        "http.route": `/rpc/agent-acp/${method}`,
        "http.response.status_code": 200,
        ...(method === "settle-agent"
          ? {
              "antnest.operation.id": "request-test",
              "antnest.agent.id": "agent-test",
              "antnest.configuration.revision": 5,
              "antnest.settlement.outcome": "settled",
            }
          : {}),
      });
    }
  }
  return {
    trace,
    expected: {
      kind,
      traceID: trace.traceID,
      requestId: "request-test",
      agentId: "agent-test",
    },
  };
}

export function offboardingFixture() {
  const { trace, expected } = lifecycleFixture("disable");
  trace.processes["identity-service"] = { serviceName: "identity-service" };
  const identity = trace.spans.find((s) => s.spanID === "controller");
  identity.processID = "identity-service";
  identity.operationName = "POST /rpc/identity/set-membership-active";
  for (const field of identity.tags) {
    if (field.key === "http.route")
      field.value = "/rpc/identity/set-membership-active";
    if (field.key === "http.response.status_code") field.value = 200;
  }
  for (const [id, name] of [
    ["receipt", "receive"],
    ["schedule", "disable"],
  ])
    trace.spans.push({
      traceID: trace.traceID,
      spanID: id,
      processID: "agent-controller",
      operationName: `agent_controller.identity_offboarding.${name}`,
      startTime: 3,
      duration: 1,
      references: [
        {
          refType: "CHILD_OF",
          traceID: trace.traceID,
          spanID: identity.spanID,
        },
      ],
      tags: [
        { key: "span.kind", value: "consumer" },
        { key: "identity.revocation.sequence", value: 17 },
        ...(id === "schedule"
          ? [{ key: "agent.id", value: expected.agentId }]
          : []),
      ],
    });
  trace.spans.find((s) => s.spanID === "workflow").references[0].spanID =
    "schedule";
  return {
    trace,
    expected: {
      sourceID: trace.traceID,
      agentID: expected.agentId,
      requestID: expected.requestId,
    },
  };
}
