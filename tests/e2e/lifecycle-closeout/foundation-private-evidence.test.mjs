import assert from "node:assert/strict";
import test from "node:test";
import { assertAdmissionError } from "../../support/acp-errors.mjs";
import {
  foundationConnectionFixture,
  setup,
  prompt,
} from "./foundation-connection.fixture.mjs";
const { openFoundationConnection } =
  await import("./foundation-connection.mjs");

const url = new URL("./foundation-private-evidence.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
const clean = {
  topology: "passed",
  strict_trace: "passed",
  error_spans: 0,
  warning_count: 0,
  warnings: [],
};
async function fixture(t) {
  assert.equal(typeof implementation.foundationPrivateAdmission, "function");
  const f = await foundationConnectionFixture(t);
  const open = () =>
    openFoundationConnection("agent", f.browser, {
      ...f.options,
      preserve() {},
    });
  const first = f.register(await open());
  const a = (await first.request("new", setup)).sessionId;
  const b = (await first.request("new", setup)).sessionId;
  const held = first.request("prompt", prompt(a), 180000, {
    kind: "ordinary",
    phase: "c3-held-run",
  });
  await f.entered;
  for (let i = 0; i < 2; i++)
    await assert.rejects(
      first.request("prompt", prompt(b), 15000, { rejection: "agent_busy" }),
      (error) => {
        assertAdmissionError(error, "agent_busy");
        return true;
      },
    );
  f.release();
  await held;
  await first.closeAndWait();
  const second = f.register(await open());
  await second.request("load", { ...setup, sessionId: a });
  await second.request("prompt", prompt(a), 60000, {
    kind: "ordinary",
    phase: "c3-after-rebuild",
    toolName: "read",
  });
  await second.closeAndWait();
  const connections = [first.snapshot(), second.snapshot()];
  let serial = 0,
    run = 0;
  const traces = connections
    .flatMap((c) => [c.initialization, ...c.evidence])
    .map((row) => {
      const errors = row.rejection
        ? [1, 2].map((i) => ({
            trace_id: `trace-${serial}`,
            span_id: `span-${i}`,
            reason: "managed-busy-rejection",
          }))
        : [];
      const result = {
        ...clean,
        trace_id: `trace-${serial++}`,
        method: row.method,
        request_id: row.requestId,
        connection_trace_id: row.connectionTraceID,
        session_id: row.sessionId,
        runs: row.kind === "ordinary" ? 1 : 0,
        runtime_tool_calls: row.kind === "ordinary" ? 1 : 0,
        ...(row.kind === "ordinary" ? { run_id: `run-${++run}` } : {}),
        ...(row.rejection
          ? { rejection: row.rejection, no_execution: true }
          : {}),
        diagnostic_inventory_verified: true,
        raw_error_inventory: errors.map(({ trace_id, span_id }) => ({
          trace_id,
          span_id,
        })),
        owned_error_spans: errors,
        error_spans: errors.length,
        strict_trace: errors.length ? "failed" : "passed",
      };
      return result;
    });
  const lifecycle = [
    "create",
    "create",
    "delete",
    "rebuild",
    "disable",
    "enable",
    "delete",
    "create",
    "delete",
  ];
  return {
    profile: "lifecycle-foundation-and-startup-failure",
    operations: 9,
    lifecycle_kinds: lifecycle,
    replay_observation_events: 1,
    traces: [...lifecycle, "create-replay", "runtime-observation"].map(
      (kind, i) => ({
        ...clean,
        kind,
        trace_id: `lifecycle-${i}`,
        ...(kind === "runtime-observation"
          ? { agent_id: "failed-agent", event_id: "event-one" }
          : {}),
        ...(kind === "create-replay"
          ? { agent_id: "failed-agent", readonly_transaction: true }
          : {}),
      }),
    ),
    active_run_rebuild: {
      completed_prompts: 2,
      denied_prompts: 2,
      cleanup_completed: true,
      private_connections: connections,
      private_state_receipts: [
        {
          agentId: "agent",
          method: "POST",
          path: "/rpc/agent-acp/get-agent-execution-state",
          status: 200,
          rawBody: JSON.stringify({ ...f.state, active_session_id: a }),
        },
      ],
      run_ids: ["run-1", "run-2"],
      run_traces: traces,
      provider_requests: traces
        .filter((r) => r.runs)
        .flatMap((r, i) =>
          ["tool", "reply"].map((stage) => ({
            phase: i === 0 ? "c3-held-run" : "c3-after-rebuild",
            stage,
            trace_id: r.trace_id,
          })),
        ),
    },
  };
}

test("Foundation admission accounts for original two connections, all nine requests and independent lifecycle evidence", async (t) => {
  const report = await fixture(t);
  const result = implementation.foundationPrivateAdmission(report);
  assert.equal(result.strict_exit, 2);
  assert.equal(result.accepted_exit, 0);
  assert.deepEqual(result.inventory, {
    connections: 2,
    initializations: 2,
    business_requests: 7,
    runs: 2,
    provider_requests: 4,
    runtime_tool_calls: 2,
    lifecycle_admissions: 9,
    create_replays: 1,
    observation_events: 1,
    observation_traces: 1,
  });
  assert.equal(report.active_run_rebuild.run_traces[4].strict_trace, "failed");
});
test("Foundation retains two distinct persisted observation events sharing one independent synchronize Trace", async (t) => {
  const report = await fixture(t);
  report.traces.push({ ...report.traces.at(-1), event_id: "event-two" });
  report.replay_observation_events = 2;
  const result = implementation.foundationPrivateAdmission(report);
  assert.equal(result.accepted_exit, 0);
  assert.equal(result.inventory.observation_events, 2);
  assert.equal(result.inventory.observation_traces, 1);
});
for (const [name, mutate] of [
  [
    "duplicate observation event",
    (r) => {
      r.traces.push({ ...r.traces.at(-1), trace_id: "another-observation" });
      r.replay_observation_events = 2;
    },
  ],
  [
    "observation borrowed from admission",
    (r) => (r.traces.at(-1).trace_id = r.traces[0].trace_id),
  ],
  [
    "observation from another Agent",
    (r) => (r.traces.at(-1).agent_id = "foreign-agent"),
  ],
  [
    "missing initialization",
    (r) => r.active_run_rebuild.run_traces.splice(6, 1),
  ],
  [
    "unjoined connection",
    (r) => (r.active_run_rebuild.private_connections[0].closed = false),
  ],
  [
    "unfinished exporter",
    (r) => (r.active_run_rebuild.cleanup_completed = false),
  ],
  [
    "foreign request trace",
    (r) => (r.active_run_rebuild.run_traces[3].request_id = "other"),
  ],
  [
    "foreign connection trace",
    (r) => (r.active_run_rebuild.run_traces[3].connection_trace_id = "other"),
  ],
  ["foreign Run", (r) => (r.active_run_rebuild.run_traces[8].run_id = "run-3")],
  [
    "duplicate business trace",
    (r) =>
      (r.active_run_rebuild.run_traces[8].trace_id =
        r.active_run_rebuild.run_traces[3].trace_id),
  ],
  [
    "busy wire rejection changed",
    (r) =>
      (r.active_run_rebuild.private_connections[0].raw_frames.find(
        (f) => f.error,
      ).error.data.retryable = false),
  ],
  [
    "busy session replaced",
    (r) =>
      (r.active_run_rebuild.private_connections[0].evidence[3].sessionId =
        "other"),
  ],
  [
    "provider phase omitted",
    (r) => r.active_run_rebuild.provider_requests.pop(),
  ],
  [
    "provider detached",
    (r) => (r.active_run_rebuild.provider_requests[0].trace_id = "other"),
  ],
  [
    "state configuration omitted",
    (r) => {
      const body = JSON.parse(
        r.active_run_rebuild.private_state_receipts[0].rawBody,
      );
      delete body.configuration_revision;
      r.active_run_rebuild.private_state_receipts[0].rawBody =
        JSON.stringify(body);
    },
  ],
  [
    "Gateway state substituted",
    (r) =>
      (r.active_run_rebuild.private_state_receipts[0].path =
        "/api/app/agents/agent/state"),
  ],
  ["read-only replay omitted", (r) => r.traces.splice(9, 1)],
  ["observation omitted", (r) => r.traces.pop()],
  ["lifecycle admission replaced", (r) => (r.traces[3].kind = "enable")],
])
  test(`Foundation rejects ${name}`, async (t) => {
    const report = await fixture(t);
    mutate(report);
    assert.throws(() => implementation.foundationPrivateAdmission(report));
  });
for (const [name, mutate] of [
  [
    "unknown private diagnostic",
    (r) =>
      (r.active_run_rebuild.run_traces[4].owned_error_spans[0].reason =
        "unreviewed-internal-error"),
  ],
  [
    "unclaimed raw error",
    (r) => r.active_run_rebuild.run_traces[4].owned_error_spans.pop(),
  ],
  [
    "source lifecycle error",
    (r) => {
      Object.assign(r.traces[0], {
        strict_trace: "failed",
        error_spans: 1,
        resolve_source_error_spans: 1,
      });
    },
  ],
])
  test(`Foundation cannot accept ${name}`, async (t) => {
    const report = await fixture(t);
    mutate(report);
    assert.equal(
      implementation.foundationPrivateAdmission(report).accepted_exit,
      1,
    );
  });
