import assert from "node:assert/strict";
import test from "node:test";
import { inspectOffboardingTrace } from "./offboarding-evidence.mjs";
import { offboardingFixture } from "./offboarding-trace-fixture.mjs";

function fixture() {
  const f = offboardingFixture();
  f.expected.ownerRevocation = {
    ownerUserID: "original-user",
    organizationID: "",
    reason: "user_deactivated",
    event: {
      event_id: "event-original",
      event_type: "agent_owner_revoked",
      agent_id: f.expected.agentID,
      trace_id: f.expected.sourceID,
      data: {
        owner_user_id: "original-user",
        organization_id: "",
        reason: "user_deactivated",
        identity_revocation_sequence: 17,
      },
    },
  };
  return f;
}
function inspect(f) {
  return inspectOffboardingTrace([f.trace], f.expected, []);
}
test("global owner receipt preserves its exact Controller event and binds Disable sequence", () => {
  const f = fixture(),
    before = structuredClone(f);
  const result = inspect(f);
  assert.deepEqual(result.owner_revocation, f.expected.ownerRevocation.event);
  assert.deepEqual(f, before);
  result.owner_revocation.data.reason = "changed";
  assert.equal(
    f.expected.ownerRevocation.event.data.reason,
    "user_deactivated",
  );
});
for (const [name, mutate] of [
  ["wrong User", (e) => (e.data.owner_user_id = "other")],
  ["membership scope", (e) => (e.data.organization_id = "org")],
  ["wrong reason", (e) => (e.data.reason = "membership_deactivated")],
  ["wrong sequence", (e) => (e.data.identity_revocation_sequence = 18)],
  ["missing sequence", (e) => delete e.data.identity_revocation_sequence],
  ["wrong Agent", (e) => (e.agent_id = "other")],
  ["foreign source", (e) => (e.trace_id = "b".repeat(32))],
  ["wrong event", (e) => (e.event_type = "agent_disabled")],
  ["empty event ID", (e) => (e.event_id = "")],
])
  test(`owner Disable rejects ${name}`, () => {
    const f = fixture();
    mutate(f.expected.ownerRevocation.event);
    assert.throws(() => inspect(f));
  });
