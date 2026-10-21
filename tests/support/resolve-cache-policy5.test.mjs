import assert from "node:assert/strict";
import test from "node:test";
import * as admission from "./resolve-cache-admission.mjs";
import { verdict } from "./ci-shard.mjs";
import { createLoadBusinessReceipt } from "./resolve-cache-business.mjs";
import { createOutageBusinessReceipt } from "./resolve-cache-outage-business.mjs";
import { loadAdmissionFixture } from "../e2e/edge-gateway/resolve-cache-load-admission-fixtures.mjs";
import { outageBusinessFixture } from "../e2e/edge-gateway/resolve-cache-business-fixtures.mjs";

let template;
function fixture() {
  assert.equal(typeof admission.createResolveCacheBusinessReport, "function");
  if (!template) {
    const e = outageBusinessFixture();
    const { f, report } = loadAdmissionFixture();
    const wire = structuredClone(f.wire),
      owner = structuredClone(report.owner_lifecycle);
    wire.agent_id = e.agent_id;
    for (const row of wire.requests) {
      row.path = `/api/app/workspace/v1/agents/${e.agent_id}/sessions`;
      delete row.trace_id;
    }
    owner.agent_id = e.agent_id;
    delete owner.acp_clock;
    const principal = e.session_deadlines.owner.principal;
    const load = createLoadBusinessReceipt({
      wire,
      ownerLifecycle: owner,
      ownerScope: {
        agent_id: e.agent_id,
        user_id: principal.user_id,
        organization_id: principal.organization_id,
      },
    });
    const outage = createOutageBusinessReceipt(e);
    for (const receipt of [load, outage]) {
      receipt.observability = {
        strict_trace: "failed",
        raw: "original diagnostic",
      };
      receipt.trace_diagnostics = {
        version: 1,
        role: "auxiliary",
        status: "warning",
        checks: [{ name: "collection", status: "failed" }],
      };
    }
    template = { load, outage };
  }
  const { load, outage } = structuredClone(template);
  return admission.createResolveCacheBusinessReport(load, outage);
}

test("policy 5 admits both original business receipts only after actual outer cleanup", () => {
  const report = fixture();
  assert.equal(report.policy_revision, 5);
  assert.equal(admission.isResolveCacheCompletion(report), false);
  const complete = admission.finalizeResolveCacheReport(report, {
    signal: new AbortController().signal,
    failed: false,
    cleanupFailed: false,
  });
  assert.equal(admission.isResolveCacheCompletion(complete), true);
  assert.equal(complete.strict_trace, "failed");
  assert.equal(
    verdict(0, JSON.stringify(complete), true, admission.resolveCacheCISuite),
    "warning",
  );
  for (const code of [1, 2, 130, 143])
    assert.equal(
      verdict(
        code,
        JSON.stringify(complete),
        true,
        admission.resolveCacheCISuite,
      ),
      "failed",
    );
});

test("policy 5 never requires a successful diagnostic marker or substitutes one for business", () => {
  const complete = { ...fixture(), cleanup: "verified" };
  delete complete.observability;
  delete complete.strict_trace;
  assert.equal(admission.isResolveCacheCompletion(complete), true);
  assert.equal(
    admission.hasResolveCacheCompletion(JSON.stringify(complete), "passed"),
    true,
  );
  delete complete.business;
  assert.equal(admission.isResolveCacheCompletion(complete), false);
});

for (const [name, mutate] of [
  ["load incomplete", (r) => r.business.load.measurement.requests.pop()],
  ["load capacity missed", (r) => (r.business.load.elapsed_ms = 8001)],
  ["outage unexecuted", (r) => delete r.business.outage.evidence.recovery],
  [
    "outage Runtime survived",
    (r) =>
      (r.business.outage.evidence.runtime.quiescent.work.processes +=
        "\n43 (sleep) S 1 30 0 0"),
  ],
  [
    "consumer restoration failed",
    (r) => (r.business.load.owner_lifecycle.restored = false),
  ],
  [
    "foreign Agent between scenarios",
    (r) => {
      const load = r.business.load;
      load.owner_scope.agent_id =
        load.measurement.agent_id =
        load.owner_lifecycle.agent_id =
          "other-agent";
      for (const row of load.measurement.requests)
        row.path = "/api/app/workspace/v1/agents/other-agent/sessions";
    },
  ],
  [
    "foreign owner between scenarios",
    (r) => (r.business.load.owner_scope.user_id = "other-owner"),
  ],
  ["outer cleanup pending", (r) => (r.cleanup = "pending")],
  ["pending scenario", (r) => r.pending.push("recovery")],
  ["missing verified scenario", (r) => r.verified.pop()],
])
  test(`policy 5 rejects ${name} regardless of Trace status`, () => {
    const complete = { ...fixture(), cleanup: "verified" };
    assert.equal(admission.isResolveCacheCompletion(complete), true);
    mutate(complete);
    assert.equal(admission.isResolveCacheCompletion(complete), false);
    assert.equal(
      verdict(0, JSON.stringify(complete), true, admission.resolveCacheCISuite),
      "failed",
    );
  });

test("policy 5 later cleanup failure invalidates an earlier completed line", () => {
  const output =
    JSON.stringify({ ...fixture(), cleanup: "verified" }) +
    "\n" +
    JSON.stringify({ status: "cleanup_failed" });
  assert.equal(
    verdict(0, output, true, admission.resolveCacheCISuite),
    "failed",
  );
});
