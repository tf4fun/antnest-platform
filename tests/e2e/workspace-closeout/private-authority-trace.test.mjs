import assert from "node:assert/strict";
import test from "node:test";
import { inspect as describe } from "node:util";
import { workspaceAuthorityTraceFixture as fixture } from "./private-authority-trace.fixture.mjs";

const implementation = await import("./private-authority-trace.mjs").catch(
  (error) => {
    if (
      error.code !== "ERR_MODULE_NOT_FOUND" ||
      !error.message.includes("/workspace-closeout/private-authority-trace.mjs")
    )
      throw error;
    return {};
  },
);
const inspect = (f) => {
  assert.equal(
    typeof implementation.inspectWorkspaceAuthorityTrace,
    "function",
  );
  return implementation.inspectWorkspaceAuthorityTrace(f.trace, f.expected, [
    "workspace-cct-private-fixture",
  ]);
};
for (const status of [200, 401])
  test(`actual Identity ${status} binds the original CLIENT, Principal, body and unique token read`, () => {
    const f = fixture(status),
      before = structuredClone({ trace: f.trace, expected: f.expected });
    const report = inspect(f);
    assert.equal(report.topology, "passed");
    assert.equal(report.status, status);
    assert.equal(report.raw_error_inventory.length, status === 401 ? 2 : 0);
    assert.equal(report.owned_error_spans.length, status === 401 ? 2 : 0);
    assert.equal(report.diagnostic_inventory_verified, true);
    assert.equal(report.strict_trace, status === 401 ? "failed" : "passed");
    assert.deepEqual({ trace: f.trace, expected: f.expected }, before);
  });

for (const [name, mutate] of Object.entries({
  foreign_client: (f) => {
    f.expected.clientSpanID = "0".repeat(16);
  },
  foreign_principal: (f) => {
    f.expected.principal = { organization_id: "other", user_id: "other" };
  },
  foreign_session: (f) => {
    f.expected.session_digest = "0".repeat(64);
  },
  mismatched_header: (f) => {
    f.receipt.response_trace_id = "0".repeat(32);
  },
  unclosed_client: (f) => {
    f.receipt.client_ended = false;
  },
  wrong_workload: (f) => {
    f.receipt.request_body.profile = "console";
  },
  partial_original_body: (f) => {
    f.receipt.body_bytes--;
  },
  failed_reader: (f) => {
    f.receipt.errors.push("original reader failed");
  },
  wrong_wire_status: (f) => {
    f.set(f.client, "http.response.status_code", 503);
  },
  new_query: (f) => {
    f.set(f.sql, "db.query.text", "UPDATE api_tokens SET revoked_at=now()");
  },
  wrong_database: (f) => {
    f.set(f.sql, "db.namespace", "antnest_agent_acp");
  },
  missing_token: (f) => {
    f.set(f.sql, "pgx.rows_affected", 0);
  },
  failed_sql: (f) => {
    f.set(f.sql, "error", true);
  },
  detached_sql: (f) => {
    f.sql.references[0].spanID = f.client.spanID;
  },
  unjoined_sql: (f) => {
    f.sql.startTime = f.server.startTime + f.server.duration + 1000;
  },
  secret_capture: (f) => {
    f.set(f.sql, "db.query.parameters", "workspace-cct-private-fixture");
  },
  extra_work: (f) => {
    f.trace.spans.push({ ...structuredClone(f.sql), spanID: "extra" });
  },
}))
  test(`Identity source refuses ${name}`, () => {
    const f = fixture();
    mutate(f);
    assert.throws(() => inspect(f));
  });

for (const [name, mutate] of Object.entries({
  borrowed_scope: (f) => {
    f.expected.scope.kind = "connection";
  },
  preceded_revocation: (f) => {
    f.expected.after = f.receipt.request_started_at + 1;
  },
  surviving_token: (f) => {
    f.set(f.sql, "pgx.rows_affected", 1);
  },
  wrong_client_error: (f) => {
    f.set(f.client, "error.type", "401");
  },
  missing_server_event: (f) => {
    f.server.logs = [];
  },
  unrelated_server_failure: (f) => {
    f.set(f.server, "otel.status_code", "ERROR");
  },
  wrong_error_origin: (f) => {
    f.set(f.server, "antnest.error.stage", "dependency");
  },
}))
  test(`Identity revocation refuses ${name}`, () => {
    const f = fixture(401);
    mutate(f);
    assert.throws(() => inspect(f));
  });

test("Identity response mismatches retain private bytes without exposing them through assertion errors", () => {
  const f = fixture(),
    canary = "private-identity-principal-canary";
  const body = JSON.parse(Buffer.from(f.receipt.raw_body_base64, "base64"));
  body.principal.user_id = canary;
  const raw = Buffer.from(JSON.stringify(body));
  f.receipt.raw_body_base64 = raw.toString("base64");
  f.receipt.body_bytes = raw.length;
  f.set(f.client, "http.response.body.size", raw.length);
  f.set(f.server, "http.response.body.size", raw.length);
  let failure;
  try {
    inspect(f);
  } catch (error) {
    failure = error;
  }
  assert(failure);
  assert(!describe(failure, { depth: 20 }).includes(canary));
});
