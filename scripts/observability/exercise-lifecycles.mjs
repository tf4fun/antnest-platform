import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs, parseEnv } from "node:util";
import { GatewayClient } from "../identity-closeout/support.mjs";
import { inspectWorkflow } from "./lifecycle-workflow.mjs";
import {
  assertAgentDisabled,
  assertAgentDeleted,
  waitForAgentReady,
} from "../verification/agent-state.mjs";

const { values } = parseArgs({
  options: {
    gateway: { type: "string", default: "http://127.0.0.1:8090" },
    jaeger: { type: "string", default: "http://127.0.0.1:16686" },
    "env-file": { type: "string", default: ".env" },
    template: { type: "string" },
    revision: { type: "string" },
    kind: { type: "string" },
    agent: { type: "string" },
    "confirm-development": { type: "boolean", default: false },
  },
});
assert(
  values["confirm-development"],
  "explicit development confirmation required",
);
const allKinds = ["create", "rebuild", "disable", "enable", "delete"];
assert(
  !values.kind || allKinds.includes(values.kind),
  "unsupported lifecycle selection",
);
assert(
  !values.agent || (values.kind && values.kind !== "create"),
  "Agent selection requires one lifecycle on an existing Agent",
);
if (values.kind && values.kind !== "create")
  assert(
    /^agent_[a-f0-9]{32}$/u.test(values.agent ?? ""),
    "existing Agent required",
  );
const kinds = values.kind ? [values.kind] : allKinds;
if (kinds.some((kind) => kind === "create" || kind === "rebuild"))
  assert(
    values.template && /^[1-9][0-9]*$/u.test(values.revision ?? ""),
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
const target = {
  template_id: values.template,
  template_revision: Number(values.revision),
};
let agentID = values.agent;
for (const kind of kinds) {
  const path =
    kind === "create"
      ? "/api/admin/agents"
      : `/api/admin/agents/${agentID}/${kind}`;
  const options = {
    status: 202,
    headers: { "Idempotency-Key": randomUUID() },
    body:
      kind === "create"
        ? {
            ...target,
            name: "Temporal lifecycle acceptance",
            owner_user_id: login.principal.user_id,
          }
        : kind === "rebuild"
          ? target
          : {},
  };
  const response = await client.request(path, options);
  agentID ??= response.body.agent.agent_id;
  const requestID = (response.body.operation ?? response.body).request_id;
  assert(
    requestID && /^[a-f0-9]{32}$/u.test(response.traceID),
    "missing operation or trace identity",
  );
  console.log(
    JSON.stringify({
      kind,
      agent_id: agentID,
      request_id: requestID,
      trace_id: response.traceID,
      state: "admitted",
    }),
  );
  let terminal;
  let current;
  const observed = [];
  const recordState = (operation, agent) => {
    const state = {
      operation: operation.state,
      phase: operation.phase,
      lifecycle: agent.lifecycle_state,
      desired: agent.desired_state,
      activation: agent.activation_state,
      runtime: agent.runtime_state,
      execution_published: Boolean(agent.executable_execution_revision),
    };
    if (JSON.stringify(observed.at(-1)) !== JSON.stringify(state)) {
      observed.push(state);
      console.log(JSON.stringify({ kind, agent_id: agentID, state }));
    }
  };
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    const { body } = await client.request(`/api/admin/operations/${requestID}`);
    ({ body: current } = await client.request(`/api/admin/agents/${agentID}`));
    recordState(body, current);
    if (body.state === "completed") {
      terminal = body;
      break;
    }
    assert.equal(
      body.state,
      "running",
      `${kind} failed at ${body.phase}: ${body.error_code ?? "unknown"}`,
    );
    await delay(500);
  }
  assert(terminal, `${kind} did not finish before the acceptance deadline`);
  if (kind === "disable") assertAgentDisabled(current);
  if (kind === "delete") assertAgentDeleted(current);
  // Readiness is a separate acceptance step, not part of operation completion.
  if (["create", "rebuild", "enable"].includes(kind)) {
    current = await waitForAgentReady(async () => {
      const { body: agent } = await client.request(
        `/api/admin/agents/${agentID}`,
      );
      recordState(terminal, agent);
      return agent;
    });
  }
  const { body: before } = await client.request(
    `/api/admin/agents/${agentID}/events?limit=100`,
  );
  const { body: replay } = await client.request(path, options);
  assert.equal((replay.operation ?? replay).request_id, requestID);
  const { body: after } = await client.request(
    `/api/admin/agents/${agentID}/events?limit=100`,
  );
  assert.deepEqual(after, before, "exact request replay changed audit events");
  const { body: replayed } = await client.request(
    `/api/admin/operations/${requestID}`,
  );
  assert.deepEqual(
    replayed,
    terminal,
    "exact request replay changed the terminal result",
  );
  await delay(6000);
  const fetched = await fetch(
    `${values.jaeger}/api/traces/${response.traceID}`,
    { signal: AbortSignal.timeout(10000) },
  );
  assert(fetched.ok, `Jaeger HTTP ${fetched.status}`);
  const document = await fetched.json();
  assert.equal(document.errors?.length ?? 0, 0, "Jaeger query error");
  const result = inspectWorkflow(document.data?.[0], requestID, {
    kind,
    agentID,
    allowRetries: true,
  });
  // Never print RPC bodies, cookies or provider credentials from development traces.
  console.log(
    JSON.stringify({
      kind,
      agent_id: agentID,
      request_id: requestID,
      state: "verified",
      replay_verified: true,
      observed_states: observed,
      ...result,
      url: `${values.jaeger}/trace/${response.traceID}`,
    }),
  );
}
