import assert from "node:assert/strict";
import test from "node:test";
import { recoveryFixture } from "./resolve-cache-recovery-fixtures.mjs";
import {
  inspectRecoveryWindow,
  recoveryMembershipUpdate,
} from "./resolve-cache-recovery.mjs";
import { inspectRecoveryRunTraces } from "./resolve-cache-recovery-trace.mjs";
import { workspaceChatFixture } from "../workspace-closeout/chat-fixtures.mjs";
import { setTag } from "../observability/gateway-resolution-fixtures.mjs";

test("directory mutations preserve Membership-owned profile fields", () => {
  const entry = {
    user: { id: "user" },
    membership: {
      id: "membership",
      user_id: "user",
      email: "member@example.com",
      display_name: "Member",
      role: "member",
      active: true,
    },
  };
  assert.deepEqual(recoveryMembershipUpdate(entry, false), {
    email: "member@example.com",
    display_name: "Member",
    role: "admin",
    active: false,
  });
  assert.throws(() =>
    recoveryMembershipUpdate(
      { ...entry, membership: { ...entry.membership, email: undefined } },
      true,
    ),
  );
});

for (const [name, change] of [
  [
    "changed model after retirement",
    (c) => {
      c.model_after_close.state.requests[0].model_span_id = "2222222222222222";
    },
  ],
  [
    "changed model receipt after retirement",
    (c) => {
      c.model_after_close.state.requests[0].received_at_ms += 1;
    },
  ],
])
  test(`recovery rejects ${name}`, () => {
    const e = recoveryFixture();
    change(e.recovery.cases[0]);
    assert.throws(() => inspectRecoveryWindow(e));
  });
for (const key of ["stop_reason", "error_class"])
  test(`offboarding cannot hide unrelated ${key}`, () => {
    const e = recoveryFixture();
    e.recovery.cases[3].audit_terminal.body[key] = "unrelated";
    assert.throws(() => inspectRecoveryWindow(e));
  });

test("recovery requires four fresh mutations with remote retirement and live Run semantics", () => {
  const result = inspectRecoveryWindow(recoveryFixture());
  assert.equal(result.status, "passed");
  assert.deepEqual(
    result.cases.map((c) => c.terminal),
    ["completed", "completed", "completed", "cancelled"],
  );
});
for (const [name, change] of [
  ["missing case", (e) => e.recovery.cases.pop()],
  [
    "reused Run",
    (e) => {
      e.recovery.cases[1].run_id = e.recovery.cases[0].run_id;
    },
  ],
  [
    "wrong held Run",
    (e, c) => {
      c.stream.records[0].view.operations[0].runId = "other";
    },
  ],
  [
    "terminal before mutation",
    (e, c) => {
      c.audit_before.body.state = "cancelled";
    },
  ],
  [
    "unregistered mutation",
    (e, c) => {
      e.http.splice(e.http.indexOf(c.mutation), 1);
    },
  ],
  [
    "wrong logout status",
    (e, c) => {
      c.mutation.status = 200;
    },
  ],
  [
    "local WSS close",
    (e, c) => {
      c.wss_close.localClose = true;
    },
  ],
  [
    "unavailable WSS close",
    (e, c) => {
      c.wss_close.code = 1013;
    },
  ],
  [
    "natural CCT close",
    (e, c) => {
      c.wss_close.reason = "caller_context_expired";
    },
  ],
  [
    "WSS close before mutation",
    (e, c) => {
      c.wss_close.observed_at = c.trigger.at - 1;
    },
  ],
  [
    "WSS close beyond bound",
    (e, c) => {
      c.wss_close.observed_at = c.trigger.at + 30001;
    },
  ],
  [
    "local SSE close",
    (e, c) => {
      c.stream.closure.kind = "local-close";
    },
  ],
  [
    "SSE invalid event",
    (e, c) => {
      c.stream.closure.kind = "invalid-event";
    },
  ],
  [
    "SSE revocation without close",
    (e, c) => {
      delete c.stream.closure;
      c.stream.revoked = { at: 140 };
    },
  ],
  [
    "active post-mutation WSS request",
    (e, c) => {
      c.wire.frames.push({
        direction: "send",
        at: c.trigger.at + 1,
        raw: '{"method":"session/list"}',
      });
    },
  ],
  [
    "old Cookie accepted",
    (e, c) => {
      c.old_session.status = 200;
    },
  ],
  [
    "401 Cookie rewrite",
    (e, c) => {
      c.old_session.set_cookie_count = 2;
    },
  ],
  [
    "wrong old credential",
    (e, c) => {
      c.old_session.credential_scope = "different";
    },
  ],
  [
    "logout revokes peer SID",
    (e, c) => {
      c.peer_session.status = 401;
    },
  ],
  [
    "model prematurely released",
    (e, c) => {
      c.model_after_close.state.requests[0].released_at_ms = 1;
    },
  ],
  [
    "model cancelled by logout",
    (e, c) => {
      c.model_terminal.state.requests[0].disconnected = true;
    },
  ],
  [
    "model replay",
    (e, c) => {
      c.model_terminal.state.requests.push(c.model_terminal.state.requests[0]);
    },
  ],
  [
    "release before retirement",
    (e, c) => {
      c.release.started_at = c.trigger.at;
    },
  ],
  [
    "terminal wrong Run",
    (e, c) => {
      c.audit_terminal.body.run_id = "different";
    },
  ],
  [
    "changed execution snapshot",
    (e, c) => {
      c.audit_terminal.body.execution_snapshot = { version: 2 };
    },
  ],
  [
    "lost original input",
    (e, c) => {
      delete c.audit_before.body.input;
    },
  ],
  [
    "already settled running audit",
    (e, c) => {
      c.audit_before.body.terminal_class = "completed";
    },
  ],
  [
    "unsettled terminal",
    (e, c) => {
      c.audit_terminal.body.executor_state = "executing";
    },
  ],
  [
    "fresh view wrong output",
    (e, c) => {
      c.fresh_view.body.turns[0].finalResponse[0].text = "old";
    },
  ],
  [
    "role update disables member",
    (e) => {
      e.recovery.cases[2].mutation.body.membership.active = false;
    },
  ],
  [
    "password leaves peer active",
    (e) => {
      e.recovery.cases[1].peer_session.status = 200;
    },
  ],
  [
    "password keeps same Cookie",
    (e) => {
      e.recovery.cases[1].mutation.issued_credential_scope =
        e.recovery.cases[1].login.issued_credential_scope;
    },
  ],
  [
    "password extends absolute deadline",
    (e) => {
      e.recovery.cases[1].mutation.body = {
        ...e.recovery.cases[1].mutation.body,
        expires_at: "2026-10-14T00:00:00Z",
      };
    },
  ],
  [
    "deactivation releases model",
    (e) => {
      e.recovery.cases[3].release = { status: 200 };
    },
  ],
  [
    "deactivation leaves model alive",
    (e) => {
      delete e.recovery.cases[3].model_terminal.state.requests[0].disconnected;
    },
  ],
  [
    "reactivation enables Agent",
    (e) => {
      e.recovery.cases[3].restored_state.body.access_allowed = true;
    },
  ],
])
  test(`recovery rejects ${name}`, () => {
    const e = recoveryFixture();
    change(e, e.recovery.cases[0]);
    assert.throws(() => inspectRecoveryWindow(e));
  });

function traceFixture() {
  const evidence = recoveryFixture(),
    traces = new Map(),
    archivedTraceIDs = new Set();
  for (const c of evidence.recovery.cases) {
    const f = workspaceChatFixture("cache", c.name === "deactivate");
    // Successful operations use telemetry outcome=ok; the durable Run has its
    // separate terminal_class=completed (as observed in real Docker evidence).
    if (c.name !== "deactivate") setTag(f.run, "antnest.outcome", "ok");
    else {
      setTag(f.http, "error.type", "DomainError");
      setTag(f.http, "error.code", "access_denied");
      setTag(f.http, "antnest.error.code", "access_denied");
      setTag(f.http, "antnest.outcome", "rejected");
      f.http.logs[0].fields.find((v) => v.key === "antnest.error.type").value =
        "DomainError";
      f.http.logs[0].fields.push({
        key: "antnest.error.code",
        value: "access_denied",
      });
    }
    for (const span of f.trace.spans) {
      span.traceID = c.prompt.trace_id;
      for (const reference of span.references)
        reference.traceID = c.prompt.trace_id;
      for (const [key, value] of [
        ["antnest.run.id", c.run_id],
        ["antnest.session.id", c.session_id],
        ["antnest.error.origin_trace_id", c.prompt.trace_id],
      ])
        if (span.tags.some((t) => t.key === key)) setTag(span, key, value);
    }
    f.trace.traceID = c.prompt.trace_id;
    traces.set(f.trace.traceID, f.trace);
    archivedTraceIDs.add(f.trace.traceID);
  }
  return { evidence, traces, archivedTraceIDs };
}
test("recovery Run gate binds all four actual Provider requests and durable terminals", () => {
  const f = traceFixture();
  const result = inspectRecoveryRunTraces(f.evidence, f);
  assert.equal(result.status, "passed");
  assert.equal(result.runs.length, 4);
  assert.equal(result.runs[3].expected_cancellation, true);
});
for (const [name, change] of [
  [
    "unrelated offboarding HTTP error",
    (f) =>
      setTag(
        [...f.traces.values()][3].spans.find(
          (s) => s.operationName === "HTTP POST model",
        ),
        "error.code",
        "unrelated",
      ),
  ],
  [
    "wrong offboarding error event",
    (f) => {
      [...f.traces.values()][3].spans
        .find((s) => s.operationName === "HTTP POST model")
        .logs[0].fields.find((v) => v.key === "antnest.error.code").value =
        "unrelated";
    },
  ],
  [
    "missing original Trace",
    (f) => f.traces.delete(f.evidence.recovery.cases[0].prompt.trace_id),
  ],
  ["unarchived Trace", (f) => f.archivedTraceIDs.clear()],
  [
    "foreign accepted Run",
    (f) =>
      setTag(
        [...f.traces.values()][0].spans.find(
          (s) => s.operationName === "agent.run",
        ),
        "antnest.run.id",
        "different",
      ),
  ],
  [
    "cancelled session-only Run",
    (f) =>
      setTag(
        [...f.traces.values()][0].spans.find(
          (s) => s.operationName === "agent.run",
        ),
        "run.terminal_class",
        "cancelled",
      ),
  ],
  [
    "unexpected model execution",
    (f) => {
      const t = [...f.traces.values()][0];
      t.spans.push({
        ...structuredClone(
          t.spans.find((s) => s.operationName === "model.complete"),
        ),
        spanID: "extra",
      });
    },
  ],
  [
    "missing durable finish",
    (f) => {
      const t = [...f.traces.values()][0];
      t.spans = t.spans.filter((s) => s.spanID !== "finish");
    },
  ],
])
  test(`recovery Run gate rejects ${name}`, () => {
    const f = traceFixture();
    change(f);
    assert.throws(() => inspectRecoveryRunTraces(f.evidence, f));
  });
