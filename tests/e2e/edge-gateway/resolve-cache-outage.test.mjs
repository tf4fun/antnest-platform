import assert from "node:assert/strict";
import test from "node:test";
import {
  inspectOutageWindow,
  inspectFreshConsumerWindow,
  outageText,
} from "./resolve-cache-outage.mjs";
import { view } from "./resolve-cache-stream-fixtures.mjs";

function sample() {
  const selected = view("session-1", "cursor-3");
  selected.selectedView.outputWatermark = 3;
  selected.selectedView.turns = [
    {
      turnId: "run-1",
      outcome: "running",
      prompt: [],
      finalResponse: [{ type: "text", text: outageText }],
    },
  ];
  const terminal = structuredClone(selected);
  terminal.selectedView.turns[0].outcome = "cancelled";
  const frame = (direction, at, method, params) => ({
    direction,
    at,
    raw: JSON.stringify({ jsonrpc: "2.0", method, params }),
  });
  return {
    agent_id: "agent-1",
    session_id: "session-1",
    run_id: "run-1",
    identity: {
      before: {
        id: "identity-1",
        running: true,
        started_at: "2026-10-12T00:00:00Z",
      },
      stopped: {
        id: "identity-1",
        running: false,
        restarting: false,
        started_at: "2026-10-12T00:00:00Z",
        finished_at: "2026-10-12T00:00:10Z",
        at: 1000,
      },
      stopped_end: {
        id: "identity-1",
        running: false,
        restarting: false,
        started_at: "2026-10-12T00:00:00Z",
        finished_at: "2026-10-12T00:00:10Z",
        at: 6000,
      },
      restart_started_at: 6001,
      after: {
        id: "identity-1",
        running: true,
        started_at: "2026-10-12T00:00:16Z",
        at: 7000,
      },
    },
    release: { started_at: 1100, at: 1150, status: 200 },
    cancel_at: 1500,
    wire: {
      upgrade: { status: 101, trace_id: "a".repeat(32), at: 500 },
      frames: [
        frame("receive", 1200, "session/update", {
          sessionId: "session-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: outageText },
          },
          _meta: {
            "antnest.dev/delivery": {
              kind: "part",
              sequence: 3,
              partIndex: 0,
              partCount: 1,
              runId: "run-1",
              messageId: "message-1",
            },
          },
        }),
        frame("send", 1501, "session/cancel", {
          sessionId: "session-1",
          _meta: { "antnest.dev/target-cancel": { expectedRunId: "run-1" } },
        }),
      ],
    },
    stream: {
      status: 200,
      trace_id: "b".repeat(32),
      headers_at: 550,
      records: [
        { at: 1250, view: selected },
        { at: 1800, view: terminal },
      ],
    },
    model_started: {
      at: 700,
      state: {
        errors: [],
        pending: ["c4-cache-outage"],
        requests: [
          { phase: "c4-cache-outage", stage: "tool", received_at_ms: 10 },
        ],
      },
    },
    model_held: {
      at: 1300,
      state: {
        errors: [],
        pending: ["c4-cache-outage"],
        requests: [
          {
            phase: "c4-cache-outage",
            stage: "tool",
            received_at_ms: 10,
            released_at_ms: 20,
          },
          { phase: "c4-cache-outage", stage: "reply", received_at_ms: 30 },
        ],
      },
    },
    model_cancelled: {
      at: 1750,
      state: {
        errors: [],
        pending: [],
        requests: [
          {
            phase: "c4-cache-outage",
            stage: "tool",
            received_at_ms: 10,
            released_at_ms: 20,
          },
          {
            phase: "c4-cache-outage",
            stage: "reply",
            received_at_ms: 30,
            disconnected: true,
            disconnected_at_ms: 40,
          },
        ],
      },
    },
    audit: {
      status: 200,
      trace_id: "c".repeat(32),
      started_at: 1800,
      at: 1850,
      set_cookie_count: 0,
      body: {
        run_id: "run-1",
        agent_id: "agent-1",
        session_id: "session-1",
        state: "cancelled",
        terminal_class: "cancelled",
        executor_state: "quiescent",
        tool_effect_state: "settled",
      },
    },
  };
}

test("outage admission requires fresh WSS/SSE output and the same Run's settled cancellation before actual restart", () => {
  const result = inspectOutageWindow(sample());
  assert.equal(result.run_id, "run-1");
  assert.equal(result.stopped_ms, 5001);
  assert.equal(result.output_watermark, 3);
});

for (const [name, change] of [
  [
    "short stop",
    (s) => {
      s.identity.restart_started_at = 5900;
    },
  ],
  [
    "Identity running",
    (s) => {
      s.identity.stopped_end.running = true;
    },
  ],
  [
    "replacement container",
    (s) => {
      s.identity.after.id = "another";
    },
  ],
  [
    "no actual restart",
    (s) => {
      s.identity.after.started_at = s.identity.before.started_at;
    },
  ],
  [
    "old output",
    (s) => {
      s.wire.frames[0].at = 900;
    },
  ],
  [
    "old output replayed in the window",
    (s) => {
      s.wire.frames.unshift({ ...s.wire.frames[0], at: 600 });
    },
  ],
  [
    "changed first model identity",
    (s) => {
      s.model_held.state.requests[0].received_at_ms = 15;
      s.model_cancelled.state.requests[0].received_at_ms = 15;
    },
  ],
  [
    "Identity restarted and stopped again",
    (s) => {
      s.identity.stopped_end.started_at = "2026-10-12T00:00:11Z";
      s.identity.stopped_end.finished_at = "2026-10-12T00:00:12Z";
    },
  ],
  [
    "Identity restarting",
    (s) => {
      s.identity.stopped_end.restarting = true;
    },
  ],
  [
    "already released model",
    (s) => {
      s.model_started.state.requests[0].released_at_ms = 11;
    },
  ],
  [
    "foreign output Run",
    (s) => {
      const p = JSON.parse(s.wire.frames[0].raw);
      p.params._meta["antnest.dev/delivery"].runId = "foreign";
      s.wire.frames[0].raw = JSON.stringify(p);
    },
  ],
  [
    "incomplete output batch",
    (s) => {
      const p = JSON.parse(s.wire.frames[0].raw);
      p.params._meta["antnest.dev/delivery"].partCount = 2;
      s.wire.frames[0].raw = JSON.stringify(p);
    },
  ],
  [
    "prompt-only marker",
    (s) => {
      for (const r of s.stream.records) {
        const t = r.view.selectedView.turns[0];
        t.prompt = t.finalResponse;
        t.finalResponse = [];
      }
    },
  ],
  [
    "stale projection",
    (s) => {
      for (const r of s.stream.records) r.view.selectedView.outputWatermark = 2;
    },
  ],
  [
    "foreign SSE Session",
    (s) => {
      for (const r of s.stream.records)
        r.view.selectedView.sessionId = "foreign";
    },
  ],
  [
    "no cancel",
    (s) => {
      s.wire.frames.pop();
    },
  ],
  [
    "late cancel",
    (s) => {
      s.wire.frames[1].at = 6100;
    },
  ],
  [
    "early local stream close",
    (s) => {
      s.stream.closure = { kind: "local-close", at: 1700 };
    },
  ],
  [
    "model still running",
    (s) => {
      delete s.model_cancelled.state.requests[1].disconnected;
    },
  ],
  [
    "model fixture error",
    (s) => {
      s.model_held.state.errors.push("unmatched request");
    },
  ],
  [
    "wrong terminal Run",
    (s) => {
      s.audit.body.run_id = "another";
    },
  ],
  [
    "unknown tool outcome",
    (s) => {
      s.audit.body.tool_effect_state = "unknown";
    },
  ],
  [
    "executor not quiescent",
    (s) => {
      s.audit.body.executor_state = "running";
    },
  ],
  [
    "post-recovery audit",
    (s) => {
      s.audit.at = 6500;
    },
  ],
  [
    "renewed session",
    (s) => {
      s.audit.set_cookie_count = 1;
    },
  ],
])
  test(`outage admission rejects ${name}`, () => {
    const value = sample();
    change(value);
    assert.throws(() => inspectOutageWindow(value));
  });

test("SSE retains new model text when the real read moves it into Intermediate response", () => {
  const value = sample();
  const turn = value.stream.records[0].view.selectedView.turns[0];
  turn.liveProcessDelta = {
    fromVersion: 0,
    items: [
      {
        index: 0,
        item: {
          kind: "notice",
          summary: "Intermediate response",
          status: "completed",
          content: turn.finalResponse,
        },
      },
    ],
  };
  turn.finalResponse = [];
  value.stream.records[1].view.selectedView.turns[0].finalResponse = [];
  assert.equal(inspectOutageWindow(value).output_watermark, 3);
});

function consumers() {
  const value = sample();
  value.project = "antnest-lifecycle-abcd1234";
  value.consumer_restarts = ["agent-acp-service", "agent-ui"].map(
    (service) => ({
      service,
      started_at: 100,
      before: { id: service, started_at: "2026-10-12T00:00:00Z" },
      after: {
        id: service,
        service,
        project: value.project,
        running: true,
        health: "healthy",
        started_at: "2026-10-12T00:00:01Z",
        at: 400,
      },
    }),
  );
  value.session_deadlines = {
    owner: { principal: { organization_id: "org-1" } },
    admin: { principal: { organization_id: "org-1" } },
  };
  value.consumer_configuration = {
    synchronization: {
      status: 200,
      trace_id: "d".repeat(32),
      started_at: 410,
      at: 430,
      body: {
        synchronization: {
          revision: 8,
          applied_revision: 8,
          applied_at: "2026-10-12T00:00:02Z",
        },
      },
    },
    state: {
      status: 200,
      trace_id: "e".repeat(32),
      started_at: 440,
      at: 460,
      body: {
        agent_id: "agent-1",
        access_allowed: true,
        availability: "ready",
        active_session_id: null,
        configuration_revision: "f".repeat(64),
        unavailable_reason: null,
      },
    },
  };
  return value;
}
test("new Node process starts bound the two successfully admitted consumer key caches conservatively", () => {
  assert.equal(
    inspectFreshConsumerWindow(consumers()).conservative_deadline,
    30100,
  );
});
for (const [label, change] of [
  [
    "stale process",
    (e) => {
      e.consumer_restarts[0].after.started_at =
        e.consumer_restarts[0].before.started_at;
    },
  ],
  [
    "missing service",
    (e) => {
      e.consumer_restarts.pop();
    },
  ],
  [
    "foreign project",
    (e) => {
      e.consumer_restarts[0].after.project = "another";
    },
  ],
  [
    "admission before restart",
    (e) => {
      e.wire.upgrade.at = 350;
    },
  ],
  [
    "expired lower bound",
    (e) => {
      e.identity.restart_started_at = 30100;
    },
  ],
  [
    "failed actual Node admission",
    (e) => {
      e.stream.status = 401;
    },
  ],
  [
    "stale configuration acknowledgement",
    (e) => {
      e.consumer_configuration.synchronization.body.synchronization.applied_at =
        "2026-10-12T00:00:00Z";
    },
  ],
  [
    "pending configuration revision",
    (e) => {
      e.consumer_configuration.synchronization.body.synchronization
        .applied_revision--;
    },
  ],
  [
    "foreign organization acknowledgement",
    (e) => {
      e.session_deadlines.admin.principal.organization_id = "foreign";
    },
  ],
  [
    "healthy process with unready Agent",
    (e) => {
      e.consumer_configuration.state.body.availability = "offline";
    },
  ],
  [
    "foreign Agent state",
    (e) => {
      e.consumer_configuration.state.body.agent_id = "foreign";
    },
  ],
  [
    "configuration read after admission",
    (e) => {
      e.consumer_configuration.state.at = 510;
    },
  ],
])
  test(`consumer key lower bound rejects ${label}`, () => {
    const value = consumers();
    change(value);
    assert.throws(() => inspectFreshConsumerWindow(value));
  });
