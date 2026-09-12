import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs, parseEnv } from "node:util";
import { GatewayClient } from "../identity-closeout/support.mjs";
import { inspectWorkflow } from "./lifecycle-workflow.mjs";

const { values } = parseArgs({
  options: {
    gateway: { type: "string", default: "http://127.0.0.1:8090" },
    jaeger: { type: "string", default: "http://127.0.0.1:16686" },
    "env-file": { type: "string", default: ".env" },
    template: { type: "string" },
    revision: { type: "string" },
    "confirm-development": { type: "boolean", default: false },
  },
});
assert(
  values["confirm-development"],
  "explicit development confirmation required",
);
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
let agentID;
for (const kind of ["create", "rebuild", "disable", "enable", "delete"]) {
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
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    const { body } = await client.request(`/api/admin/operations/${requestID}`);
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
      ...result,
      url: `${values.jaeger}/trace/${response.traceID}`,
    }),
  );
}
