import assert from "node:assert/strict";
import test from "node:test";

const url = new URL("./resolve-cache-outage-business.mjs", import.meta.url);
const {
  createOutageBusinessReceipt: create,
  assertOutageBusinessReceipt: admit,
} = await import(url).catch((error) => {
  if (error.code !== "ERR_MODULE_NOT_FOUND" || error.url !== url.href)
    throw error;
  return {};
});
const fixtureURL = new URL(
  "../e2e/edge-gateway/resolve-cache-business-fixtures.mjs",
  import.meta.url,
);
const { outageBusinessFixture: fixture } = await import(fixtureURL).catch(
  (error) => {
    if (error.code !== "ERR_MODULE_NOT_FOUND" || error.url !== fixtureURL.href)
      throw error;
    return {};
  },
);
function api() {
  assert.equal(typeof create, "function", "business receipt factory required");
  assert.equal(typeof admit, "function", "raw business admission required");
  assert.equal(
    typeof fixture,
    "function",
    "combined hand-authored fixture required",
  );
}

test("complete outage business receipt admits raw same-run evidence without Trace and preserves its source", () => {
  api();
  const e = fixture(),
    original = structuredClone(e);
  const receipt = create(e);
  assert.equal(receipt.schema, "resolve-cache-outage-business/v1");
  assert.equal(receipt.status, "passed");
  assert.equal(admit(receipt), receipt);
  assert.equal(receipt.checks.rejections.requests.length, 6);
  assert.equal(receipt.checks.recovery.cases.length, 4);
  assert.equal(receipt.checks.resources.public_streams, 5);
  assert.deepEqual(e, original);
  assert.notEqual(receipt.evidence, e);
  assert.equal(Object.hasOwn(receipt.evidence, "trace_evidence"), false);
});

test("outage receipt never promotes a forged summary without its original observations", () => {
  api();
  const receipt = create(fixture());
  delete receipt.evidence;
  assert.throws(() => admit(receipt));
});

for (const [name, mutate] of [
  [
    "missing outage HTTP",
    (e) => (e.http = e.http.filter((r) => r.label !== "outage-prompt")),
  ],
  [
    "surviving original Runtime child",
    (e) => (e.runtime.quiescent.work.processes += "\n43 (sleep) S 1 30 0 0"),
  ],
  [
    "stored original Run still running",
    (e) => (e.run_storage.after.record.state = "running"),
  ],
  ["missing consumer restart", (e) => e.consumer_restarts.pop()],
  [
    "missing HTTP refusal",
    (e) => (e.http = e.http.filter((r) => r.label !== "stopped-new-login")),
  ],
  ["missing recovery case", (e) => e.recovery.cases.pop()],
  [
    "foreign replacement Runtime",
    (e) => (e.recovery_preparation.runtime.organization_id = "foreign"),
  ],
  ["unjoined observer", (e) => delete e.stream.joined],
  ["UI shutdown failure", (e) => (e.ui_drain.after.exit_code = 1)],
  ["cleanup error", (e) => (e.finalization_errors = ["failed"])],
])
  test(`outage receipt revalidates ${name} even with preserved passed summaries`, () => {
    api();
    const receipt = create(fixture());
    mutate(receipt.evidence);
    assert.throws(() => admit(receipt));
  });

test("outage receipt summary is exactly derived from raw observations", () => {
  api();
  const receipt = create(fixture());
  receipt.checks.recovery.cases.pop();
  assert.throws(() => admit(receipt));
});
