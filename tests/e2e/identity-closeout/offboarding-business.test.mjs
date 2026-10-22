import assert from "node:assert/strict";
import test from "node:test";

const url = new URL("./offboarding-business.mjs", import.meta.url);
const { inspectOffboardingBusiness: inspect } = await import(url).catch(
  (error) => {
    if (
      error.code !== "ERR_MODULE_NOT_FOUND" ||
      !error.message.includes(url.pathname)
    )
      throw error;
    return {};
  },
);
const original = (reason) => {
  const before = [
    { event_id: "old", event_type: "agent_created", agent_id: "agent" },
  ];
  const cause = {
    event_id: "revoked",
    event_type: "agent_owner_revoked",
    agent_id: "agent",
    data: {
      owner_user_id: "owner",
      organization_id: reason === "user_deactivated" ? "" : "org",
      reason,
      identity_revocation_sequence: 17,
    },
  };
  return {
    agentID: "agent",
    organizationID: "org",
    ownerUserID: "owner",
    reason,
    agent: {
      agent_id: "agent",
      desired_state: "disabled",
      lifecycle_state: "created",
      activation_state: "disabled",
    },
    runtime: {
      agent_id: "agent",
      lifecycle_state: "disabled",
      health: "absent",
      runtime_execution_id: "",
      mcp_endpoint: "",
    },
    before,
    events: [
      ...structuredClone(before),
      {
        event_id: "revoked",
        event_type: "agent_owner_revoked",
        agent_id: "agent",
      },
      {
        event_id: "disabled",
        event_type: "agent_disabled",
        agent_id: "agent",
        operation_request_id: "disable",
      },
    ],
    privateEvents: { events: [cause] },
    operation: {
      kind: "disable",
      agent_id: "agent",
      request_id: "disable",
      state: "completed",
    },
  };
};

test("actual owner offboarding stays admitted without Trace only after its original Agent, Runtime, event and operation checks", () => {
  assert.equal(typeof inspect, "function");
  for (const reason of [
    "user_deactivated",
    "membership_deactivated",
    "membership_deleted",
  ]) {
    const evidence = original(reason),
      before = structuredClone(evidence);
    assert.deepEqual(inspect(evidence), {
      business: "passed",
      agent_id: "agent",
      request_id: "disable",
      owner_revocation_sequence: 17,
    });
    assert.deepEqual(evidence, before);
  }
});

test("Trace absence cannot waive physical, scope, terminal or durable history failures", () => {
  assert.equal(typeof inspect, "function");
  for (const mutate of [
    (e) => {
      e.agent.activation_state = "enabled";
    },
    (e) => {
      e.runtime.runtime_execution_id = "still-running";
    },
    (e) => {
      e.runtime.agent_id = "foreign";
    },
    (e) => {
      e.privateEvents.events[0].data.owner_user_id = "foreign";
    },
    (e) => {
      e.privateEvents.events[0].data.organization_id = "org";
    },
    (e) => {
      e.privateEvents.events[0].data.reason = "membership_deactivated";
    },
    (e) => {
      e.privateEvents.events[0].data.identity_revocation_sequence = 0;
    },
    (e) => {
      e.privateEvents.events[0].agent_id = "foreign";
    },
    (e) => {
      e.privateEvents.events = [];
    },
    (e) => {
      e.privateEvents.events.push(structuredClone(e.privateEvents.events[0]));
    },
    (e) => {
      e.events = e.events.filter((row) => row.event_type !== "agent_disabled");
    },
    (e) => {
      e.events.push(structuredClone(e.events.at(-1)));
    },
    (e) => {
      e.operation.request_id = "foreign";
    },
    (e) => {
      e.operation.agent_id = "foreign";
    },
    (e) => {
      e.operation.state = "running";
    },
    (e) => {
      e.events[0].event_type = "changed";
    },
  ]) {
    const evidence = original("user_deactivated");
    mutate(evidence);
    assert.throws(() => inspect(evidence));
  }
});
