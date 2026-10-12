import { workflowFixture } from "../observability/workflow-fixtures.mjs";
import { tag } from "../observability/trace-tree.mjs";
import { createHash } from "node:crypto";

export function fixture(kind) {
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

export function serializationRetryFixture({ failedCommit = false } = {}) {
  const f = fixture("disable");
  const owner = f.trace.spans.find(
    (s) => s.spanID === "rpc-lifecycle.runtime_disable",
  );
  owner.duration = 20;
  const add = (spanID, parent, operationName, offset, tags) => {
    const span = {
      traceID: f.trace.traceID,
      spanID,
      processID: "runtime-controller",
      operationName,
      startTime: owner.startTime + offset,
      duration: 2,
      references: [
        { refType: "CHILD_OF", traceID: f.trace.traceID, spanID: parent },
      ],
      tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
    };
    f.trace.spans.push(span);
    return span;
  };
  const conflict = {
    "span.kind": "client",
    "db.system.name": "postgresql",
    "otel.status_code": "ERROR",
    error: true,
    "otel.status_description":
      "ERROR: could not serialize access due to read/write dependencies among transactions (SQLSTATE 40001)",
  };
  add("aborted", owner.spanID, "postgresql transaction", 1, {
    "db.system.name": "postgresql",
    ...(failedCommit
      ? {
          "antnest.transaction.outcome": "failed",
          "otel.status_code": "ERROR",
          error: true,
          "error.type": "transaction_error",
        }
      : { "antnest.transaction.outcome": "rolled_back" }),
  });
  add("aborted-statement", "aborted", failedCommit ? "COMMIT" : "DELETE", 1, {
    ...conflict,
    "db.operation.name": failedCommit ? "COMMIT" : "DELETE",
  });
  const retry = add("retry", owner.spanID, "postgresql transaction", 4, {
    "db.system.name": "postgresql",
    "antnest.transaction.outcome": "committed",
  });
  return { ...f, retry, statement: f.trace.spans.at(-2) };
}
