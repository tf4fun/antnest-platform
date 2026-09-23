import { fixture } from "../../e2e/stage3-base/trace-fixtures.mjs";
import { recoveryAgentState } from "./development-recovery.mjs";
import { runtimeCommandId } from "../../e2e/stage3-base/contracts.mjs";

export const lifecycleKinds = [
  "create",
  "disable",
  "enable",
  "rebuild",
  "delete",
];
export const retainedAgent = "agent_" + "b".repeat(32);
export const temporaryAgent = "agent_" + "c".repeat(32);
export const lifecycleOrganization = "organization-fixture";

export function lifecycleAgent(kind = "create", agentId = temporaryAgent) {
  const row = {
    ...recoveryAgentState(true),
    agent_id: agentId,
    owner_user_id: "user-fixture",
    name: "lifecycle-fixture",
    agent_spec_revision: "spec-fixture",
  };
  row.runtime.runtime_revision =
    kind === "rebuild" ? "rebuilt-runtime" : "initial-runtime";
  if (kind === "disable")
    Object.assign(row, {
      activation_state: "disabled",
      desired_state: "disabled",
      runtime_state: "stopped",
      executable_execution_revision: null,
    });
  if (kind === "delete")
    Object.assign(row, {
      lifecycle_state: "deleted",
      desired_state: "deleted",
      runtime_state: "absent",
      activation_state: null,
      configuration: null,
      agent_spec_revision: null,
      executable_execution_revision: null,
      runtime: null,
    });
  return row;
}

export function lifecycleTrace(kind, agentId = temporaryAgent) {
  const f = fixture(kind),
    traceID = (lifecycleKinds.indexOf(kind) + 1).toString(16).padStart(32, "0");
  const oldTraceID = f.trace.traceID;
  const requestId = "request-fixture-" + kind;
  let encoded = JSON.stringify(f)
    .replaceAll("agent-test", agentId)
    .replaceAll(oldTraceID, traceID);
  for (const phase of [
    "runtime_initialize",
    "runtime_disable",
    "runtime_enable",
    "runtime_update",
    "runtime_delete",
  ])
    encoded = encoded.replaceAll(
      runtimeCommandId("request-test", phase),
      runtimeCommandId(requestId, phase),
    );
  const result = JSON.parse(encoded.replaceAll("request-test", requestId));
  const trace = result.trace;
  const phase = {
    create: "runtime_initialize",
    enable: "runtime_enable",
    rebuild: "runtime_update",
  }[kind];
  const owner = trace.spans.find(
    (s) =>
      s.spanID === "rpc-" + (kind === "create" ? phase : "lifecycle." + phase),
  );
  for (const [index, storage] of (kind === "create"
    ? [true, false]
    : phase
      ? [false]
      : []
  ).entries()) {
    const prefix = "fixture-platform-" + index,
      offset = owner.startTime + 1;
    const add = (id, parent, operationName, startTime, fields) =>
      trace.spans.push({
        traceID,
        spanID: id,
        processID: "runtime-controller",
        operationName,
        startTime,
        duration: 1,
        references: [{ refType: "CHILD_OF", traceID, spanID: parent }],
        tags: Object.entries(fields).map(([key, value]) => ({ key, value })),
      });
    add(
      prefix,
      owner.spanID,
      storage ? "runtime.platform.ensure_storage" : "runtime.platform.create",
      offset,
      {
        "antnest.agent.id": agentId,
        "antnest.outcome": "completed",
        "antnest.platform": "docker",
      },
    );
    const peer = { "span.kind": "client", "peer.service": "docker" };
    add(prefix + "-probe", prefix, "HTTP GET docker", offset + 1, {
      ...peer,
      "http.request.method": "GET",
      "http.response.status_code": 404,
      "antnest.outcome": "absent",
    });
    add(prefix + "-allocate", prefix, "HTTP POST docker", offset + 2, {
      ...peer,
      "http.request.method": "POST",
      "http.response.status_code": 201,
    });
    add(
      prefix + "-start",
      prefix,
      storage ? "HTTP GET docker" : "HTTP POST docker",
      offset + 3,
      {
        ...peer,
        "http.request.method": storage ? "GET" : "POST",
        "http.response.status_code": storage ? 200 : 204,
      },
    );
  }
  return result;
}

export function publicationTrace(
  index = 1,
  organization = lifecycleOrganization,
) {
  const traceID = (100 + index).toString(16).padStart(32, "0"),
    trace = { traceID, spans: [], processes: {} };
  const add = (id, parent, service, operationName, fields) => {
    trace.processes[service] = { serviceName: service };
    trace.spans.push({
      traceID,
      spanID: id,
      processID: service,
      operationName,
      startTime: 1000,
      duration: 10,
      references: parent
        ? [{ refType: "CHILD_OF", traceID, spanID: parent }]
        : [],
      tags: Object.entries(fields).map(([key, value]) => ({ key, value })),
    });
  };
  add(
    "publication",
    null,
    "agent-controller",
    "agent_controller.execution_publication",
    {
      "antnest.organization.id": organization,
      "antnest.configuration.applied_revision": index,
    },
  );
  add("source", "publication", "agent-controller", "SELECT", {
    "db.system.name": "postgresql",
    "db.query.text":
      "SELECT revision FROM agent_controller.execution_configuration_sync WHERE organization_id = $1",
  });
  add(
    "client",
    "publication",
    "agent-controller",
    "HTTP POST agent-acp-service",
    {
      "http.response.status_code": 200,
      "antnest.configuration.applied_revision": index,
    },
  );
  add(
    "server",
    "client",
    "agent-acp-service",
    "POST apply-execution-snapshot",
    {
      "http.response.status_code": 200,
      "http.route": "/rpc/agent-acp/apply-execution-snapshot",
    },
  );
  add("ack", "publication", "agent-controller", "UPDATE", {
    "db.system.name": "postgresql",
    "db.query.text":
      "UPDATE agent_controller.execution_configuration_sync SET applied_revision=$1 WHERE organization_id=$2",
  });
  return trace;
}
