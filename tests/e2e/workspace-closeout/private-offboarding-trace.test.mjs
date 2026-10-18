import assert from "node:assert/strict";
import test from "node:test";
import { workspaceOffboardingFixture } from "./private-offboarding-trace.fixture.mjs";
const implementation = await import("./private-offboarding-trace.mjs").catch(
  (error) => {
    if (
      error.code !== "ERR_MODULE_NOT_FOUND" ||
      !error.message.includes(
        "/workspace-closeout/private-offboarding-trace.mjs",
      )
    )
      throw error;
    return {};
  },
);
function inspect(f) {
  assert.equal(
    typeof implementation.inspectWorkspaceOffboardingTrace,
    "function",
  );
  return implementation.inspectWorkspaceOffboardingTrace(
    [f.trace],
    f.expected,
    [],
  );
}
test("Workspace automatic Disable settles the rebuilt Runtime and preserves original owner events", () => {
  const f = workspaceOffboardingFixture(),
    before = structuredClone(f);
  const result = inspect(f);
  assert.equal(result.kind, "disable");
  assert.equal(result.source_trace_id, f.expected.sourceID);
  assert.equal(result.settlement_outcome, "settled");
  assert.deepEqual(result.owner_revocation, f.expected.ownerRevocation.event);
  assert.deepEqual(result.disabled_event, f.expected.disabledEvent);
  assert.equal(result.revocation_sequence, 17);
  assert.equal(result.owner_revocation.data, undefined);
  assert.deepEqual(f, before);
});
for (const outcome of ["runtime_barrier_required", "not_settled"])
  test(`Workspace automatic Disable cannot substitute ${outcome}`, () => {
    const f = workspaceOffboardingFixture();
    for (const span of f.trace.spans)
      for (const field of span.tags ?? [])
        if (field.key === "antnest.settlement.outcome") field.value = outcome;
    assert.throws(() => inspect(f));
    f.expected.settlementOutcome = outcome;
    assert.throws(() => inspect(f));
  });
for (const [name, mutate] of [
  ["missing owner event", (f) => delete f.expected.ownerRevocation],
  [
    "wrong owner sequence",
    (f) =>
      f.trace.spans
        .find((span) => span.spanID === "schedule")
        .tags.find((field) => field.key === "identity.revocation.sequence")
        .value++,
  ],
  [
    "foreign owner event Agent",
    (f) => (f.expected.ownerRevocation.event.agent_id = "foreign"),
  ],
  [
    "foreign owner event ID",
    (f) => (f.expected.ownerRevocation.event.event_id = "event_foreign"),
  ],
  [
    "fabricated private payload",
    (f) =>
      (f.expected.ownerRevocation.event.data = {
        identity_revocation_sequence: 17,
      }),
  ],
  [
    "wrong receipt sequence",
    (f) =>
      f.trace.spans
        .find((span) => span.spanID === "receipt")
        .tags.find((field) => field.key === "identity.revocation.sequence")
        .value++,
  ],
  [
    "membership revocation substituted",
    (f) =>
      (f.trace.spans
        .find((span) => span.spanID === "controller")
        .tags.find((field) => field.key === "http.route").value =
        "/rpc/identity/set-membership-active"),
  ],
  [
    "foreign Identity parent",
    (f) =>
      (f.trace.spans.find(
        (span) => span.spanID === "schedule",
      ).references[0].spanID = "console"),
  ],
  [
    "Disable before owner event",
    (f) => (f.expected.disabledEvent.aggregate_sequence = 15),
  ],
  ["missing disabled event", (f) => delete f.expected.disabledEvent],
  [
    "foreign disable request",
    (f) => (f.expected.disabledEvent.operation_request_id = "foreign"),
  ],
  [
    "foreign disable source",
    (f) => (f.expected.disabledEvent.trace_id = "f".repeat(32)),
  ],
  ["foreign Agent", (f) => (f.expected.disabledEvent.agent_id = "foreign")],
  [
    "duplicate event",
    (f) =>
      (f.expected.disabledEvent.event_id =
        f.expected.ownerRevocation.event.event_id),
  ],
  ["missing source", (f) => (f.expected.sourceID = "f".repeat(32))],
])
  test(`Workspace automatic Disable rejects ${name}`, () => {
    const f = workspaceOffboardingFixture();
    mutate(f);
    assert.throws(() => inspect(f));
  });
