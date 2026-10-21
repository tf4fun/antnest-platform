import assert from "node:assert/strict";
import test from "node:test";
import { outageRejectionFixture } from "./resolve-cache-outage-rejection-fixtures.mjs";

const moduleURL = new URL(
  "./resolve-cache-rejection-business.mjs",
  import.meta.url,
);
const { inspectOutageRejectionBusiness } = await import(moduleURL).catch(
  (error) => {
    if (error.code !== "ERR_MODULE_NOT_FOUND" || error.url !== moduleURL.href)
      throw error;
    return {};
  },
);

const refusals = [
  ["stopped-cold-console", "console"],
  ["stopped-cold-workspace", "workspace"],
  ["stopped-cold-profile", "session"],
  ["stopped-cold-agent", "workspace"],
  ["stopped-new-login", null],
  ["stopped-expired-session", "session"],
];
const expectedReport = {
  status: "passed",
  requests: refusals.map(([label, profile]) => ({
    label,
    profile,
    status: 503,
    elapsed_ms: 100,
  })),
  expired_recovery: { status: 401 },
  workspace_recovery: { status: 200 },
};

function requireAPI() {
  assert.equal(
    typeof inspectOutageRejectionBusiness,
    "function",
    "inspectOutageRejectionBusiness must be exported",
  );
}

function row(evidence, label) {
  const found = evidence.http.find((request) => request.label === label);
  assert(found, `test fixture lacks ${label}`);
  return found;
}

function removeTraceIDs(value) {
  if (value === null || typeof value !== "object") return;
  for (const key of Object.keys(value)) {
    if (key === "trace_id" || key === "traceID") delete value[key];
    else removeTraceIDs(value[key]);
  }
}

function fixture() {
  const { evidence: original } = outageRejectionFixture(4);
  const evidence = structuredClone(original);
  evidence.http.push({
    label: "recovered-workspace-view",
    credential_scope: row(evidence, "warm-login").issued_credential_scope,
    method: "GET",
    path: `/api/app/workspace/v1/agents/${evidence.agent_id}/sessions/${evidence.session_id}/view`,
    status: 200,
    cache_control: "no-store",
    set_cookie_count: 0,
    started_at: evidence.identity.restart_started_at + 1000,
    at: evidence.identity.restart_started_at + 1100,
    body: {},
  });
  removeTraceIDs(evidence);
  return evidence;
}

function addHistory(evidence, path, location = "http", login = "warm-login") {
  const request = {
    label: "earlier-protected-request",
    credential_scope: row(evidence, login).issued_credential_scope,
    method: "GET",
    path,
    status: 200,
    cache_control: "no-store",
    set_cookie_count: 0,
    started_at: 8000,
    at: 8100,
    body: {},
  };
  if (location === "http") evidence.http.push(request);
  else {
    delete request.method;
    request.headers_at = request.at;
    delete request.at;
    if (location === "outage") evidence.stream = request;
    else evidence.recovery = { cases: [{ stream: request }] };
  }
}

test("six outage refusals and both recoveries pass without any Trace collection and preserve private raw evidence", () => {
  requireAPI();
  const evidence = fixture();
  const original = structuredClone(evidence);
  assert(evidence.http.every((request) => !Object.hasOwn(request, "trace_id")));
  assert.equal(Object.hasOwn(evidence, "collection"), false);
  const report = inspectOutageRejectionBusiness(evidence);
  assert.deepEqual(report, expectedReport);
  assert.deepEqual(
    evidence,
    original,
    "business inspection must preserve raw evidence",
  );
  assert.doesNotMatch(
    JSON.stringify(report),
    /credential_scope|trace_id|span_id|"body"/u,
  );
});

for (const cacheControl of [
  "no-store, no-store",
  "private, NO-STORE",
  " \tno-store\t ",
])
  test(`business refusals retain complete no-store directives: ${cacheControl}`, () => {
    requireAPI();
    const evidence = fixture();
    for (const request of evidence.http) request.cache_control = cacheControl;
    assert.deepEqual(inspectOutageRejectionBusiness(evidence), expectedReport);
  });

for (const [label] of refusals) {
  test(`business refusal cannot omit ${label}`, () => {
    requireAPI();
    const evidence = fixture();
    evidence.http = evidence.http.filter((request) => request.label !== label);
    assert.throws(() => inspectOutageRejectionBusiness(evidence));
  });

  for (const [name, mutate] of [
    ["a non-503 response", (request) => (request.status = 200)],
    [
      "a wrong error code",
      (request) => (request.body.code = "unauthenticated"),
    ],
    ["an absent error message", (request) => delete request.body.message],
    ["a cacheable response", (request) => (request.cache_control = "public")],
    [
      "an incomplete no-store directive",
      (request) => (request.cache_control = "no-store=1"),
    ],
    ["a new Cookie", (request) => (request.set_cookie_count = 1)],
    [
      "a request before the stop",
      (request, evidence) =>
        (request.started_at = evidence.identity.stopped.at - 1),
    ],
    [
      "a response after the five-second window",
      (request, evidence) => (request.at = evidence.identity.stopped.at + 5001),
    ],
    [
      "a response before its request",
      (request) => (request.at = request.started_at - 1),
    ],
    [
      "a different credential",
      (request, evidence) =>
        (request.credential_scope = row(
          evidence,
          "audit-login",
        ).issued_credential_scope),
    ],
    [
      "an issued credential",
      (request, evidence) =>
        (request.issued_credential_scope = row(
          evidence,
          "audit-login",
        ).issued_credential_scope),
    ],
  ])
    test(`${label} rejects ${name} independently of Trace diagnostics`, () => {
      requireAPI();
      const evidence = fixture();
      mutate(row(evidence, label), evidence);
      assert.throws(() => inspectOutageRejectionBusiness(evidence));
    });
}

for (const [name, mutate] of [
  [
    "a stop shorter than five seconds",
    (evidence) =>
      (evidence.identity.restart_started_at =
        evidence.identity.stopped.at + 4999),
  ],
  [
    "Identity still running at the stop",
    (evidence) => (evidence.identity.stopped.running = true),
  ],
  [
    "Identity running at the final stopped observation",
    (evidence) => (evidence.identity.stopped_end.running = true),
  ],
  [
    "reused independent credential scopes",
    (evidence) =>
      (row(evidence, "cold-workspace-login").issued_credential_scope = row(
        evidence,
        "cold-console-login",
      ).issued_credential_scope),
  ],
  [
    "a false only-idle change receipt",
    (evidence) =>
      (evidence.rejections.expired_session.only_idle_changed = false),
  ],
  [
    "a matching no-match probe",
    (evidence) =>
      (evidence.rejections.expired_session.no_match_probe.matches = 1),
  ],
  [
    "an updating no-match probe",
    (evidence) =>
      (evidence.rejections.expired_session.no_match_probe.updated = 1),
  ],
  [
    "a changed no-match probe",
    (evidence) =>
      (evidence.rejections.expired_session.no_match_probe.unchanged = false),
  ],
  [
    "insufficient protected unchanged rows",
    (evidence) => (evidence.rejections.expired_session.protected_unchanged = 1),
  ],
  [
    "an unchanged idle deadline",
    (evidence) =>
      (evidence.rejections.expired_session.after.idle_expires_at =
        evidence.rejections.expired_session.before.idle_expires_at),
  ],
  [
    "a changed absolute expiry",
    (evidence) =>
      (evidence.rejections.expired_session.after.expires_at =
        "2026-10-12T23:00:00Z"),
  ],
  [
    "a changed last-used time",
    (evidence) =>
      (evidence.rejections.expired_session.after.last_used_at =
        "2026-10-12T10:00:01Z"),
  ],
  [
    "a changed issue time",
    (evidence) =>
      (evidence.rejections.expired_session.after.issued_at =
        "2026-10-12T10:00:01Z"),
  ],
  [
    "missing expired database observation",
    (evidence) => {
      evidence.rejections.expired_session.observations =
        evidence.rejections.expired_session.observations.filter(
          (observation) => observation.label !== "expired",
        );
    },
  ],
  [
    "a database observation that is not expired",
    (evidence) =>
      (evidence.rejections.expired_session.observations.find(
        (observation) => observation.label === "expired",
      ).expired = false),
  ],
  [
    "a positive expired database lifetime",
    (evidence) =>
      (evidence.rejections.expired_session.observations.find(
        (observation) => observation.label === "expired",
      ).remaining_ms = 1),
  ],
  [
    "expiry observed only after the denied request",
    (evidence) =>
      (evidence.rejections.expired_session.observations.find(
        (observation) => observation.label === "expired",
      ).at = row(evidence, "stopped-expired-session").started_at + 1),
  ],
  [
    "ordinary database reads changing browser authority",
    (evidence) =>
      (evidence.rejections.expired_session.observations[0].last_used_at =
        "2026-10-12T10:00:01Z"),
  ],
  [
    "a cold Agent equal to the warm Agent",
    (evidence) => {
      evidence.cold_agent.agent_id = evidence.agent_id;
      evidence.cold_agent_setup.agent_id = evidence.agent_id;
      row(evidence, "stopped-cold-agent").path =
        `/api/app/workspace/v1/agents/${evidence.agent_id}/sessions`;
    },
  ],
  [
    "a cold Agent owned by another user",
    (evidence) => (evidence.cold_agent.owner_user_id = "other-owner"),
  ],
  [
    "a cold Agent setup owned by another user",
    (evidence) => (evidence.cold_agent_setup.owner_user_id = "other-owner"),
  ],
  [
    "a cold Agent that is not ready",
    (evidence) => (evidence.cold_agent.runtime_state = "unavailable"),
  ],
  [
    "a cold Agent readied after the stop",
    (evidence) =>
      (evidence.cold_agent_setup.ready_at = evidence.identity.stopped.at + 1),
  ],
])
  test(`business rejection gate rejects ${name}`, () => {
    requireAPI();
    const evidence = fixture();
    mutate(evidence);
    assert.throws(() => inspectOutageRejectionBusiness(evidence));
  });

for (const [name, path] of [
  ["cold session profile", "/api/session/account"],
  [
    "cold Agent",
    "/api/app/workspace/v1/agents/cold-agent/events?sessionId=other",
  ],
  ["encoded cold Agent", "/api/app/workspace/v1/agents/%63old-agent/view"],
])
  for (const location of ["http", "outage", "recovery"])
    test(`warm scope cannot prewarm its ${name} in ${location} history without Trace IDs`, () => {
      requireAPI();
      const evidence = fixture();
      addHistory(evidence, path, location);
      assert.throws(() => inspectOutageRejectionBusiness(evidence));
    });

for (const login of ["cold-console-login", "cold-workspace-login"])
  for (const location of ["outage", "recovery"])
    test(`${login} must remain cold across ${location} SSE history`, () => {
      requireAPI();
      const evidence = fixture();
      addHistory(
        evidence,
        "/api/app/workspace/v1/agents/agent/events",
        location,
        login,
      );
      assert.throws(() => inspectOutageRejectionBusiness(evidence));
    });

for (const [name, path, location, login] of [
  [
    "the warm Cookie's original Agent SSE",
    "/api/app/workspace/v1/agents/agent/events",
    "outage",
    "warm-login",
  ],
  [
    "the warm Cookie's workspace bootstrap",
    "/api/app/workspace/v1/bootstrap",
    "http",
    "warm-login",
  ],
  [
    "another Cookie's cold Agent read",
    "/api/app/workspace/v1/agents/cold-agent/view",
    "http",
    "audit-login",
  ],
])
  test(`business cold-key checks allow ${name} without collecting Traces`, () => {
    requireAPI();
    const evidence = fixture();
    addHistory(evidence, path, location, login);
    const original = structuredClone(evidence);
    assert.deepEqual(inspectOutageRejectionBusiness(evidence), expectedReport);
    assert.deepEqual(evidence, original);
  });

for (const label of ["recovered-expired-session", "recovered-workspace-view"]) {
  test(`business recovery requires the original ${label} response`, () => {
    requireAPI();
    const evidence = fixture();
    evidence.http = evidence.http.filter((request) => request.label !== label);
    assert.throws(() => inspectOutageRejectionBusiness(evidence));
  });
  for (const [name, mutate] of [
    ["wrong status", (request) => (request.status = 503)],
    ["wrong route", (request) => (request.path = "/api/session/account")],
    ["wrong method", (request) => (request.method = "POST")],
    [
      "request before restart",
      (request, evidence) =>
        (request.started_at = evidence.identity.restart_started_at),
    ],
    [
      "response before request",
      (request) => (request.at = request.started_at - 1),
    ],
    [
      "wrong Cookie scope",
      (request, evidence) =>
        (request.credential_scope = row(
          evidence,
          "audit-login",
        ).issued_credential_scope),
    ],
    ["missing no-store", (request) => (request.cache_control = "public")],
    ["new Cookie", (request) => (request.set_cookie_count = 1)],
    [
      "new credential",
      (request, evidence) =>
        (request.issued_credential_scope = row(
          evidence,
          "audit-login",
        ).issued_credential_scope),
    ],
  ])
    test(`${label} rejects ${name} without consulting Trace evidence`, () => {
      requireAPI();
      const evidence = fixture();
      mutate(row(evidence, label), evidence);
      assert.throws(() => inspectOutageRejectionBusiness(evidence));
    });
}

for (const [name, mutate] of [
  [
    "wrong expired-session code",
    (evidence) =>
      (row(evidence, "recovered-expired-session").body.code =
        "identity_unavailable"),
  ],
  [
    "missing expired-session message",
    (evidence) =>
      delete row(evidence, "recovered-expired-session").body.message,
  ],
  [
    "another recovered Agent",
    (evidence) =>
      (row(evidence, "recovered-workspace-view").path =
        "/api/app/workspace/v1/agents/other/sessions/chat/view"),
  ],
  [
    "another recovered Session",
    (evidence) =>
      (row(evidence, "recovered-workspace-view").path =
        "/api/app/workspace/v1/agents/agent/sessions/other/view"),
  ],
])
  test(`business recovery rejects ${name}`, () => {
    requireAPI();
    const evidence = fixture();
    mutate(evidence);
    assert.throws(() => inspectOutageRejectionBusiness(evidence));
  });
