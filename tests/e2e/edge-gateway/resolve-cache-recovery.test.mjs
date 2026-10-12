import assert from "node:assert/strict";
import test from "node:test";
import {
  inspectRecoveryWindow,
  recoveryCases,
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

export function recoveryFixture() {
  let sequence = 0;
  const e = {
    agent_id: "agent",
    identity: { healthy: { running: true, health: "healthy", at: 10 } },
    http: [],
    model_observations: [],
    recovery: { cases: [] },
  };
  const principal = {
    user_id: "user",
    membership_id: "membership",
    organization_id: "org",
    organization_role: "member",
    active: true,
  };
  const http = (path, at, body, extra = {}) => {
    const row = {
      trace_id: (++sequence).toString(16).padStart(32, "0"),
      path,
      method: "GET",
      started_at: at - 1,
      at,
      status: 200,
      set_cookie_count: 0,
      body,
      ...extra,
    };
    e.http.push(row);
    return row;
  };
  for (const [index, { name, phase }] of recoveryCases.entries()) {
    const start = 100 + index * 1000,
      scope = `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
    const peerScope = `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
    const p = {
      ...principal,
      organization_role: index === 3 ? "admin" : "member",
    };
    const c = {
      name,
      phase,
      session_id: `session-${index}`,
      run_id: `run-${index}`,
      intent_id: `intent-${index}`,
    };
    const login = (at, issued, role = p.organization_role) =>
      http(
        "/api/session/login",
        at,
        {
          principal: { ...p, organization_role: role },
          expires_at: "2026-10-13T00:00:00Z",
          idle_expires_at: "2026-10-12T23:00:00Z",
          activity_interval_ms: 30000,
        },
        {
          method: "POST",
          set_cookie_count: 2,
          issued_credential_scope: issued,
        },
      );
    c.login = login(start, scope);
    c.peer_login = login(start + 1, peerScope);
    c.wire = {
      started_at: start + 2,
      credential_scope: scope,
      upgrade: {
        at: start + 3,
        status: 101,
        trace_id: (++sequence).toString(16).padStart(32, "0"),
      },
      frames: [
        {
          at: start + 4,
          direction: "send",
          raw: '{"id":1,"method":"initialize"}',
        },
      ],
    };
    c.stream = {
      status: 200,
      set_cookie_count: 0,
      credential_scope: scope,
      path: `/api/app/workspace/v1/agents/agent/events?sessionId=${c.session_id}`,
      started_at: start + 5,
      headers_at: start + 6,
      trace_id: (++sequence).toString(16).padStart(32, "0"),
      records: [
        {
          at: start + 12,
          view: {
            agentId: "agent",
            activeSessionId: c.session_id,
            selectedSessionId: c.session_id,
            selectedView: { agentId: "agent", sessionId: c.session_id },
            availability: "busy",
            operations: [
              {
                operationId: c.intent_id,
                acceptance: "acp",
                phase: "running",
                runId: c.run_id,
                sessionId: c.session_id,
              },
            ],
          },
        },
      ],
      closure: { kind: "remote-end", at: start + 40 },
    };
    c.prompt = http(
      `/api/app/workspace/v1/agents/agent/sessions/${c.session_id}/prompts`,
      start + 10,
      { acceptance: "bridge", operationId: c.intent_id },
      { method: "POST", status: 202, credential_scope: scope },
    );
    const model = (at, terminal = false) => {
      const observation = {
        at,
        state: {
          errors: [],
          pending: terminal ? [] : [phase],
          requests: [
            {
              phase,
              stage: "reply",
              trace_id: c.prompt.trace_id,
              model_span_id: "1111111111111111",
              received_at_ms: start + 11,
              ...(terminal
                ? name === "deactivate"
                  ? { disconnected: true, disconnected_at_ms: start + 45 }
                  : { released_at_ms: start + 60 }
                : {}),
            },
          ],
        },
      };
      e.model_observations.push(observation);
      return observation;
    };
    const audit = (at, state) =>
      http(`/api/admin/execution-audits/${c.run_id}`, at, {
        run_id: c.run_id,
        agent_id: "agent",
        session_id: c.session_id,
        principal_id: "user",
        state,
        created_at: "2026-10-12T12:00:00Z",
        input: [{ type: "text", text: phase }],
        execution_snapshot: { version: 1 },
        terminal_class: state === "running" ? null : state,
        executor_state: state === "running" ? null : "quiescent",
        tool_effect_state: state === "running" ? null : "none",
        stop_reason: state === "completed" ? "end_turn" : null,
        error_class: null,
      });
    c.model_started = model(start + 13);
    c.audit_before = audit(start + 14, "running");
    c.trigger = { at: start + 20, observed_at_ms: start + 20 };
    c.quiet_requests = c.wire.frames.map((f) => f.raw);
    c.mutation = http(
      name === "logout"
        ? "/api/session"
        : name === "password"
          ? "/api/session/password"
          : "/api/admin/directory/memberships/membership",
      start + 22,
      name === "logout"
        ? null
        : name === "password"
          ? c.login.body
          : {
              membership: {
                id: "membership",
                user_id: "user",
                role: "admin",
                active: name !== "deactivate",
              },
            },
      {
        method: name === "logout" ? "DELETE" : "POST",
        status: name === "logout" ? 204 : 200,
        set_cookie_count: ["logout", "password"].includes(name) ? 2 : 0,
        credential_scope: ["logout", "password"].includes(name)
          ? scope
          : "admin-scope",
      },
    );
    if (name === "password")
      c.mutation.issued_credential_scope = "rotated-password-scope";
    c.wss_close = {
      code: 1008,
      reason: "session_rejected",
      at: start + 35,
      observed_at: start + 35,
      localClose: false,
    };
    c.old_session = http(
      "/api/session",
      start + 42,
      { code: "unauthenticated" },
      { status: 401, credential_scope: scope },
    );
    c.peer_session = http(
      "/api/session",
      start + 43,
      name === "logout" ? c.login.body : { code: "unauthenticated" },
      { status: name === "logout" ? 200 : 401, credential_scope: peerScope },
    );
    if (name === "password")
      c.old_password = http(
        "/api/session/login",
        start + 44,
        { code: "invalid_credentials" },
        { method: "POST", status: 401 },
      );
    if (name === "deactivate") {
      c.deactivated_login = http(
        "/api/session/login",
        start + 44,
        { code: "invalid_credentials" },
        { method: "POST", status: 401 },
      );
      c.model_terminal = model(start + 46, true);
      c.audit_terminal = audit(start + 50, "cancelled");
      c.disabled_agent = http("/api/admin/agents/agent", start + 55, {
        agent_id: "agent",
        owner_user_id: "user",
        desired_state: "disabled",
        lifecycle_state: "created",
        activation_state: "disabled",
        runtime_state: "absent",
      });
      c.restore = http(
        "/api/admin/directory/memberships/membership",
        start + 57,
        {
          membership: {
            id: "membership",
            user_id: "user",
            role: "admin",
            active: true,
          },
        },
        { method: "POST" },
      );
      c.fresh_login = login(start + 58.5, `fresh-${index}`, "admin");
      c.restored_state = http(
        "/api/app/agents/agent/state",
        start + 60,
        {
          agent_id: "agent",
          availability: "offline",
          access_allowed: false,
          active_session_id: null,
          configuration_revision: null,
          unavailable_reason: "access_denied",
        },
        { credential_scope: `fresh-${index}` },
      );
      c.restored_old_session = http(
        "/api/session",
        start + 61,
        { code: "unauthenticated" },
        { status: 401, credential_scope: scope },
      );
    } else {
      c.model_after_close = model(start + 46);
      c.audit_after_close = audit(start + 47, "running");
      c.fresh_login = login(
        start + 48,
        `fresh-${index}`,
        name === "role" ? "admin" : "member",
      );
      c.release = { started_at: start + 59, at: start + 61, status: 200 };
      c.model_terminal = model(start + 65, true);
      c.audit_terminal = audit(start + 70, "completed");
      c.fresh_view = http(
        `/api/app/workspace/v1/agents/agent/sessions/${c.session_id}/view`,
        start + 75,
        {
          agentId: "agent",
          sessionId: c.session_id,
          turns: [
            {
              turnId: c.run_id,
              outcome: "completed",
              finalResponse: [{ type: "text", text: `${phase} completed` }],
            },
          ],
        },
        { credential_scope: `fresh-${index}` },
      );
    }
    e.recovery.cases.push(c);
  }
  return e;
}

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
