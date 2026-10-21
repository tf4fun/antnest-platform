import assert from "node:assert/strict";
import test from "node:test";
import { loadAdmissionFixture } from "../e2e/edge-gateway/resolve-cache-load-admission-fixtures.mjs";

const moduleURL = new URL("./resolve-cache-business.mjs", import.meta.url);
const { createLoadBusinessReceipt, assertLoadBusinessReceipt } = await import(
  moduleURL
).catch((error) => {
  if (error.code !== "ERR_MODULE_NOT_FOUND" || error.url !== moduleURL.href)
    throw error;
  return {};
});

function requireAPI() {
  assert.equal(
    typeof createLoadBusinessReceipt,
    "function",
    "createLoadBusinessReceipt must be exported",
  );
  assert.equal(
    typeof assertLoadBusinessReceipt,
    "function",
    "assertLoadBusinessReceipt must be exported",
  );
}

let template;
function fixture() {
  if (!template) {
    const { f, report } = loadAdmissionFixture();
    const ownerLifecycle = structuredClone(report.owner_lifecycle);
    delete ownerLifecycle.acp_clock;
    // Reuse the existing HTTP and container fixtures, without passing their
    // synthetic Span inventory or its admission result to the business API.
    template = {
      wire: structuredClone(f.wire),
      ownerLifecycle,
      ownerScope: structuredClone(f.ownerScope),
    };
  }
  return structuredClone(template);
}

function beforeHalfTTL(measurement) {
  const last = measurement.requests.at(-1);
  last.started_at = measurement.requests[0].completed_at + 4999;
  last.headers_at = last.started_at + 1;
  last.completed_at = last.started_at + 2;
}

function overlappingDrain(owner, measurement) {
  owner.requested_at = measurement.completed_at - 1;
  for (const state of Object.values(owner.before))
    state.at = owner.requested_at - 1;
}

test("load business receipt validates complete HTTP responses and real owner restoration without Span evidence", () => {
  requireAPI();
  const input = fixture();
  const original = structuredClone(input);
  assert.equal(Object.hasOwn(input.ownerLifecycle, "acp_clock"), false);
  assert.equal(Object.hasOwn(input, "traces"), false);
  assert.equal(Object.hasOwn(input, "archived_trace_ids"), false);

  const receipt = createLoadBusinessReceipt(input);
  const measurement = structuredClone(input.wire);
  for (const row of measurement.requests) delete row.body;
  assert.deepEqual(receipt, {
    schema: "resolve-cache-load-business/v1",
    status: "passed",
    owner_scope: input.ownerScope,
    exchanges: 100,
    elapsed_ms: input.wire.completed_at - input.wire.started_at,
    measurement,
    owner_lifecycle: input.ownerLifecycle,
  });
  assert.equal(assertLoadBusinessReceipt(receipt), receipt);
  assert.equal(
    receipt.measurement.requests.some((row) => Object.hasOwn(row, "body")),
    false,
  );
  assert.deepEqual(
    input,
    original,
    "factory must preserve the private raw wire",
  );
});

test("load business receipt does not require response Trace IDs", () => {
  requireAPI();
  const input = fixture();
  for (const row of input.wire.requests) delete row.trace_id;
  assertLoadBusinessReceipt(createLoadBusinessReceipt(input));
});

test("load business receipt retains original validated metadata without inventing Resolve or SDK cleanup proof", () => {
  requireAPI();
  const input = fixture();
  input.wire.requests[0].content_type = "application/json; charset=utf-8";
  input.wire.requests[0].cache_control = "private, no-store";
  const receipt = createLoadBusinessReceipt(input);
  assert.equal(
    receipt.measurement.requests[0].content_type,
    input.wire.requests[0].content_type,
  );
  assert.equal(
    receipt.measurement.requests[0].cache_control,
    input.wire.requests[0].cache_control,
  );
  assert.equal(assertLoadBusinessReceipt(receipt), receipt);
  for (const name of [
    "gateway_rpc_attempts",
    "identity_rpc_receipts",
    "background_refreshes",
    "refreshes",
    "cold_initialize_trace_id",
    "final_refresh_trigger_trace_id",
    "owner_cleanup",
    "delete_span_id",
    "sdk_delete_succeeded",
    "archived_trace_ids",
    "strict_trace",
  ]) {
    assert.equal(Object.hasOwn(receipt, name), false, name);
    assert.equal(Object.hasOwn(receipt.measurement, name), false, name);
    assert.equal(Object.hasOwn(receipt.owner_lifecycle, name), false, name);
  }
});

for (const [name, mutate] of [
  ["missing owner scope", (f) => delete f.ownerScope],
  ["null owner scope", (f) => (f.ownerScope = null)],
  ["missing organization", (f) => delete f.ownerScope.organization_id],
  ["empty organization", (f) => (f.ownerScope.organization_id = "")],
  ["non-string organization", (f) => (f.ownerScope.organization_id = 7)],
  ["missing owner", (f) => delete f.ownerScope.user_id],
  ["empty owner", (f) => (f.ownerScope.user_id = "")],
  ["non-string owner", (f) => (f.ownerScope.user_id = false)],
  ["missing owner Agent", (f) => delete f.ownerScope.agent_id],
  ["foreign owner Agent", (f) => (f.ownerScope.agent_id = "foreign")],
  [
    "foreign wire Agent with otherwise matching routes",
    (f) => {
      f.wire.agent_id = "foreign";
      for (const row of f.wire.requests)
        row.path = "/api/app/workspace/v1/agents/foreign/sessions";
    },
  ],
  [
    "foreign owner lifecycle Agent",
    (f) => (f.ownerLifecycle.agent_id = "foreign"),
  ],
  ["99 responses", (f) => f.wire.requests.pop()],
  [
    "over eight seconds",
    (f) => (f.wire.completed_at = f.wire.started_at + 8001),
  ],
  [
    "overlapping HTTP requests",
    (f) =>
      (f.wire.requests[50].started_at = f.wire.requests[49].completed_at - 1),
  ],
  ["missing response body", (f) => delete f.wire.requests[50].body],
  [
    "invalid session page body",
    (f) => (f.wire.requests[50].body = { items: {}, nextCursor: null }),
  ],
  [
    "private field in a session page body",
    (f) => {
      f.wire.requests[50].body.items = [
        {
          sessionId: "session",
          title: "A session",
          updatedAt: null,
          activeOperationId: null,
          mcp_endpoint: "http://private-runtime",
        },
      ];
    },
  ],
  [
    "incomplete response body",
    (f) => (f.wire.requests[50].body_complete = false),
  ],
  ["zero response bytes", (f) => (f.wire.requests[50].body_bytes = 0)],
  ["changed session Cookie", (f) => (f.wire.requests[50].set_cookie_count = 1)],
  ["non-200 HTTP response", (f) => (f.wire.requests[50].status = 503)],
  ["final request before half TTL", (f) => beforeHalfTTL(f.wire)],
]) {
  test(`load business factory rejects ${name}`, () => {
    requireAPI();
    const input = fixture();
    assertLoadBusinessReceipt(createLoadBusinessReceipt(input));
    mutate(input);
    assert.throws(() => createLoadBusinessReceipt(input));
  });
}

for (const [name, mutate] of [
  [
    "container replacement during drain",
    (owner) => (owner.after["agent-ui"].id = "f".repeat(64)),
  ],
  [
    "container replacement during restoration",
    (owner) => (owner.restore.after["agent-ui"].id = "f".repeat(64)),
  ],
  ["forced drain", (owner) => (owner.forced_drain = true)],
  ["uninspected stop log", (owner) => (owner.log_checked = false)],
  ["abnormal UI exit", (owner) => (owner.after["agent-ui"].exit_code = 137)],
  ["unrestored owner", (owner) => (owner.restored = false)],
  ["missing restoration", (owner) => delete owner.restore],
  [
    "lifecycle failure",
    (owner) => owner.failures.push("controlled stop failure"),
  ],
  [
    "restoration over thirty seconds",
    (owner) =>
      (owner.restore.completed_at = owner.restore.requested_at + 30001),
  ],
  [
    "restoration before the owner stopped",
    (owner) => (owner.restore.requested_at = owner.stopped_at - 1),
  ],
  [
    "peer restart during restoration",
    (owner) => (owner.restore.after["identity-service"].restart_count += 1),
  ],
  [
    "participant baseline after load dispatch",
    (owner, measurement) =>
      (owner.baseline["identity-service"].at = measurement.started_at + 1),
  ],
  ["owner drain overlapping load responses", overlappingDrain],
]) {
  test(`load business factory and public admission reject ${name}`, () => {
    requireAPI();
    const input = fixture();
    const receipt = createLoadBusinessReceipt(input);
    assert.equal(assertLoadBusinessReceipt(receipt), receipt);
    mutate(input.ownerLifecycle, input.wire);
    mutate(receipt.owner_lifecycle, receipt.measurement);
    assert.throws(() => createLoadBusinessReceipt(input));
    assert.throws(() => assertLoadBusinessReceipt(receipt));
  });
}

for (const [name, mutate] of [
  ["missing schema", (r) => delete r.schema],
  ["unknown schema", (r) => (r.schema = "resolve-cache-load-business/v2")],
  ["failed status", (r) => (r.status = "failed")],
  ["wrong exchange count", (r) => (r.exchanges = 99)],
  ["elapsed mismatch", (r) => (r.elapsed_ms += 1)],
  ["missing owner scope", (r) => delete r.owner_scope],
  ["empty organization", (r) => (r.owner_scope.organization_id = "")],
  ["empty owner", (r) => (r.owner_scope.user_id = "")],
  ["foreign owner Agent", (r) => (r.owner_scope.agent_id = "foreign")],
  ["foreign lifecycle Agent", (r) => (r.owner_lifecycle.agent_id = "foreign")],
  [
    "foreign measurement Agent with matching routes",
    (r) => {
      r.measurement.agent_id = "foreign";
      for (const row of r.measurement.requests)
        row.path = "/api/app/workspace/v1/agents/foreign/sessions";
    },
  ],
  ["legacy wire policy", (r) => (r.measurement.policy_revision = 3)],
  ["wrong transport", (r) => (r.measurement.transport = "wss")],
  ["wrong profile", (r) => (r.measurement.profile = "console")],
  ["99 public responses", (r) => r.measurement.requests.pop()],
  [
    "over eight seconds with matching elapsed summary",
    (r) => {
      r.measurement.completed_at = r.measurement.started_at + 8001;
      r.elapsed_ms = 8001;
    },
  ],
  [
    "overlapping public HTTP requests",
    (r) =>
      (r.measurement.requests[50].started_at =
        r.measurement.requests[49].completed_at - 1),
  ],
  [
    "response outside the measured interval",
    (r) =>
      (r.measurement.requests[99].completed_at =
        r.measurement.completed_at + 1),
  ],
  [
    "incomplete public body",
    (r) => (r.measurement.requests[50].body_complete = false),
  ],
  [
    "zero public body bytes",
    (r) => (r.measurement.requests[50].body_bytes = 0),
  ],
  ["failed public response", (r) => (r.measurement.requests[50].status = 503)],
  [
    "changed public Cookie",
    (r) => (r.measurement.requests[50].set_cookie_count = 1),
  ],
  ["half TTL not reached", (r) => beforeHalfTTL(r.measurement)],
  [
    "wrong HTTP route",
    (r) => (r.measurement.requests[50].path = "/api/app/other"),
  ],
  [
    "duplicate response receipt",
    (r) =>
      (r.measurement.requests[50] = structuredClone(
        r.measurement.requests[49],
      )),
  ],
  [
    "non-JSON metadata",
    (r) => (r.measurement.requests[50].content_type = "text/plain"),
  ],
  [
    "cacheable metadata",
    (r) => (r.measurement.requests[50].cache_control = "public"),
  ],
  [
    "body retained in public measurement",
    (r) =>
      (r.measurement.requests[50].body = { private: "not public metadata" }),
  ],
]) {
  test(`load business admission independently rejects ${name}`, () => {
    requireAPI();
    const receipt = createLoadBusinessReceipt(fixture());
    assert.equal(assertLoadBusinessReceipt(receipt), receipt);
    mutate(receipt);
    assert.throws(() => assertLoadBusinessReceipt(receipt));
  });
}
