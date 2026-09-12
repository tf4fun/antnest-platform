import { lifecyclePlans } from "./lifecycle-workflow.mjs";
export function workflowFixture(kind = "create") {
  const trace = { traceID: "a".repeat(32), spans: [], processes: {} };
  const add = (id, service, operationName, parent, startTime, tags = {}) => {
    trace.processes[service] = { serviceName: service };
    trace.spans.push({
      traceID: trace.traceID,
      spanID: id,
      processID: service,
      operationName,
      startTime,
      duration: 1,
      references: parent
        ? [{ refType: "CHILD_OF", traceID: trace.traceID, spanID: parent }]
        : [],
      tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
    });
  };
  add("gateway", "edge-gateway", "POST /api/admin/agents", null, 0, {
    "span.kind": "server",
    "http.request.method": "POST",
    "http.response.status_code": 202,
  });
  add("console", "admin-console", "POST create", "gateway", 1);
  trace.spans
    .at(-1)
    .tags.push(
      { key: "span.kind", value: "server" },
      { key: "http.request.method", value: "POST" },
    );
  add("controller", "agent-controller", "POST create", "console", 2, {
    "http.route":
      kind === "create"
        ? "/internal/agents"
        : `/internal/agents/{agent_id}/${kind}`,
    "http.response.status_code": 202,
    "span.kind": "server",
    "http.request.method": "POST",
    "antnest.agent.id": "agent-test",
  });
  add(
    "workflow",
    "agent-controller",
    kind === "create"
      ? "RunWorkflow:CreateAgentWorkflow"
      : "RunWorkflow:LifecycleWorkflow",
    "controller",
    3,
    {
      temporalWorkflowID: `agent-${kind}/request-test`,
    },
  );

  const phases = [
    kind === "create" ? "admit_agent" : "admit_lifecycle",
    ...lifecyclePlans[kind].map((phase) =>
      kind === "create" ? phase : "lifecycle." + phase,
    ),
  ];
  const services = phases.map((name) => {
    const phase = name.replace("lifecycle.", "");
    if (phase.startsWith("runtime_")) return "runtime-controller";
    if (
      phase.startsWith("network_") ||
      (kind === "create" && phase === "publish")
    )
      return "antnest-runtime-egress";
    if (name.startsWith("admit") && (kind === "create" || kind === "enable"))
      return "identity-service";
    return "agent-controller";
  });
  for (const [index, phase] of phases.entries()) {
    add(
      phase,
      "agent-controller",
      `RunActivity:${phase}`,
      "workflow",
      10 + index * 10,
      {
        temporalWorkflowID: `agent-${kind}/request-test`,
        temporalRunID: "workflow-run",
        temporalActivityID: phase,
      },
    );
    add(`sql-${phase}`, "agent-controller", "SELECT", phase, 10 + index * 10, {
      "db.query.text": "SELECT id FROM agents",
    });
    const name = phase.replace("lifecycle.", "");
    let method = "PUT";
    let route = "/internal/agent-network-attachments/{agent_id}";
    if (services[index] === "identity-service") {
      method = "POST";
      route = "/rpc/identity/resolve-owner-authorization";
    } else if (services[index] === "runtime-controller") {
      method = "POST";
      route = "/internal/runtimes/{agent_id}/" + name.replace("runtime_", "");
    } else if (name === "network_fence") {
      method = "GET";
      route = "/internal/agent-networks/{agent_id}";
    } else if (name === "network_release") {
      method = "POST";
      route = "/internal/agent-networks/{agent_id}/release";
    } else if (name === "network_ensure" && kind !== "rebuild") {
      route = "/internal/agent-networks/{agent_id}";
    }
    if (services[index] === "agent-controller") continue;
    add(`rpc-${phase}`, services[index], "RPC", phase, 10 + index * 10, {
      "span.kind": "server",
      "http.request.method": method,
      "http.route": route,
      "http.response.status_code": 200,
    });
  }
  // Model transport and local commit boundaries independently of the checker.
  for (const [index, phase] of phases.entries()) {
    const start = 10 + index * 10;
    trace.spans.find((span) => span.spanID === phase).duration = 8;
    const sql = trace.spans.find((span) => span.spanID === `sql-${phase}`);
    sql.operationName = "UPDATE";
    sql.tags = [
      {
        key: "db.query.text",
        value: "UPDATE agent_controller.agents SET aggregate_sequence = $1",
      },
    ];
    sql.references[0].spanID = `transaction-${phase}`;
    add(
      `transaction-${phase}`,
      "agent-controller",
      "postgresql transaction",
      phase,
      start + 6,
    );
    add(
      `commit-${phase}`,
      "agent-controller",
      "COMMIT",
      `transaction-${phase}`,
      start + 7,
    );
    const name = phase.replace("lifecycle.", "");
    const primary = trace.spans.find((span) => span.spanID === `rpc-${phase}`);
    if (primary) primary.startTime = start + 2;
    if (name === "network_fence")
      add(`close-${phase}`, "antnest-runtime-egress", "RPC", phase, start + 4, {
        "span.kind": "server",
        "http.request.method": "PUT",
        "http.route": "/internal/agent-network-attachments/{agent_id}",
        "http.response.status_code": 200,
      });
    if (name === "network_release") {
      primary.startTime = start + 4;
      add(`get-${phase}`, "antnest-runtime-egress", "RPC", phase, start + 2, {
        "span.kind": "server",
        "http.request.method": "GET",
        "http.route": "/internal/agent-networks/{agent_id}",
        "http.response.status_code": 200,
      });
    }
    if (
      ["runtime_initialize", "runtime_update", "runtime_enable"].includes(name)
    )
      add(
        `status-${phase}`,
        "antnest-runtime",
        "GET /status",
        primary.spanID,
        start + 3,
        {
          "span.kind": "server",
          "http.request.method": "GET",
          "http.route": "/status",
          "http.response.status_code": 200,
        },
      );
  }
  for (const server of [...trace.spans].filter(
    (span) =>
      span.references.length &&
      span.tags.some(
        (field) => field.key === "span.kind" && field.value === "server",
      ),
  )) {
    const parent = trace.spans.find(
      (span) => span.spanID === server.references[0].spanID,
    );
    const caller = parent.processID;
    const clientID = `client-${server.spanID}`;
    add(clientID, caller, "HTTP", parent.spanID, server.startTime, {
      "span.kind": "client",
      "http.request.method": server.tags.find(
        (field) => field.key === "http.request.method",
      ).value,
    });
    server.references[0].spanID = clientID;
  }
  return trace;
}
