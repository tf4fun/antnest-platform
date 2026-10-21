import assert from "node:assert/strict";
import test from "node:test";
import { recoveryFixture } from "./resolve-cache-recovery-fixtures.mjs";
import {
  inspectRecoveryWindow,
  recoveryMembershipUpdate,
  recoveryStreamDeadline,
} from "./resolve-cache-recovery.mjs";
import { inspectRecoveryRunTraces } from "./resolve-cache-recovery-trace.mjs";
import { workspaceChatFixture } from "../workspace-closeout/chat-fixtures.mjs";
import { setTag } from "../observability/gateway-resolution-fixtures.mjs";

function stripTraceFields(value) {
  if (!value || typeof value !== "object") return;
  for (const key of ["trace_id", "traceID", "model_span_id"]) delete value[key];
  for (const child of Object.values(value)) stripTraceFields(child);
}

function businessRecoveryFixture() {
  const value = recoveryFixture();
  for (const [index, row] of value.http.entries())
    row.label = `recovery-http-${index}`;
  return value;
}

test("recovery business inspection accepts missing Trace fields only explicitly and preserves raw evidence", () => {
  const value = businessRecoveryFixture();
  const expected = inspectRecoveryWindow(value);
  stripTraceFields(value);
  const before = structuredClone(value);
  assert.throws(() => inspectRecoveryWindow(value));
  assert.deepEqual(
    inspectRecoveryWindow(value, { requireTrace: false }),
    expected,
  );
  assert.deepEqual(value, before);
});

for (const [name, change] of [
  [
    "SSE retirement beyond the business deadline",
    (value, c) => (c.stream.closure.at = c.trigger.at + 30001),
  ],
  [
    "terminal executor still running",
    (value, c) => (c.audit_terminal.body.executor_state = "executing"),
  ],
  [
    "foreign old credential",
    (value, c) => (c.old_session.credential_scope = "foreign-scope"),
  ],
  [
    "new observer traffic before retirement",
    (value, c) =>
      value.http.push({
        label: "unexpected-observer-request",
        method: "POST",
        path: "/api/session/activity",
        credential_scope: c.login.issued_credential_scope,
        started_at: c.trigger.at + 1,
        at: c.trigger.at + 2,
      }),
  ],
  [
    "missing actual mutation HTTP row",
    (value, c) => value.http.splice(value.http.indexOf(c.mutation), 1),
  ],
  [
    "duplicate actual mutation HTTP row",
    (value, c) => value.http.push(structuredClone(c.mutation)),
  ],
  [
    "different actual mutation label",
    (value, c) => {
      const index = value.http.indexOf(c.mutation);
      value.http[index] = {
        ...structuredClone(c.mutation),
        label: "different-recovery-request",
      };
    },
  ],
  [
    "changed actual mutation body at the same observation coordinates",
    (value, c) => {
      const index = value.http.indexOf(c.mutation);
      value.http[index] = {
        ...structuredClone(c.mutation),
        body: { unrelated: true },
      };
    },
  ],
]) {
  test(`recovery business inspection without Trace still rejects ${name}`, () => {
    const value = businessRecoveryFixture();
    stripTraceFields(value);
    inspectRecoveryWindow(value, { requireTrace: false });
    change(value, value.recovery.cases[0]);
    const before = structuredClone(value);
    assert.throws(() => inspectRecoveryWindow(value, { requireTrace: false }));
    assert.deepEqual(value, before);
  });
}

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

for (const cacheControl of [
  "no-store, no-store",
  "NO-STORE",
  " \tno-store\t ",
]) {
  test(`recovery accepts the complete no-store directive in ${JSON.stringify(cacheControl)}`, () => {
    const evidence = recoveryFixture();
    evidence.recovery.cases[3].restored_state.cache_control = cacheControl;
    assert.equal(inspectRecoveryWindow(evidence).status, "passed");
    assert.equal(
      evidence.recovery.cases[3].restored_state.cache_control,
      cacheControl,
      "the actual Header receipt remains unchanged",
    );
  });
}

for (const cacheControl of [
  undefined,
  null,
  "",
  "no-cache",
  "public, max-age=60",
  "x-no-store",
  "no-store=1",
  '"no-store"',
  "no-store-suffix",
  "no-store;",
  "public, no-store=1",
]) {
  test(`recovery rejects an absent or invalid no-store directive: ${JSON.stringify(cacheControl)}`, () => {
    const evidence = recoveryFixture();
    evidence.recovery.cases[3].restored_state.cache_control = cacheControl;
    assert.throws(() => inspectRecoveryWindow(evidence));
  });
}

test("recovery requires remote SSE closure strictly before original natural expiry", () => {
  const e = recoveryFixture(),
    c = e.recovery.cases[3];
  const deadline = recoveryStreamDeadline(c, e.settings);
  const triggerShift = 19500 - (c.trigger.at - c.stream.started_at);
  const previousTrigger = c.trigger.at;
  // Keep all original create/view/SSE/prompt ordering. Move the actual mutation
  // near 19.5s and post-close observations after the 49s expiry boundary.
  for (const row of [...e.http, ...e.model_observations]) {
    if (row.at >= previousTrigger && row.at < c.stream.closure.at) {
      row.at += triggerShift;
      if (Number.isFinite(row.started_at)) row.started_at += triggerShift;
    } else if (row.at >= c.stream.closure.at) {
      row.at += 49000;
      if (Number.isFinite(row.started_at)) row.started_at += 49000;
    }
  }
  c.trigger.at += triggerShift;
  c.stream.closure.at = deadline - 1;
  assert.equal(inspectRecoveryWindow(e).status, "passed");
  c.stream.closure.at = deadline;
  assert.throws(
    () => inspectRecoveryWindow(e),
    /natural CCT expiry may explain/u,
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
    "missing actual Bridge session creation",
    (e, c) => {
      delete c.session_create;
    },
  ],
  [
    "wrong session creation status",
    (e, c) => {
      c.session_create.status = 200;
    },
  ],
  [
    "foreign created Session",
    (e, c) => {
      c.session_create.body.sessionId = "other";
    },
  ],
  [
    "SSE close before mutation",
    (e, c) => {
      c.stream.closure.at = c.trigger.at - 1;
    },
  ],
  [
    "SSE close beyond bound",
    (e, c) => {
      c.stream.closure.at = c.trigger.at + 30001;
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
    "active post-mutation owner request before SSE retirement",
    (e, c) => {
      e.http.push({
        path: "/api/session/activity",
        credential_scope: c.login.issued_credential_scope,
        method: "POST",
        started_at: c.trigger.at + 1,
        at: c.trigger.at + 2,
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
      e.recovery.cases[3].restored_state.status = 200;
    },
  ],
  [
    "restored membership created a new Run",
    (e) => {
      e.recovery.cases[3].restore_audits_after.body.items.push({
        run_id: "unexpected",
      });
    },
  ],
  [
    "truncated restore audit inventory",
    (e) => {
      e.recovery.cases[3].restore_audits_after.body.next_cursor = "more";
    },
  ],
  [
    "empty original restore inventory",
    (e) => {
      e.recovery.cases[3].restore_audits_before.body.items = [];
      e.recovery.cases[3].restore_audits_after.body.items = [];
    },
  ],
  [
    "foreign creator credential",
    (e, c) => {
      c.session_create.credential_scope = "other";
    },
  ],
  [
    "view before session creation",
    (e, c) => {
      c.initial_view.started_at = c.session_create.started_at - 1;
    },
  ],
  [
    "created Session missing from HTTP inventory",
    (e, c) => {
      e.http.splice(e.http.indexOf(c.session_create), 1);
    },
  ],
  [
    "session Cookie rewrite",
    (e, c) => {
      c.session_create.set_cookie_count = 1;
    },
  ],
  [
    "SSE natural CCT expiry",
    (e, c) => {
      c.stream.started_at = c.stream.closure.at - 49000;
    },
  ],
  [
    "unknown deployed Resolve TTL",
    (e) => {
      delete e.settings.resolveTTLMS;
    },
  ],
  [
    "missing original stream wall time",
    (e, c) => {
      delete c.stream.started_at_ms;
    },
  ],
  [
    "disabled denial remains retryable",
    (e) => {
      e.recovery.cases[3].restored_state.body.retryable = true;
    },
  ],
  [
    "disabled denial allows recovery",
    (e) => {
      e.recovery.cases[3].restored_state.body.recovery = "retry_read";
    },
  ],
  [
    "restored membership auto-enables Agent",
    (e) => {
      e.recovery.cases[3].restored_agent.body.desired_state = "enabled";
    },
  ],
  [
    "post-restore Agent check before restoration",
    (e) => {
      e.recovery.cases[3].restored_agent.started_at = 1;
    },
  ],
])
  test(`recovery rejects ${name}`, () => {
    const e = recoveryFixture();
    change(e, e.recovery.cases[0]);
    assert.throws(() => inspectRecoveryWindow(e));
  });

for (const field of ["idle_expires_at", "expires_at"])
  test(`recovery rejects original ${field} at the 60-second boundary`, () => {
    const e = recoveryFixture(),
      c = e.recovery.cases[0];
    c.login.body[field] = new Date(
      c.stream.started_at_ms + 60000,
    ).toISOString();
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
  for (const run of result.runs.slice(0, 3))
    assert.deepEqual(run.owned_error_spans, []);
  const id = f.evidence.recovery.cases[3].prompt.trace_id;
  assert.deepEqual(result.owned_error_spans, [
    { trace_id: id, span_id: "model", reason: "model-cancellation" },
    {
      trace_id: id,
      span_id: "1111111111111111",
      reason: "model-http-cancellation",
    },
  ]);
  assert.deepEqual(result.runs[3].owned_error_spans, result.owned_error_spans);
});
test("current recovery Run receipt retains its checked view and remote SSE identities", () => {
  const f = traceFixture();
  f.evidence.policy_revision = 4;
  f.evidence.transport = "http-sse";
  const result = inspectRecoveryRunTraces(f.evidence, f);
  for (const [i, run] of result.runs.entries()) {
    const c = f.evidence.recovery.cases[i];
    assert.equal(run.view_trace_id, c.initial_view.trace_id);
    assert.equal(run.sse_trace_id, c.stream.trace_id);
    assert.equal(run.session_create_trace_id, c.session_create.trace_id);
  }
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
