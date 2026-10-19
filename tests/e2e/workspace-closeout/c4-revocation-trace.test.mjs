import assert from "node:assert/strict";
import test from "node:test";
import { inspect as format } from "node:util";
import { c4RevocationTraceFixture as fixture } from "./c4-revocation-trace.fixture.mjs";
import { setTag } from "../observability/gateway-resolution-fixtures.mjs";
import { hasDiagnosticError } from "../acp-plan/requests.mjs";
import { privateACPDiagnosticInventory } from "../observability/private-acp-inventory.mjs";
import { with403 } from "../identity-closeout/agent-access-denial.fixture.mjs";

const moduleURL = new URL("./c4-revocation-trace.mjs", import.meta.url);
const { inspectC4RevocationTrace } = await import(moduleURL).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(moduleURL.pathname)
  )
    throw error;
  return {};
});
function inspect(f) {
  assert.equal(typeof inspectC4RevocationTrace, "function");
  return inspectC4RevocationTrace(f.trace, f.expected, [], f.collection);
}
const reasons = new Set([
  "c4-revoked-identity-resolve",
  "c4-revoked-prompt-denial",
  "public-sse-revoked-handler",
  "public-sse-revoked-response",
  "serialization-retry",
]);
test("C4 owns the exact original 403 ancestry without claiming readiness reads", () => {
  const f = with403(fixture());
  f.expected.denial.rawBody = JSON.stringify(f.expected.denial.body);
  const result = inspect(f);
  const owned = result.owned_error_spans.filter(
    (c) => c.trace_id === f.expected.denial.traceID,
  );
  assert.deepEqual(
    new Set(owned.map((c) => c.span_id)),
    new Set([f.denied.upstream.spanID, f.denied.server.spanID]),
  );
  privateACPDiagnosticInventory(
    [...f.collection.traces.values()],
    [result],
    reasons,
  );
});
for (const feed of [false, true])
  test(`C4 owns only the proved original revocation errors (feed=${feed})`, () => {
    const f = fixture({ feed }),
      original = structuredClone([...f.collection.traces]),
      result = inspect(f),
      sources = [...f.collection.traces.values()];
    assert(Array.isArray(result.owned_error_spans));
    const inventory = privateACPDiagnosticInventory(sources, [result], reasons);
    assert(inventory.raw_error_inventory.length > 0);
    for (const claim of inventory.owned_error_spans) {
      const trace = f.collection.traces.get(claim.trace_id),
        span = trace.spans.find((s) => s.spanID === claim.span_id);
      assert(hasDiagnosticError(span));
      assert.equal(claim.service, trace.processes[span.processID].serviceName);
      assert.equal(claim.operation, span.operationName);
    }
    assert(
      result.owned_error_spans.some(
        (c) => c.reason === "c4-revoked-prompt-denial",
      ),
    );
    assert.equal(
      result.owned_error_spans.some(
        (c) => c.reason === "public-sse-revoked-handler",
      ),
      feed,
    );
    assert.deepEqual([...f.collection.traces], original);
  });
test("C4 binds its original page login, global revocation, public Disable, remote EOF and denial", () => {
  const f = fixture(),
    before = structuredClone([f.expected, [...f.collection.traces]]);
  const result = inspect(f);
  assert.equal(result.authorizationCauseVerified, true);
  assert.equal(result.closure, "remote-end");
  assert.equal(result.page_owned, true);
  assert.equal(result.protocol_version, undefined);
  assert.equal(result.cause_proof.owner_revocation_sequence, 17);
  assert.equal(result.cause_proof.revoked_sessions, 1);
  assert.equal(result.login.trace_id, f.login.trace.traceID);
  assert.equal(result.login.token_insert_span_id, f.login.insert.spanID);
  assert.deepEqual([f.expected, [...f.collection.traces]], before);
});

test("C4 proves original truncated browser transport through the exact Gateway revocation feed", () => {
  const f = fixture({ feed: true });
  f.expected.closure.kind = "transport-end";
  f.expected.closure.failure = {
    errorText: "net::ERR_INCOMPLETE_CHUNKED_ENCODING",
  };
  const original = structuredClone([f.expected, [...f.collection.traces]]);
  const result = inspect(f);
  assert.equal(result.closure, "transport-end");
  assert.equal(result.authorizationCauseVerified, true);
  assert(result.cause_proof.feed_sequence > 0);
  assert.deepEqual([f.expected, [...f.collection.traces]], original);
  f.root.logs = f.root.logs.filter((event) => event !== f.feed);
  assert.throws(() => inspect(f));
});

test("a browser transport failure without original Gateway failure cannot prove C4 revocation", () => {
  const f = fixture();
  f.expected.closure.kind = "transport-end";
  f.expected.closure.failure = {
    errorText: "net::ERR_INCOMPLETE_CHUNKED_ENCODING",
  };
  assert.throws(() => inspect(f));
});

test("C4 Gateway revocation cannot authorize a locally aborted browser receipt", () => {
  const f = fixture({ feed: true });
  f.expected.closure.kind = "transport-end";
  f.expected.closure.failure = { errorText: "net::ERR_ABORTED" };
  assert.throws(() => inspect(f));
});
test("C4 accounts for both setup and original page sessions revoked by the same User mutation", () => {
  const f = fixture(),
    second = structuredClone(f.sql.session);
  second.spanID = "user-sql-session-2";
  setTag(f.sql.token, "pgx.rows_affected", 2);
  f.raw.trace.spans.splice(f.raw.trace.spans.indexOf(f.sql.commit), 0, second);
  const result = inspect(f);
  assert.equal(result.cause_proof.revoked_sessions, 2);
  assert.equal(result.cause_proof.session_feed_rows, 2);
});
for (const [name, change] of [
  [
    "missing login archive",
    (f) => f.collection.archivedTraceIDs.delete(f.login.trace.traceID),
  ],
  [
    "missing login source",
    (f) => f.collection.traces.delete(f.login.trace.traceID),
  ],
  [
    "different login route",
    (f) => setTag(f.login.root, "http.route", "/api/session"),
  ],
  [
    "login from another Gateway process",
    (f) =>
      (f.login.trace.processes.edge.tags.find(
        (x) => x.key === "service.instance.id",
      ).value = "other"),
  ],
  [
    "login outside original receipt",
    (f) => {
      f.expected.login.receipt.completedMono = 710;
    },
  ],
  [
    "login after original SSE",
    (f) => {
      f.login.root.startTime += 1000000;
    },
  ],
  [
    "uncommitted login",
    (f) =>
      setTag(f.login.transaction, "antnest.transaction.outcome", "rolled_back"),
  ],
  [
    "missing original token insert",
    (f) => {
      f.login.trace.spans = f.login.trace.spans.filter(
        (s) => s !== f.login.insert,
      );
    },
  ],
  ["unrelated login error", (f) => setTag(f.login.server, "error", true)],
  [
    "original login warning log",
    (f) =>
      f.login.root.logs.push({
        timestamp: f.login.root.startTime,
        fields: [{ key: "level", value: "WARN" }],
      }),
  ],
  [
    "original login RPC failure",
    (f) => setTag(f.login.server, "rpc.response.status_code", 13),
  ],
  [
    "original login numeric OTEL failure",
    (f) => setTag(f.login.server, "otel.status_code", 2),
  ],
  [
    "missing mutation body",
    (f) => {
      delete f.expected.cause.rawBody;
    },
  ],
  [
    "missing refusal body",
    (f) => {
      delete f.expected.denial.rawBody;
    },
  ],
  [
    "different mutation body",
    (f) => {
      f.expected.cause.rawBody = '{"status":"different"}';
    },
  ],
  [
    "different refusal body",
    (f) => {
      f.expected.denial.rawBody = '{"code":"different"}';
    },
  ],
  [
    "different refusal summary",
    (f) => {
      f.expected.denial.body.code = "different";
    },
  ],
  [
    "noncontractual original refusal",
    (f) => {
      f.expected.denial.body.message = "Other rejection";
      f.expected.denial.rawBody = JSON.stringify(f.expected.denial.body);
    },
  ],
  [
    "uncommitted User mutation",
    (f) => setTag(f.transaction, "antnest.transaction.outcome", "rolled_back"),
  ],
  [
    "missing revocation feed",
    (f) => {
      f.raw.trace.spans = f.raw.trace.spans.filter((s) => s !== f.sql.session);
    },
  ],
  [
    "invented owner payload",
    (f) => {
      f.expected.offboarding.owner_revocation.data = {
        identity_revocation_sequence: 17,
      };
    },
  ],
  [
    "foreign public owner event",
    (f) => {
      f.expected.offboarding.owner_revocation.event_id = "foreign";
    },
  ],
  [
    "foreign Disable operation",
    (f) => {
      f.expected.offboarding.disabled_event.operation_request_id = "foreign";
    },
  ],
  [
    "missing disabled event",
    (f) => {
      delete f.expected.offboarding.disabled_event;
    },
  ],
  [
    "unsettled Runtime",
    (f) => {
      for (const s of f.raw.trace.spans)
        for (const t of s.tags ?? [])
          if (t.key === "antnest.settlement.outcome")
            t.value = "runtime_barrier_required";
    },
  ],
  [
    "missing UI termination witness",
    (f) => {
      f.ui.logs = [];
    },
  ],
  [
    "foreign UI User",
    (f) => {
      f.ui.logs[0].fields.find((x) => x.key === "antnest.principal.id").value =
        "other";
    },
  ],
  [
    "foreign denial scope",
    (f) => {
      f.expected.denial.credentialScope = "other";
    },
  ],
  [
    "denial before remote EOF",
    (f) => {
      f.expected.denial.startedMono = f.expected.closure.at - 1;
    },
  ],
  [
    "missing denial archive",
    (f) => f.collection.archivedTraceIDs.delete(f.expected.denial.traceID),
  ],
  [
    "new Run after revocation",
    (f) => {
      f.expected.after.audits.page.items.push({ run_id: "new-run" });
    },
  ],
  [
    "new Provider work after revocation",
    (f) => {
      f.expected.after.model.requests.push({ id: "new-provider" });
    },
  ],
  [
    "missing execution inventory",
    (f) => {
      delete f.expected.after;
    },
  ],
])
  test(`C4 revocation rejects ${name}`, () => {
    assert.equal(typeof inspectC4RevocationTrace, "function");
    const f = fixture();
    change(f);
    assert.throws(() => inspect(f));
  });

for (const [name, change] of [
  [
    "mutation summary",
    (f, secret) => {
      f.expected.cause.body.secret = secret;
    },
  ],
  [
    "mutation response",
    (f, secret) => {
      f.expected.cause.body.secret = secret;
      f.expected.cause.rawBody = JSON.stringify(f.expected.cause.body);
    },
  ],
  [
    "malformed mutation response",
    (f, secret) => {
      f.expected.cause.rawBody = secret;
    },
  ],
  [
    "malformed refusal response",
    (f, secret) => {
      f.expected.denial.rawBody = secret;
    },
  ],
])
  test(`C4 rejects private ${name} without diagnostic reflection`, () => {
    const f = fixture(),
      secret = "C4-PRIVATE-RECEIPT-CANARY";
    change(f, secret);
    assert.throws(
      () => inspect(f),
      (error) => {
        assert(!format(error, { depth: 10 }).includes(secret));
        return true;
      },
    );
  });
