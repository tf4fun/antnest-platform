import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs, parseEnv } from "node:util";
import { GatewayClient } from "../identity-closeout/support.mjs";
import {
  readCreationBinding,
  verifyCreationBinding,
} from "./creation-binding.mjs";
import { inspectWorkflow } from "./lifecycle-workflow.mjs";
import {
  creationObservation,
  inspectReadiness,
  verifyCreationReplay,
} from "./runtime-readiness.mjs";
import { durablePath } from "../../support/storage.mjs";

const { values } = parseArgs({
  options: {
    gateway: { type: "string", default: "http://127.0.0.1:8090" },
    jaeger: { type: "string", default: "http://127.0.0.1:16686" },
    "env-file": { type: "string", default: ".env" },
    template: { type: "string" },
    revision: { type: "string" },
    agent: { type: "string" },
    request: { type: "string" },
    trace: { type: "string" },
    "postgres-container": { type: "string" },
    name: { type: "string", default: "Creation and readiness acceptance" },
    "confirm-development": { type: "boolean", default: false },
    "retain-for-review": { type: "boolean", default: false },
  },
});
values["env-file"] = durablePath(values["env-file"]);
assert(
  values["confirm-development"] && values["retain-for-review"],
  "confirm development and explicit retention of the single acceptance Agent",
);
assert(
  values["postgres-container"],
  "PostgreSQL acceptance container required",
);
const existing = Boolean(values.agent);
assert(
  !existing ||
    (/^agent_[a-f0-9]{32}$/u.test(values.agent) &&
      values.request &&
      /^[a-f0-9]{32}$/u.test(values.trace ?? "")),
  "existing Agent requires request and creation trace",
);
assert(
  existing || (values.template && /^[1-9][0-9]*$/u.test(values.revision ?? "")),
  "template and revision required",
);
const env = parseEnv(readFileSync(values["env-file"], "utf8"));
const client = new GatewayClient(values.gateway);
const { body: login } = await client.request("/api/session/login", {
  body: {
    organization_slug: env.ANTNEST_BOOTSTRAP_ORGANIZATION_SLUG,
    email: env.ANTNEST_BOOTSTRAP_ADMIN_EMAIL,
    password: env.ANTNEST_BOOTSTRAP_ADMIN_PASSWORD,
  },
});
const options = {
  status: 202,
  headers: { "Idempotency-Key": randomUUID() },
  body: {
    name: values.name,
    template_id: values.template,
    template_revision: Number(values.revision),
    owner_user_id: login.principal.user_id,
  },
};
// Never retry an uncertain create with a new identity or dump its payload.
if (!existing)
  console.log(
    JSON.stringify({
      idempotency_key: options.headers["Idempotency-Key"],
      state: "submitting",
    }),
  );
const admission = existing
  ? {
      body: {
        agent: { agent_id: values.agent },
        operation: { request_id: values.request },
      },
      traceID: values.trace,
    }
  : await client.request("/api/admin/agents", options);
const agentID = admission.body.agent.agent_id;
const requestID = admission.body.operation.request_id;
const identity = {
  agent_id: agentID,
  request_id: requestID,
  trace_id: admission.traceID,
};
console.log(
  JSON.stringify({
    ...identity,
    state: existing ? "reviewing_existing" : "admitted",
  }),
);
const seen = [];
let operation, agent, events;
const deadline = Date.now() + 240000;
while (Date.now() < deadline) {
  ({ body: operation } = await client.request(
    "/api/admin/operations/" + requestID,
  ));
  ({ body: agent } = await client.request("/api/admin/agents/" + agentID));
  ({
    body: { events },
  } = await client.request(
    "/api/admin/agents/" + agentID + "/events?limit=100",
  ));
  const state = {
    operation: operation.state,
    agent: agent.lifecycle_state,
    activation: agent.activation_state,
    runtime: agent.runtime_state,
    execution_published: Boolean(agent.executable_execution_revision),
  };
  if (JSON.stringify(seen.at(-1)) !== JSON.stringify(state)) {
    seen.push(state);
    console.log(JSON.stringify({ ...identity, state }));
  }
  assert.notEqual(
    operation.state,
    "failed",
    "creation failed: " + (operation.error_code ?? "unknown"),
  );
  if (
    operation.state === "completed" &&
    agent.lifecycle_state === "created" &&
    agent.activation_state === "enabled" &&
    agent.runtime_state === "available" &&
    events.some((event) => event.event_type === "agent_ready")
  )
    break;
  await delay(500);
}
const observation = creationObservation({
  agent,
  operation,
  events,
  creationTraceID: admission.traceID,
});
if (!existing) {
  const beforeEvents = events;
  const { body: replay } = await client.request("/api/admin/agents", options);
  const { body: replayedOperation } = await client.request(
    "/api/admin/operations/" + requestID,
  );
  const { body: after } = await client.request(
    "/api/admin/agents/" + agentID + "/events?limit=100",
  );
  verifyCreationReplay({
    agentID,
    operation,
    events: beforeEvents,
    replay,
    replayedOperation,
    afterEvents: after.events,
  });
}
await delay(6000);
async function trace(id) {
  const response = await fetch(values.jaeger + "/api/traces/" + id, {
    signal: AbortSignal.timeout(10000),
  });
  assert(response.ok, "Jaeger request failed");
  const result = await response.json();
  assert.equal(result.errors?.length ?? 0, 0);
  assert(result.data?.[0], "trace has not been exported");
  assert.equal(result.data[0].traceID, id, "Jaeger returned a different trace");
  return result.data[0];
}
const created = inspectWorkflow(await trace(admission.traceID), requestID, {
  kind: "create",
  agentID,
  allowRetries: true,
  runtimeRevision: observation.runtimeRevision,
});
const ready = inspectReadiness(await trace(observation.traceID), observation);
const binding = verifyCreationBinding(
  readCreationBinding(values["postgres-container"], agentID),
  {
    ...observation,
    requestID,
    creationTraceID: admission.traceID,
    runtimeExecutionID: ready.runtime_execution_id,
    mcpEndpoint: ready.mcp_endpoint,
  },
);
console.log(
  JSON.stringify({
    ...identity,
    state: "verified",
    replay_verified: existing ? null : true,
    persisted_binding: binding,
    retained_for_review: true,
    observed_states: seen,
    created_at: observation.created_at,
    ready_at: observation.ready_at,
    execution_revision: observation.executionRevision,
    runtime_revision: observation.runtimeRevision,
    creation: created,
    readiness: ready,
    creation_url: values.jaeger + "/trace/" + admission.traceID,
    readiness_url: values.jaeger + "/trace/" + observation.traceID,
    agent_url: values.gateway + "/agents/" + agentID,
  }),
);
