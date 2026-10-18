import { offboardingFixture } from "../identity-closeout/offboarding-trace-fixture.mjs";

// Controlled fixture composition only; archived raw evidence is never rewritten.
export function workspaceOffboardingFixture() {
  const f = offboardingFixture();
  const identity = f.trace.spans.find((span) => span.spanID === "controller");
  identity.operationName = "POST /rpc/identity/set-user-active";
  identity.tags.find((field) => field.key === "http.route").value =
    "/rpc/identity/set-user-active";
  identity.tags = identity.tags.filter(
    (field) => !["rpc.method", "antnest.outcome"].includes(field.key),
  );
  identity.tags.push(
    { key: "rpc.method", value: "set_user_active" },
    { key: "antnest.outcome", value: "success" },
  );
  Object.assign(f.expected, {
    traceID: f.expected.sourceID,
    settlementOutcome: "settled",
    ownerRevocation: {
      ownerUserID: "original-user",
      organizationID: "",
      reason: "user_deactivated",
      event: {
        event_id: "event_60683adad9e7bbc824d5a70c13e1946e",
        event_type: "agent_owner_revoked",
        agent_id: f.expected.agentID,
        trace_id: f.expected.sourceID,
        global_sequence: 20,
        aggregate_sequence: 16,
        schema_version: 1,
        occurred_at: "2026-10-19T00:00:00Z",
      },
    },
    disabledEvent: {
      event_id: "event-disabled",
      event_type: "agent_disabled",
      agent_id: f.expected.agentID,
      trace_id: f.expected.sourceID,
      operation_request_id: f.expected.requestID,
      global_sequence: 22,
      aggregate_sequence: 18,
      schema_version: 1,
      occurred_at: "2026-10-19T00:00:01Z",
    },
  });
  return f;
}
