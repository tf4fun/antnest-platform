import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseArgs, parseEnv } from "node:util";
import { GatewayClient } from "../identity-closeout/support.mjs";
import { collectTrace } from "./collect.mjs";
import { inspectHTTPTrace } from "./evidence.mjs";
import { owningServer, tag } from "./trace-tree.mjs";
import { durablePath } from "../../support/storage.mjs";

const { values } = parseArgs({
  options: {
    gateway: { type: "string", default: "http://127.0.0.1:8090" },
    jaeger: { type: "string", default: "http://127.0.0.1:16686" },
    "env-file": { type: "string", default: ".env" },
    database: { type: "string", default: "antnest_egress" },
    agent: { type: "string" },
    "confirm-development": { type: "boolean", default: false },
  },
});
values["env-file"] = durablePath(values["env-file"]);
assert(
  values["confirm-development"] && values.agent,
  "development confirmation and existing Agent required",
);
const settings = parseEnv(readFileSync(values["env-file"], "utf8"));
const client = new GatewayClient(values.gateway);
const { body: login } = await client.request("/api/session/login", {
  body: {
    organization_slug: settings.ANTNEST_BOOTSTRAP_ORGANIZATION_SLUG,
    email: settings.ANTNEST_BOOTSTRAP_ADMIN_EMAIL,
    password: settings.ANTNEST_BOOTSTRAP_ADMIN_PASSWORD,
  },
});
try {
  const path = `/api/admin/agents/${encodeURIComponent(values.agent)}/network-policy`;
  const { body: before } = await client.request(path);
  assert(["allow_all", "deny_all"].includes(before.action));
  // An unchanged CAS exercises the actual transaction without changing access.
  const saved = await client.request(path, {
    method: "PUT",
    headers: {
      "X-Antnest-Expected-Principal": encodeURIComponent(
        JSON.stringify([
          login.principal.organization_id,
          login.principal.user_id,
        ]),
      ),
    },
    body: {
      action: before.action,
      expected_resource_version: before.resource_version,
    },
  });
  assert.equal(saved.body.action, before.action);
  assert.equal(saved.body.resource_version, before.resource_version);
  const { body: after } = await client.request(path);
  assert.deepEqual(after, before, "unchanged policy CAS altered network state");
  const result = await collectTrace(values.jaeger, saved.traceID, (trace) => {
    const summary = inspectHTTPTrace(trace, {
      rootService: "edge-gateway",
      route: "/api/admin/{path...}",
      status: 200,
      hops: [
        ["edge-gateway", "identity-service", 1],
        ["edge-gateway", "admin-console", 1],
        ["admin-console", "agent-controller", 1],
        ["agent-controller", "antnest-runtime-egress", 1],
      ],
    });
    const { server, database } = owningServer(trace, {
      service: "antnest-runtime-egress",
      clientService: "agent-controller",
      method: "PUT",
      route: "/internal/agent-policy-assignments/{agent_id}",
      status: 200,
    });
    const spans = trace.spans.filter(
      (span) =>
        trace.processes[span.processID].serviceName ===
          "antnest-runtime-egress" &&
        tag(span, "db.system.name") === "postgresql",
    );
    const transactions = spans.filter(
      (span) => span.operationName === "postgresql transaction",
    );
    assert.equal(transactions.length, 1);
    const transaction = transactions[0];
    assert.equal(tag(transaction, "antnest.transaction.outcome"), "committed");
    assert(
      transaction.references.some(
        (ref) => ref.refType === "CHILD_OF" && ref.spanID === server.spanID,
      ),
    );
    const queries = spans.filter((span) => tag(span, "span.kind") === "client");
    assert.deepEqual(
      queries
        .toSorted((a, b) => a.startTime - b.startTime)
        .map((span) => span.operationName),
      [
        "SELECT",
        "SELECT",
        "SELECT",
        "SELECT",
        "BEGIN",
        "SELECT",
        "SELECT",
        "SELECT",
        "COMMIT",
      ],
    );
    assert.equal(database.length, 7);
    const inTransaction = queries.filter((span) =>
      span.references.some(
        (ref) =>
          ref.refType === "CHILD_OF" && ref.spanID === transaction.spanID,
      ),
    );
    assert.deepEqual(
      inTransaction
        .toSorted((a, b) => a.startTime - b.startTime)
        .map((span) => span.operationName),
      ["BEGIN", "SELECT", "SELECT", "SELECT", "COMMIT"],
    );
    for (const span of spans) {
      assert.equal(tag(span, "db.namespace"), values.database);
      assert.equal(typeof tag(span, "server.address"), "string");
      assert.equal(typeof tag(span, "server.port"), "number");
    }
    for (const span of queries) {
      assert.equal(span.operationName, tag(span, "db.operation.name"));
      assert.notEqual(tag(span, "error"), true);
      assert(
        span.references.some(
          (ref) =>
            ref.refType === "CHILD_OF" && ref.spanID === transaction.spanID,
        ) ||
          (!inTransaction.includes(span) &&
            span.references.some(
              (ref) =>
                ref.refType === "CHILD_OF" && ref.spanID === server.spanID,
            )),
      );
    }
    return {
      ...summary,
      egress_sql: queries.length,
      transaction_primitives: inTransaction.length,
      transactions: 1,
      policy_unchanged: true,
    };
  });
  console.log(
    JSON.stringify({
      ...result,
      url: `${values.jaeger}/trace/${saved.traceID}`,
    }),
  );
} finally {
  await client.request("/api/session", { method: "DELETE", status: 204 });
}
