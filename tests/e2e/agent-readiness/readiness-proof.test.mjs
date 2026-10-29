import assert from "node:assert/strict";
import test from "node:test";
import { readinessProof, publicationProof } from "./readiness-proof.mjs";

function fixture() {
  const context = {
    agentId: "agent",
    operationId: "create",
    organizationId: "org",
  };
  const data = {
    organization_id: "org",
    agent_spec_revision_id: "spec",
    execution_revision_id: "execution",
    runtime_revision: "runtime",
    ready_after_revision: 8,
  };
  const event = (type, sequence) => ({
    event_id: type,
    agent_id: "agent",
    operation_request_id: "create",
    schema_version: 2,
    global_sequence: sequence,
    aggregate_sequence: sequence,
    event_type: type,
    data: structuredClone(data),
  });
  const bound = event("runtime_bound", 2),
    ready = event("agent_ready", 3);
  ready.data.applied_revision = 9;
  const publication = {
    id: "attempt",
    path: "/rpc/agent-acp/apply-execution-snapshot",
    organizationId: "org",
    revision: 9,
    appliedRevision: 9,
    status: 200,
    requestSha256: "a".repeat(64),
    receivedAt: 0,
    delayStartedAt: 1,
    forwardedAt: 2001,
    upstreamCompletedAt: 2002,
    completedAt: 2003,
    cancelled: false,
    bindings: [
      {
        agent_id: "agent",
        agent_spec_revision: "spec",
        execution_revision: "execution",
        runtime_revision: "runtime",
        accepting_runs: true,
      },
    ],
  };
  return { context, events: [bound, ready], publication };
}

test("ready proof ties one v2 event to the original operation and applied binding", () => {
  const { context, events, publication } = fixture();
  const proof = readinessProof(events, context);
  assert.equal(proof.ready, events[1]);
  publicationProof(publication, proof, context);
});

test("an organization ACK uses the bound tuple without inventing a lifecycle operation", () => {
  const { context, events, publication } = fixture();
  delete events[1].operation_request_id;
  const proof = readinessProof(events, context);
  publicationProof(publication, proof, context);
});

for (const [name, change] of [
  ["missing ready", (x) => x.events.pop()],
  ["duplicate ready", (x) => x.events.push(structuredClone(x.events[1]))],
  ["legacy ready", (x) => (x.events[1].schema_version = 1)],
  ["foreign Agent", (x) => (x.events[1].agent_id = "other")],
  ["foreign operation", (x) => (x.events[1].operation_request_id = "other")],
  ["foreign organization", (x) => (x.events[1].data.organization_id = "other")],
  [
    "different execution",
    (x) => (x.events[1].data.execution_revision_id = "other"),
  ],
  ["different runtime", (x) => (x.events[1].data.runtime_revision = "other")],
  ["changed threshold", (x) => (x.events[1].data.ready_after_revision = 9)],
  ["stale ACK", (x) => (x.events[1].data.applied_revision = 7)],
  [
    "unsafe ACK",
    (x) => (x.events[1].data.applied_revision = Number.MAX_SAFE_INTEGER + 1),
  ],
  [
    "private proof leaked",
    (x) => (x.events[1].data.runtime_execution_id = "private"),
  ],
  [
    "invalid matching identity",
    (x) => {
      x.events[0].data.runtime_revision = "bad/id";
      x.events[1].data.runtime_revision = "bad/id";
    },
  ],
  ["ready before binding", (x) => (x.events[1].aggregate_sequence = 1)],
])
  test("ready proof rejects " + name, () => {
    const value = fixture();
    change(value);
    assert.throws(() => readinessProof(value.events, value.context));
  });

for (const [name, change] of [
  ["delay after forwarding", (x) => (x.forwardedAt = 1)],
  ["short actual delay", (x) => (x.forwardedAt = 2000.5)],
  ["wrong organization", (x) => (x.organizationId = "other")],
  ["older snapshot", (x) => (x.revision = 7)],
  ["different ACK", (x) => (x.appliedRevision = 10)],
  ["failed upstream", (x) => (x.status = 500)],
  ["cancelled attempt", (x) => (x.cancelled = true)],
  ["unjoined attempt", (x) => (x.completedAt = null)],
  ["different binding", (x) => (x.bindings[0].execution_revision = "other")],
  ["not accepting Runs", (x) => (x.bindings[0].accepting_runs = false)],
])
  test("publication proof rejects " + name, () => {
    const value = fixture();
    change(value.publication);
    assert.throws(() =>
      publicationProof(
        value.publication,
        readinessProof(value.events, value.context),
        value.context,
      ),
    );
  });

test("a v2 delta publication satisfies the proof with its exact base", () => {
  const { context, events, publication } = fixture();
  publication.path = "/rpc/agent-acp/apply-execution-delta";
  publication.schemaVersion = 2;
  publication.baseRevision = 8;
  publication.revision = 9;
  publicationProof(publication, readinessProof(events, context), context);
});

for (const [name, change] of [
  ["foreign path", (x) => (x.publication.path = "/rpc/agent-acp/other")],
  ["legacy delta schema", (x) => (x.publication.schemaVersion = 1)],
  ["missing delta base", (x) => (x.publication.baseRevision = null)],
  ["base not below revision", (x) => (x.publication.baseRevision = 9)],
])
  test("delta publication proof rejects " + name, () => {
    const value = fixture();
    value.publication.path = "/rpc/agent-acp/apply-execution-delta";
    value.publication.schemaVersion = 2;
    value.publication.baseRevision = 8;
    change(value);
    assert.throws(() =>
      publicationProof(
        value.publication,
        readinessProof(value.events, value.context),
        value.context,
      ),
    );
  });
