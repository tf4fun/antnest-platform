import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs, parseEnv } from "node:util";
import { GatewayClient } from "../identity-closeout/support.mjs";
import { inspectHTTPTrace } from "./evidence.mjs";
import { owningServer, tag } from "./trace-tree.mjs";
import { durablePath } from "../../support/storage.mjs";

const { values } = parseArgs({
  options: {
    gateway: { type: "string", default: "http://127.0.0.1:8090" },
    jaeger: { type: "string", default: "http://127.0.0.1:16686" },
    "env-file": { type: "string", default: ".env" },
    model: { type: "string" },
    image: { type: "string", default: "antnest/antnest-runtime:local" },
    "confirm-development": { type: "boolean", default: false },
  },
});
values["env-file"] = durablePath(values["env-file"]);
assert(
  values["confirm-development"] && values.model,
  "development confirmation and existing model required",
);
const settings = parseEnv(readFileSync(values["env-file"], "utf8"));
const client = new GatewayClient(values.gateway);
await client.request("/api/session/login", {
  body: {
    organization_slug: settings.ANTNEST_BOOTSTRAP_ORGANIZATION_SLUG,
    email: settings.ANTNEST_BOOTSTRAP_ADMIN_EMAIL,
    password: settings.ANTNEST_BOOTSTRAP_ADMIN_PASSWORD,
  },
});
try {
  const options = {
    status: 201,
    headers: { "Idempotency-Key": randomUUID() },
    body: {
      name: "Template flow acceptance",
      model_profile_id: values.model,
      system_prompt: "Assist the user.",
      max_model_requests: 16,
      runtime: { image_ref: values.image },
    },
  };
  const created = await client.request("/api/admin/templates", options);
  console.log(
    JSON.stringify({
      template_id: created.body.template_id,
      trace_id: created.traceID,
      state: "created",
    }),
  );
  assert.equal(created.body.runtime.image_ref, values.image);
  const replay = await client.request("/api/admin/templates", options);
  assert.deepEqual(replay.body, created.body);
  const read = await client.request(
    `/api/admin/templates/${created.body.template_id}`,
  );
  assert.equal(read.body.runtime.image_ref, values.image);
  assert.equal(read.body.revision, 1);
  await delay(6000);
  const response = await fetch(
    `${values.jaeger}/api/traces/${created.traceID}`,
    { signal: AbortSignal.timeout(10000) },
  );
  assert(response.ok, `Jaeger HTTP ${response.status}`);
  const document = await response.json();
  assert.equal(document.errors?.length ?? 0, 0);
  const trace = document.data?.[0];
  const result = inspectHTTPTrace(trace, {
    rootService: "edge-gateway",
    route: "/api/admin/{path...}",
    status: 201,
    hops: [
      ["edge-gateway", "identity-service", 1],
      ["edge-gateway", "admin-console", 1],
      ["admin-console", "agent-controller", 1],
    ],
  });
  assert.deepEqual(result.services, [
    "admin-console",
    "agent-controller",
    "edge-gateway",
    "identity-service",
  ]);
  const { database } = owningServer(trace, {
    service: "agent-controller",
    clientService: "admin-console",
    method: "POST",
    route: "/internal/agent-templates",
    status: 201,
  });
  assert(database.length > 0, "missing database execution evidence");
  const transactions = trace.spans.filter(
    (span) =>
      span.operationName === "postgresql transaction" &&
      trace.processes[span.processID].serviceName === "agent-controller",
  );
  assert.equal(
    transactions.length,
    1,
    "one catalog write transaction required",
  );
  assert.equal(
    tag(transactions[0], "antnest.transaction.outcome"),
    "committed",
  );
  console.log(
    JSON.stringify({
      ...result,
      template_id: created.body.template_id,
      revision: 1,
      original_image_preserved: true,
      replay_verified: true,
      transactions: transactions.length,
      url: `${values.jaeger}/trace/${created.traceID}`,
    }),
  );
} finally {
  await client.request("/api/session", { method: "DELETE", status: 204 });
}
