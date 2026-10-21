import assert from "node:assert/strict";
import test from "node:test";
import { privatePlanRequestFixture } from "../acp-plan/private-request.fixture.mjs";
import { barrierTraceFixture } from "../acp-progress/control-trace.fixture.mjs";
import { privateACPDiagnosticInventory } from "../observability/private-acp-inventory.mjs";

const implementation = await import("./private-denial-trace.mjs").catch(
  (error) => {
    if (
      error.code !== "ERR_MODULE_NOT_FOUND" ||
      !error.message.includes("/workspace-closeout/private-denial-trace.mjs")
    )
      throw error;
    return {};
  },
);
function inspector() {
  assert.equal(
    typeof implementation.inspectWorkspaceAccessDeniedTrace,
    "function",
  );
  return implementation.inspectWorkspaceAccessDeniedTrace;
}

function fixture({ preparationRead = false } = {}) {
  const f = privatePlanRequestFixture({
    version: 1,
    method: "session/prompt",
    denial: "access_denied",
  });
  Object.assign(f.expected, {
    kind: "request",
    outcome: "rejected",
    rejection: "access_denied",
  });
  Object.assign(f.request, { startTime: 2000, duration: 14000 });
  Object.assign(f.application, { startTime: 3000, duration: 12000 });
  f.application.logs[0].timestamp = 14000;
  f.queries = structuredClone(
    barrierTraceFixture().queries.slice(0, preparationRead ? 3 : 2),
  );
  for (const span of f.queries) {
    span.processID = f.application.processID;
    span.traceID = f.trace.traceID;
    span.references = [
      {
        refType: "CHILD_OF",
        traceID: f.trace.traceID,
        spanID: f.application.spanID,
      },
    ];
  }
  f.trace.spans.push(...f.queries);
  return f;
}

test("revoked Workspace Prompt stops after Session and MCP reads with the original access denial", () => {
  const inspect = inspector();
  const f = fixture(),
    before = structuredClone({ trace: f.trace, expected: f.expected });
  const report = inspect(f.trace, f.expected, [], []);
  assert.equal(report.no_execution, true);
  assert.equal(report.sql_spans, 2);
  assert.equal(report.runtime_tool_calls, 0);
  assert.equal(report.owned_error_spans.length, 2);
  const inventory = privateACPDiagnosticInventory(
    [f.trace, f.connectionTrace],
    [report],
    new Set(["command-rejection"]),
  );
  assert.equal(inventory.raw_error_inventory.length, 2);
  assert.deepEqual({ trace: f.trace, expected: f.expected }, before);
});

test("already revoked Workspace Prompt cannot enter temporary scope preparation", () => {
  const f = fixture({ preparationRead: true });
  assert.throws(() => inspector()(f.trace, f.expected, [], []));
});

for (const [name, change] of Object.entries({
  missing_session: (f) =>
    f.trace.spans.splice(f.trace.spans.indexOf(f.queries[0]), 1),
  missing_mcp_revision: (f) =>
    f.trace.spans.splice(f.trace.spans.indexOf(f.queries[1]), 1),
  duplicate_session_read: (f) =>
    f.field(
      f.queries[1],
      "db.query.text",
      f.queries[0].tags.find((tag) => tag.key === "db.query.text").value,
    ),
  extra_protection_read: (f) =>
    f.trace.spans.push(barrierTraceFixture().queries[4]),
  second_session_read: (f) =>
    f.trace.spans.push(barrierTraceFixture().queries[3]),
  write_before_denial: (f) =>
    f.field(f.queries[1], "db.query.text", "UPDATE runs SET state='running'"),
  foreign_database: (f) =>
    f.field(f.queries[0], "db.namespace", "antnest_identity"),
  failed_query: (f) => f.field(f.queries[0], "error", true),
  foreign_query_parent: (f) =>
    (f.queries[0].references[0].spanID = f.request.spanID),
  wrong_query_order: (f) => (f.queries[1].startTime = 3500),
  overlapping_query: (f) => (f.queries[0].duration = 8000),
  query_ends_after_denial: (f) => (f.queries[1].duration = 9000),
  query_after_denial: (f) => (f.queries[1].startTime = 14500),
  payload_capture: (f) =>
    f.field(f.queries[0], "db.query.parameters", "secret"),
  foreign_agent_alias: (f) => f.field(f.application, "agent.id", "other"),
  foreign_session_alias: (f) => f.field(f.application, "session.id", "other"),
  retryable_reply: (f) => (f.expected.rejectionReceipt.retryable = true),
  foreign_denial: (f) => (f.expected.rejection = "session_access_denied"),
  foreign_input_session: (f) => (f.expected.inputSessionID = "other"),
  disconnected_request: (f) => (f.expected.closedBeforeResponse = true),
  successful_receipt: (f) => (f.expected.requestReceipt = {}),
  original_error_removed: (f) => (f.application.logs = []),
  foreign_provider: (f) => (f.requests = [{ trace_id: f.trace.traceID }]),
}))
  test(`Workspace access denial rejects ${name}`, () => {
    const inspect = inspector();
    const f = fixture();
    change(f);
    assert.throws(() => inspect(f.trace, f.expected, [], f.requests ?? []));
  });
