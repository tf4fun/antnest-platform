import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCancellationEvidence,
  assertDeleteCleanupEvidence,
  assertFailedCreateEvidence,
  assertGCEvidence,
  assertGCProtectedAgent,
  cancelDeleteRequestID,
  deriveReliabilityID,
  gcDeleteRequestID,
  gcScheduledEventID,
} from "./reliability-evidence.mjs";

const AGENT = "agent-proof";
const CREATE = "request-create";

test("deriveReliabilityID matches the frozen golden identities", () => {
  assert.equal(
    cancelDeleteRequestID(CREATE),
    "request_8f7f9bbef8b8a414e6daf4f8936b9165",
  );
  assert.equal(
    gcDeleteRequestID(CREATE),
    "request_bbc0872ea63f58e0812f74c201811491",
  );
  assert.equal(
    gcScheduledEventID(CREATE),
    "event_ff68ce20c17c7dd6415119e567e7d185",
  );
  assert.match(deriveReliabilityID("x", "ns", "key"), /^x_[0-9a-f]{32}$/);
});

const op = (overrides = {}) => ({
  request_id: CREATE,
  agent_id: AGENT,
  kind: "create",
  state: "failed",
  phase: "network_ensure",
  error_code: "phase_deadline_exceeded",
  ...overrides,
});

const agentView = (overrides = {}) => ({
  agent_id: AGENT,
  readiness: "preparing",
  lifecycle_state: "not_created",
  desired_state: "enabled",
  failure_stage: "network_ensure",
  failure_code: "phase_deadline_exceeded",
  active_operation_request_id: "",
  executable_execution_revision: "",
  ...overrides,
});

let seq = 0;
const event = (type, requestID, data = {}) => ({
  event_id: `event-${type}-${++seq}`,
  global_sequence: seq,
  aggregate_sequence: seq,
  agent_id: AGENT,
  event_type: type,
  operation_request_id: requestID,
  data,
});

const createEvents = (extra = []) => {
  seq = 0;
  return [
    event("agent_create_requested", CREATE),
    event("agent_build_failed", CREATE, {
      failure_code: "phase_deadline_exceeded",
      failure_stage: "network_ensure",
    }),
    ...extra,
  ];
};

test("assertFailedCreateEvidence accepts a durable bounded failure", () => {
  assertFailedCreateEvidence(
    { operation: op(), agent: agentView(), events: createEvents() },
    {
      agentID: AGENT,
      requestID: CREATE,
      phase: "network_ensure",
      errorCode: "phase_deadline_exceeded",
    },
  );
});

test("assertFailedCreateEvidence rejects wrong identities and ready history", () => {
  const expected = {
    agentID: AGENT,
    requestID: CREATE,
    phase: "network_ensure",
    errorCode: "phase_deadline_exceeded",
  };
  const cases = [
    {
      operation: op({ agent_id: "agent-other" }),
      agent: agentView(),
      events: createEvents(),
    },
    {
      operation: op({ request_id: "request-other" }),
      agent: agentView(),
      events: createEvents(),
    },
    {
      operation: op({ phase: "runtime_initialize" }),
      agent: agentView(),
      events: createEvents(),
    },
    {
      operation: op({ error_code: "dependency_unavailable" }),
      agent: agentView(),
      events: createEvents(),
    },
    {
      operation: op({ state: "running" }),
      agent: agentView(),
      events: createEvents(),
    },
    {
      operation: op(),
      agent: agentView({ failure_code: "other" }),
      events: createEvents(),
    },
    { operation: op(), agent: agentView(), events: [createEvents()[0]] },
    {
      operation: op(),
      agent: agentView({ active_operation_request_id: "request-active" }),
      events: createEvents(),
    },
    {
      operation: op(),
      agent: agentView({ executable_execution_revision: "exec-1" }),
      events: createEvents(),
    },
  ];
  for (const input of cases) {
    assert.throws(() => assertFailedCreateEvidence(input, expected));
  }
  const readyEvents = createEvents();
  readyEvents.push(event("agent_ready", CREATE));
  assert.throws(() =>
    assertFailedCreateEvidence(
      { operation: op(), agent: agentView(), events: readyEvents },
      expected,
    ),
  );
});

test("assertCancellationEvidence requires cancelled audit, derived child and held disconnect", () => {
  const child = cancelDeleteRequestID(CREATE);
  const runtimeID = "request-runtime-child";
  seq = 0;
  const events = [
    event("agent_create_requested", CREATE),
    event("agent_lifecycle_cancelled", CREATE, {
      failure_code: "lifecycle_cancelled",
    }),
    event("agent_delete_requested", child),
    event("agent_deleted", child),
  ];
  const proxy = {
    agent_id: AGENT,
    request_id: runtimeID,
    records: [
      {
        agent_id: AGENT,
        request_id: runtimeID,
        status: 200,
        target_revision: "rtv-1",
        delivery: "caller_disconnected",
      },
    ],
  };
  assertCancellationEvidence(
    {
      operation: op({
        error_code: "lifecycle_cancelled",
        phase: "runtime_initialize",
      }),
      events,
      proxy,
    },
    {
      agentID: AGENT,
      requestID: CREATE,
      childRequestID: child,
      runtimeRequestID: runtimeID,
    },
  );
  assert.throws(() =>
    assertCancellationEvidence(
      {
        operation: op({ error_code: "phase_deadline_exceeded" }),
        events,
        proxy,
      },
      {
        agentID: AGENT,
        requestID: CREATE,
        childRequestID: child,
        runtimeRequestID: runtimeID,
      },
    ),
  );
  assert.throws(() =>
    assertCancellationEvidence(
      {
        operation: op({
          error_code: "lifecycle_cancelled",
          phase: "runtime_initialize",
        }),
        events,
        proxy: {
          ...proxy,
          records: [{ ...proxy.records[0], delivery: "delivered" }],
        },
      },
      {
        agentID: AGENT,
        requestID: CREATE,
        childRequestID: child,
        runtimeRequestID: runtimeID,
      },
    ),
  );
});

test("assertDeleteCleanupEvidence requires a completed delete plus physical and egress proof", () => {
  const deleteID = cancelDeleteRequestID(CREATE);
  seq = 0;
  const events = [
    event("agent_create_requested", CREATE),
    event("agent_delete_requested", deleteID),
    event("agent_deleted", deleteID),
  ];
  const proof = {
    operation: op({ kind: "delete", state: "completed", request_id: deleteID }),
    events,
    physical: { containers: [], volumes: [] },
    egress: {
      allocation_state: "quarantined",
      attachment_state: "closed",
      keys_absent: true,
      attachment_safe: true,
    },
  };
  assertDeleteCleanupEvidence(proof, { agentID: AGENT, requestID: deleteID });
  for (const bad of [
    { ...proof, physical: { containers: [{ Id: "c1" }], volumes: [] } },
    { ...proof, physical: { containers: [], volumes: ["v1"] } },
    { ...proof, egress: { ...proof.egress, allocation_state: "active" } },
    { ...proof, egress: { ...proof.egress, attachment_state: "open" } },
    { ...proof, egress: { ...proof.egress, keys_absent: false } },
    { ...proof, egress: { ...proof.egress, attachment_safe: false } },
    {
      ...proof,
      operation: op({ kind: "delete", state: "running", request_id: deleteID }),
    },
    {
      ...proof,
      operation: op({
        kind: "create",
        state: "completed",
        request_id: deleteID,
      }),
    },
  ]) {
    assert.throws(() =>
      assertDeleteCleanupEvidence(bad, { agentID: AGENT, requestID: deleteID }),
    );
  }
});

function controlSnapshot(overrides = {}) {
  seq = 0;
  const events = [event("agent_create_requested", "request-control")];
  return {
    agent: agentView({
      lifecycle_state: "created",
      readiness: "ready",
      executable_execution_revision: "exec-control-1",
      failure_code: "",
      failure_stage: "",
    }),
    physical: {
      containers: [{ Id: "container-control-1" }],
      volumes: ["volume-ws", "volume-skills", "volume-recv"],
    },
    events,
    ...overrides,
  };
}

test("assertGCProtectedAgent preserves the ready control identities", () => {
  const before = controlSnapshot();
  const after = controlSnapshot();
  assertGCProtectedAgent(before, after);
  for (const bad of [
    {
      ...after,
      physical: {
        containers: [{ Id: "container-new" }],
        volumes: after.physical.volumes,
      },
    },
    { ...after, physical: { containers: [], volumes: after.physical.volumes } },
    {
      ...after,
      physical: {
        containers: after.physical.containers,
        volumes: ["v1", "v1", "v1"],
      },
    },
    {
      ...after,
      agent: { ...after.agent, executable_execution_revision: "exec-other" },
    },
    { ...after, agent: { ...after.agent, readiness: "unavailable" } },
    {
      ...after,
      agent: { ...after.agent, active_operation_request_id: "request-gc" },
    },
    {
      ...after,
      events: [...after.events, event("agent_gc_scheduled", "request-gc")],
    },
  ]) {
    assert.throws(() => assertGCProtectedAgent(before, bad));
  }
});

test("assertGCEvidence requires the source failure, derived GC IDs and full audit", () => {
  const deleteID = gcDeleteRequestID(CREATE);
  const eventID = gcScheduledEventID(CREATE);
  seq = 0;
  const events = [
    event("agent_create_requested", CREATE),
    event("agent_build_failed", CREATE, {
      failure_code: "phase_deadline_exceeded",
      failure_stage: "runtime_initialize",
    }),
    {
      ...event("agent_gc_scheduled", deleteID, {
        create_request_id: CREATE,
        delete_request_id: deleteID,
      }),
      event_id: eventID,
    },
    event("agent_delete_requested", deleteID),
    event("agent_deleted", deleteID),
  ];
  assertGCEvidence(
    { operation: op({ phase: "runtime_initialize" }), events },
    { agentID: AGENT, createRequestID: CREATE },
  );
  assert.throws(() =>
    assertGCEvidence(
      { operation: op({ phase: "network_ensure" }), events },
      { agentID: AGENT, createRequestID: CREATE },
    ),
  );
  assert.throws(() =>
    assertGCEvidence(
      {
        operation: op({ phase: "runtime_initialize" }),
        events: events.slice(0, 2),
      },
      { agentID: AGENT, createRequestID: CREATE },
    ),
  );
});
