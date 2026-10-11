import assert from "node:assert/strict";
import test from "node:test";
import { inspectLocalAdminLogin } from "./local-admin-login.mjs";
import { observabilityResolutionFixture } from "./resolve-evidence-fixtures.mjs";
import { fields } from "./trace-fixtures.mjs";

const check = (f) =>
  inspectLocalAdminLogin(f.trace, "session", {
    expected: f.expected,
    collection: f,
  });
for (const source of ["rpc", "cache", "shared", "shared-background"])
  test(`session observation counts actual ${source} provenance without pretending cached SQL ran`, () => {
    const f = observabilityResolutionFixture(source);
    const result = check(f);
    assert.equal(result.stage, "session");
    assert.equal(result.spans, source === "rpc" ? 5 : 2);
    assert.equal(result.database_spans, source === "cache" ? 0 : 1);
    assert.equal(result.current_database_spans, source === "rpc" ? 1 : 0);
    assert.equal(result.diagnostic_events, source === "rpc" ? 2 : 0);
    assert.equal(
      result.resolution_diagnostic_events,
      source === "cache" ? 0 : 2,
    );
    assert.equal(result.transactions, 0);
    assert.equal(result.errors, 0);
    assert.equal(result.gateway_resolution.profile, "session");
    assert.equal(
      result.gateway_resolution.source,
      source.startsWith("shared") ? "shared" : source,
    );
    assert(
      result.chain.some(
        (span) => span.operation === "gateway.identity.resolve",
      ),
    );
  });

test("session observation supports an explicitly disabled capture deployment", () => {
  const f = observabilityResolutionFixture("rpc");
  f.captureRpcContent = false;
  f.trace.spans.find((span) => span.spanID === "resolve-server").logs = [];
  const result = check(f);
  assert.equal(result.database_spans, 1);
  assert.equal(result.diagnostic_events, 0);
  assert.equal(result.resolution_diagnostic_events, 0);
});

test("session cannot silently use a default source collection or TTL", () => {
  const f = observabilityResolutionFixture("rpc");
  for (const options of [
    undefined,
    { expected: f.expected },
    { collection: f },
  ])
    assert.throws(() => inspectLocalAdminLogin(f.trace, "session", options), {
      name: "Error",
      message: "local admin trace validation failed",
    });
});

for (const source of ["rpc", "shared", "shared-background"])
  test(`session ${source} rejects last_used_at UPDATE at its exact receiving SERVER`, () => {
    const f = observabilityResolutionFixture(source);
    const actual = [...f.traces.values()].find((trace) =>
      trace.spans.some((span) => span.spanID === "sql"),
    );
    const sql = structuredClone(
      actual.spans.find((span) => span.spanID === "sql"),
    );
    sql.spanID = "unexpected-update";
    sql.operationName = "UPDATE";
    sql.tags = fields({
      "span.kind": "client",
      "db.system.name": "postgresql",
      "db.operation.name": "UPDATE",
      "db.query.text": "UPDATE sessions SET last_used_at = $1",
    });
    actual.spans.push(sql);
    assert.throws(() => check(f), {
      name: "Error",
      message: "local admin trace validation failed",
    });
  });
