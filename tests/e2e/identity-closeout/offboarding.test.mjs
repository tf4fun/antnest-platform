import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import {
  assertDisabled,
  inspectOffboardingTrace,
  failureCategory,
} from "./offboarding-evidence.mjs";

import { offboardingFixture } from "./offboarding-trace-fixture.mjs";
test("offboarding requires disabled Agent and independently absent Runtime", () => {
  const agent = {
    agent_id: "agent-a",
    desired_state: "disabled",
    lifecycle_state: "created",
    activation_state: "disabled",
  };
  const runtime = {
    agent_id: "agent-a",
    lifecycle_state: "disabled",
    health: "absent",
    runtime_execution_id: "",
    mcp_endpoint: "",
  };
  assertDisabled(agent, runtime, "agent-a");
  for (const patch of [
    { health: "unknown" },
    { lifecycle_state: "deleted" },
    { mcp_endpoint: "http://live/mcp" },
    { agent_id: "agent-b" },
  ])
    assert.throws(() =>
      assertDisabled(agent, { ...runtime, ...patch }, "agent-a"),
    );
  assert.throws(() =>
    assertDisabled({ ...agent, desired_state: "enabled" }, runtime, "agent-a"),
  );
});
test("failure diagnostics never echo SDK or malformed JSON payloads", () => {
  for (const error of [
    new SyntaxError("bad JSON synthetic-password"),
    new Error("SDK synthetic-password"),
    Object.assign(new Error("synthetic-password"), { code: "ERR_ASSERTION" }),
  ]) {
    assert(!failureCategory(error).includes("synthetic-password"));
  }
});
test("actual fixture process fails safely during bootstrap, cleanup and async Pool errors", () => {
  const module = new URL("./offboarding-evidence.mjs", import.meta.url).href;
  for (const body of [
    `JSON.parse('malformed synthetic-password')`,
    `try {} finally { await Promise.reject(new Error('synthetic-password')); }`,
    `const {EventEmitter}=await import('node:events'); setImmediate(()=>new EventEmitter().emit('error',new Error('synthetic-password')));`,
  ]) {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import {installFailureBoundary} from ${JSON.stringify(module)}; installFailureBoundary(); ${body}`,
      ],
      { encoding: "utf8", timeout: 3000, maxBuffer: 65536 },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.deepEqual(JSON.parse(result.stderr), {
      event: "agent_access_failed",
      reason: "fixture_or_dependency_failed",
    });
    assert(!result.stderr.includes("synthetic-password"));
  }
});
test("offboarding binds source receipt and Agent schedule to current Temporal Disable and all committed phases", () => {
  const { trace, expected } = offboardingFixture();
  const r = inspectOffboardingTrace([trace], expected, []);
  assert.equal(r.phases.length, 5);
  assert.equal(r.settlement, true);
});
for (const [name, mutate] of [
  [
    "missing receipt",
    (t) => (t.spans = t.spans.filter((s) => s.spanID !== "receipt")),
  ],
  [
    "wrong event",
    (t) =>
      (t.spans
        .find((s) => s.spanID === "receipt")
        .tags.find((f) => f.key === "identity.revocation.sequence").value = 99),
  ],
  [
    "wrong Agent",
    (t) =>
      (t.spans
        .find((s) => s.spanID === "schedule")
        .tags.find((f) => f.key === "agent.id").value = "other"),
  ],
  [
    "detached workflow",
    (t) =>
      (t.spans.find((s) => s.spanID === "workflow").references[0].spanID =
        "controller"),
  ],
  [
    "missing phase",
    (t) => (t.spans = t.spans.filter((s) => s.spanID !== "lifecycle.publish")),
  ],
  [
    "wrong workflow",
    (t) =>
      (t.spans
        .find((s) => s.spanID === "lifecycle.drain")
        .tags.find((f) => f.key === "temporalWorkflowID").value = "other"),
  ],
  [
    "no commit",
    (t) =>
      (t.spans
        .find((s) => s.spanID === "transaction-lifecycle.drain")
        .tags.find((f) => f.key === "antnest.transaction.outcome").value =
        "rolled_back"),
  ],
  [
    "missing settlement",
    (t) => (t.spans = t.spans.filter((s) => s.spanID !== "settle-agent")),
  ],
  [
    "wrong settlement",
    (t) =>
      (t.spans
        .find((s) => s.spanID === "settle-agent-client")
        .tags.find((f) => f.key === "antnest.operation.id").value = "other"),
  ],
  [
    "inspection instead of mutation",
    (t) =>
      (t.spans
        .find((s) => s.spanID === "rpc-lifecycle.runtime_disable")
        .tags.find((f) => f.key === "http.route").value =
        "/internal/runtimes/{agent_id}"),
  ],
  [
    "private payload",
    (t) => t.spans[0].tags.push({ key: "private", value: "PRIVATE" }),
  ],
])
  test(`offboarding rejects ${name}`, () => {
    const { trace, expected } = offboardingFixture();
    mutate(trace);
    assert.throws(() =>
      inspectOffboardingTrace([trace], expected, ["PRIVATE"]),
    );
  });
test("offboarding retains strict warning failures", () => {
  const { trace, expected } = offboardingFixture();
  trace.warnings = ["clock diagnostic"];
  assert.equal(
    inspectOffboardingTrace([trace], expected, []).strict_trace,
    "failed",
  );
});

test("global user revocation scopes phases to the matching Agent workflow within a shared source Trace", () => {
  const { trace, expected } = offboardingFixture();
  const selected = new Set(["workflow"]);
  let added = true;
  while (added) {
    added = false;
    for (const s of trace.spans)
      if (
        !selected.has(s.spanID) &&
        s.references.some(
          (r) => r.refType === "CHILD_OF" && selected.has(r.spanID),
        )
      ) {
        selected.add(s.spanID);
        added = true;
      }
  }
  const other = trace.spans
    .filter((s) => selected.has(s.spanID))
    .map((s) => {
      const copy = structuredClone(s);
      copy.spanID += "-other";
      for (const r of copy.references)
        r.spanID = selected.has(r.spanID)
          ? r.spanID + "-other"
          : r.spanID === "schedule"
            ? "schedule-other"
            : r.spanID;
      for (const tag of copy.tags)
        if (tag.key === "temporalWorkflowID")
          tag.value = "agent-disable/other-request";
      return copy;
    });
  const schedule = structuredClone(
    trace.spans.find((s) => s.spanID === "schedule"),
  );
  schedule.spanID = "schedule-other";
  schedule.tags.find((t) => t.key === "agent.id").value = "agent-other";
  trace.spans.push(schedule, ...other);
  assert.equal(inspectOffboardingTrace([trace], expected, []).phases.length, 5);
  trace.spans = trace.spans.filter((s) => s.spanID !== "lifecycle.publish");
  assert.throws(() => inspectOffboardingTrace([trace], expected, []));
});

test("Docker cleanup probes of another revoked Agent's Disable stay outside the selected Agent", () => {
  const { trace, expected } = offboardingFixture();
  const schedule = structuredClone(
    trace.spans.find((s) => s.spanID === "schedule"),
  );
  schedule.spanID = "schedule-other";
  schedule.tags.find((t) => t.key === "agent.id").value = "agent-other";
  trace.processes["runtime-controller"] ??= {
    serviceName: "runtime-controller",
  };
  const span = (spanID, parent, operationName, tags) => ({
    traceID: trace.traceID,
    spanID,
    processID: "runtime-controller",
    operationName,
    startTime: 4,
    duration: 1,
    references: [
      { refType: "CHILD_OF", traceID: trace.traceID, spanID: parent },
    ],
    tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
  });
  trace.spans.push(
    schedule,
    span("other-delete", "schedule-other", "runtime.platform.delete", {
      "antnest.agent.id": "agent-other",
      "antnest.outcome": "completed",
      "antnest.platform": "docker",
    }),
    span("other-probe", "other-delete", "HTTP DELETE docker", {
      "peer.service": "docker",
      "http.response.status_code": 404,
    }),
  );
  assert.equal(inspectOffboardingTrace([trace], expected, []).phases.length, 5);
});
