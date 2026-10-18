import assert from "node:assert/strict";
import test from "node:test";
import { bridgeSessionCauseFixture } from "../identity-closeout/bridge-session-cause-fixtures.mjs";
const url = new URL("./logout-trace.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
function inspect(f) {
  assert.equal(typeof implementation.inspectStage3Logout, "function");
  return implementation.inspectStage3Logout(
    f.trace,
    f.expected,
    ["PRIVATE-SESSION-CAUSE-CANARY"],
    f.collection,
  );
}
function logoutFeedFixture() {
  const f = bridgeSessionCauseFixture();
  f.expected.principal.membership_id = "membership";
  f.feed = {
    timestamp: f.upstream.logs[0].timestamp - 1000,
    fields: Object.entries({
      event: "antnest.stream.termination",
      source: "identity-session-feed",
      reason: "session_revoked",
      "antnest.revocation.reason": "session_revoked",
      "antnest.revocation.sequence": 12,
      "antnest.revocation.trace_id": f.mutation.trace.traceID,
      "antnest.revocation.span_id": f.mutation.server.spanID,
      "antnest.organization.id": f.expected.principal.organization_id,
      "antnest.principal.id": f.expected.principal.user_id,
      "antnest.membership.id": "membership",
      "antnest.agent.id": f.expected.agentId,
    }).map(([key, value]) => ({ key, value })),
  };
  f.root.logs.push(f.feed);
  f.upstream.logs[0].fields.find(
    (v) => v.key === "antnest.error.cause_types",
  ).value = '["*browserstream.feedTerminationCause","*errors.errorString"]';
  return f;
}
test("Stage3 Logout binds the winning feed to its original committed mutation", () => {
  const f = logoutFeedFixture(),
    before = structuredClone([...f.collection.traces]);
  const result = inspect(f);
  assert.equal(result.authorizationCauseVerified, true);
  assert.equal(result.cause_proof.feed_sequence, 12);
  assert.equal(
    result.cause_proof.feed_source_span_id,
    f.mutation.server.spanID,
  );
  assert.deepEqual([...f.collection.traces], before);
});
for (const [name, mutate] of [
  [
    "wrong source",
    (f) => {
      f.feed.fields.find((v) => v.key === "antnest.revocation.span_id").value =
        f.mutation.root.spanID;
    },
  ],
  [
    "different reason",
    (f) => {
      f.feed.fields.find((v) => v.key === "antnest.revocation.reason").value =
        "membership_deactivated";
    },
  ],
  [
    "foreign membership",
    (f) => {
      f.feed.fields.find((v) => v.key === "antnest.membership.id").value =
        "foreign";
    },
  ],
  [
    "before mutation",
    (f) => {
      f.feed.timestamp = f.mutation.root.startTime - 1;
    },
  ],
  [
    "after original failure",
    (f) => {
      f.feed.timestamp = f.upstream.logs[0].timestamp + 1;
    },
  ],
  [
    "unproved typed cause",
    (f) => {
      f.root.logs.pop();
    },
  ],
])
  test("Stage3 Logout rejects " + name, () => {
    const f = logoutFeedFixture();
    inspect(f);
    mutate(f);
    assert.throws(() => inspect(f));
  });

for (const [name, mutate] of [
  [
    "foreign Principal",
    (f) => {
      f.expected.principal.user_id = "foreign";
    },
  ],
  [
    "local close",
    (f) => {
      f.expected.localClose = true;
    },
  ],
  [
    "POST before closure",
    (f) => {
      f.expected.denial.startedMono = f.expected.checkpoint.at;
    },
  ],
  [
    "DELETE after closure",
    (f) => {
      f.expected.cause.startedMono = f.expected.closure.at + 1;
    },
  ],
  [
    "lost cause archive",
    (f) => {
      f.collection.archivedTraceIDs.delete(f.expected.cause.traceID);
    },
  ],
  [
    "missing feed witness",
    (f) => {
      f.root.logs.pop();
    },
  ],
  [
    "false HTTP status",
    (f) => {
      f.expected.denial.status = 200;
    },
  ],
])
  test("Stage3 Logout rejects " + name, () => {
    const f = logoutFeedFixture();
    inspect(f);
    mutate(f);
    assert.throws(() => inspect(f));
  });
test("browser proof retains raw diagnostics and makes no private owner closure claim", () => {
  const f = logoutFeedFixture(),
    before = structuredClone([...f.collection.traces]);
  const report = inspect(f);
  assert.equal(report.private_owner_close_verified, false);
  assert.equal(report.strict_trace, "failed");
  assert.deepEqual([...f.collection.traces], before);
});
for (const service of ["agent-ui", "agent-acp-service", "antnest-runtime"])
  test("Logout rejects unowned internal diagnostic in " + service, () => {
    const f = logoutFeedFixture();
    inspect(f);
    const ui = f.trace.spans.find(
      (row) => f.trace.processes[row.processID].serviceName === "agent-ui",
    );
    const processID = "unowned-process";
    f.trace.processes[processID] = {
      ...structuredClone(f.trace.processes[ui.processID]),
      serviceName: service,
    };
    f.trace.spans.push({
      ...structuredClone(ui),
      spanID: "unowned-internal",
      processID,
      operationName: "unowned.operation",
      references: [
        { refType: "CHILD_OF", traceID: f.trace.traceID, spanID: ui.spanID },
      ],
      tags: [
        { key: "span.kind", value: "internal" },
        { key: "error", value: true },
      ],
      logs: [],
    });
    assert.throws(() => inspect(f));
  });
