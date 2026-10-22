import assert from "node:assert/strict";
import test from "node:test";

const url = new URL("./logout-business.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});

function inspect(expected) {
  assert.equal(
    typeof implementation.inspectStage3LogoutBusiness,
    "function",
    "inspectStage3LogoutBusiness is required",
  );
  return implementation.inspectStage3LogoutBusiness(expected);
}

// Safe synthetic values with the original logout-observations.json shape.
// These are browser HTTP/observer receipts, with no Span or Trace fixture.
function fixture(version = 1, kind = "transport-end") {
  const base = Date.UTC(2026, 9, 21, 21, 29, 0);
  const agentId = "agent_logout_business_fixture";
  const sessionId = "session_logout_business_fixture";
  const credentialScope = "00000000-0000-4000-8000-000000000001";
  const principal = {
    user_id: "user_logout_fixture",
    organization_id: "org_logout_fixture",
    organization_slug: "logout-fixture",
    organization_name: "Logout fixture",
    membership_id: "membership_logout_fixture",
    system_role: "user",
    organization_role: "member",
    active: true,
  };
  const sdkRequests = [
    { requestId: "0", method: "initialize" },
    { requestId: "1", method: "session/new" },
  ];
  const view = {
    agentId,
    bridgeEpoch: "bridge-logout-fixture",
    availability: "ready",
    promptCapabilities: {},
    activeSessionId: null,
    selectedSessionId: sessionId,
    selectedView: {
      agentId,
      sessionId,
      title: null,
      updatedAt: null,
      bridgeEpoch: "bridge-logout-fixture",
      incarnation: "incarnation-logout-fixture",
      viewRevision: 0,
      appendVersion: 0,
      outputWatermark: 0,
      historyToken: "history-logout-fixture",
      streamCursor: "cursor-logout-fixture",
      historyState: "ready",
      turns: [],
      olderTurnsCursor: null,
      operations: [],
      permissions: [],
    },
    operations: [],
    permissions: [],
    streamCursor: "cursor-logout-fixture",
  };
  const reset = {
    type: "reset",
    agentId,
    bridgeEpoch: view.bridgeEpoch,
    projectionId: "projection-logout-fixture",
    fromStreamRevision: 0,
    toStreamRevision: 0,
    cursor: view.streamCursor,
    view,
  };
  const checkpoint = {
    at: 1000,
    observed_at_ms: base + 1000,
    agentId,
    sessionId,
    reason: "revoked",
    expiresAt: base + 43_200_000,
    idleExpiresAt: base + 43_200_000,
    stream: {
      started_at: 800,
      started_at_ms: base + 800,
      frames: [
        {
          at: 900,
          raw: `id: ${view.streamCursor}\ndata: ${JSON.stringify(reset)}\n\n`,
        },
      ],
      events: [{ at: 901, raw: reset, action: "view" }],
      path: `/api/app/workspace/v1/agents/${agentId}/events?sessionId=${sessionId}`,
      credential_scope: credentialScope,
      status: 200,
      headers_at: 850,
      server_date: new Date(base).toUTCString(),
      set_cookie_count: 0,
    },
    browserRequests: 0,
    sdkRequests: structuredClone(sdkRequests),
    issuance: { startedMono: 500, completedMono: 550 },
  };
  return {
    transport: "http-sse",
    agentId,
    sessionId,
    credentialScope,
    reason: "revoked",
    startedAt: checkpoint.observed_at_ms,
    closedAt: base + 1040,
    checkpoint,
    closure: { kind, at: 1040, observed_at_ms: base + 1040 },
    sdkRequests: structuredClone(sdkRequests),
    silent: true,
    localClose: false,
    // This historical field describes the auxiliary Trace cause inspection.
    // Original business receipts do not acquire that claim by being valid.
    authorizationCauseVerified: false,
    protocolVersion: version,
    principal,
    cause: {
      kind: "logout",
      path: "/api/session",
      method: "DELETE",
      status: 204,
      credentialScope,
      principal: structuredClone(principal),
      startedAt: base + 1010,
      completedAt: base + 1020,
      startedMono: 1010,
      completedMono: 1020,
      serverDate: new Date(base + 1010).toUTCString(),
    },
    denial: {
      path: `/api/app/workspace/v1/agents/${agentId}/sessions/${sessionId}/prompts`,
      method: "POST",
      status: 401,
      code: "unauthenticated",
      credentialScope,
      startedAt: base + 1050,
      completedAt: base + 1060,
      startedMono: 1050,
      completedMono: 1060,
      serverDate: new Date(base + 1050).toUTCString(),
      setCookieCount: 0,
      noStore: true,
      intentId: "00000000-0000-4000-8000-000000000002",
    },
    protocolClientClosedLocally: true,
  };
}

function rejectMutations(cases) {
  assert.doesNotThrow(() => inspect(fixture()));
  for (const [label, mutate] of cases) {
    const expected = fixture();
    mutate(expected);
    assert.throws(() => inspect(expected), label);
  }
}

for (const [version, kind] of [
  [1, "transport-end"],
  [2, "remote-end"],
])
  test(`v${version} original Logout HTTP and ${kind} pass without Trace and remain unchanged`, () => {
    const expected = fixture(version, kind);
    const before = structuredClone(expected);
    assert.doesNotThrow(() => inspect(expected));
    assert.deepEqual(expected, before);
    assert.equal(expected.authorizationCauseVerified, false);
  });

test("the original 30-second remote-close bound includes its exact endpoint", () => {
  const expected = fixture();
  const delta = expected.checkpoint.at + 30_000 - expected.closure.at;
  expected.closure.at += delta;
  expected.closure.observed_at_ms += delta;
  expected.closedAt += delta;
  for (const receipt of [expected.denial]) {
    receipt.startedMono += delta;
    receipt.completedMono += delta;
    receipt.startedAt += delta;
    receipt.completedAt += delta;
    receipt.serverDate = new Date(receipt.startedAt).toUTCString();
  }
  const before = structuredClone(expected);
  assert.doesNotThrow(() => inspect(expected));
  assert.deepEqual(expected, before);
});

test("missing original observer, HTTP, Principal or SDK receipts are rejected", () => {
  assert.doesNotThrow(() => inspect(fixture()));
  for (const value of [undefined, null, {}, []])
    assert.throws(() => inspect(value));
  rejectMutations([
    ...[
      "checkpoint",
      "closure",
      "cause",
      "denial",
      "principal",
      "sdkRequests",
    ].map((key) => [
      key,
      (expected) => {
        delete expected[key];
      },
    ]),
    [
      "stream",
      (expected) => {
        delete expected.checkpoint.stream;
      },
    ],
    [
      "issuance",
      (expected) => {
        delete expected.checkpoint.issuance;
      },
    ],
    [
      "original SDK inventory",
      (expected) => {
        delete expected.checkpoint.sdkRequests;
      },
    ],
    [
      "empty original SDK inventory",
      (expected) => {
        expected.sdkRequests = [];
        expected.checkpoint.sdkRequests = [];
      },
    ],
  ]);
});

test("Agent, Session and original Cookie scope cannot be borrowed across receipts", () => {
  rejectMutations([
    [
      "foreign Agent",
      (expected) => {
        expected.agentId = "agent_foreign";
      },
    ],
    [
      "foreign Session",
      (expected) => {
        expected.sessionId = "session_foreign";
      },
    ],
    [
      "foreign checkpoint Agent",
      (expected) => {
        expected.checkpoint.agentId = "agent_foreign";
      },
    ],
    [
      "foreign checkpoint Session",
      (expected) => {
        expected.checkpoint.sessionId = "session_foreign";
      },
    ],
    [
      "foreign stream path",
      (expected) => {
        expected.checkpoint.stream.path =
          "/api/app/workspace/v1/agents/agent_foreign/events?sessionId=session_foreign";
      },
    ],
    [
      "foreign observed Agent",
      (expected) => {
        expected.checkpoint.stream.events[0].raw.view.agentId = "agent_foreign";
      },
    ],
    [
      "foreign observed selected Session",
      (expected) => {
        expected.checkpoint.stream.events[0].raw.view.selectedSessionId =
          "session_foreign";
      },
    ],
    [
      "foreign observed Session body",
      (expected) => {
        expected.checkpoint.stream.events[0].raw.view.selectedView.sessionId =
          "session_foreign";
      },
    ],
    [
      "foreign top-level Cookie scope",
      (expected) => {
        expected.credentialScope = "foreign-cookie-scope";
      },
    ],
    [
      "foreign stream Cookie scope",
      (expected) => {
        expected.checkpoint.stream.credential_scope = "foreign-cookie-scope";
      },
    ],
    [
      "foreign Logout Cookie scope",
      (expected) => {
        expected.cause.credentialScope = "foreign-cookie-scope";
      },
    ],
    [
      "foreign denial Cookie scope",
      (expected) => {
        expected.denial.credentialScope = "foreign-cookie-scope";
      },
    ],
    [
      "empty Cookie scope",
      (expected) => {
        expected.credentialScope = "";
        expected.checkpoint.stream.credential_scope = "";
        expected.cause.credentialScope = "";
        expected.denial.credentialScope = "";
      },
    ],
  ]);
});

test("Logout must use the original same-organization Principal", () => {
  rejectMutations([
    [
      "foreign user",
      (expected) => {
        expected.cause.principal.user_id = "user_foreign";
      },
    ],
    [
      "foreign organization",
      (expected) => {
        expected.cause.principal.organization_id = "org_foreign";
      },
    ],
    [
      "foreign membership",
      (expected) => {
        expected.cause.principal.membership_id = "membership_foreign";
      },
    ],
    [
      "missing original user",
      (expected) => {
        delete expected.principal.user_id;
      },
    ],
    [
      "missing original organization",
      (expected) => {
        delete expected.principal.organization_id;
      },
    ],
    [
      "missing Logout Principal",
      (expected) => {
        delete expected.cause.principal;
      },
    ],
  ]);
});

test("Logout requires its real DELETE api/session 204 response", () => {
  rejectMutations([
    [
      "failed original SSE",
      (expected) => {
        expected.checkpoint.stream.status = 401;
      },
    ],
    [
      "original SSE changed Cookie",
      (expected) => {
        expected.checkpoint.stream.set_cookie_count = 1;
      },
    ],
    [
      "wrong mutation",
      (expected) => {
        expected.cause.kind = "password";
      },
    ],
    [
      "wrong method",
      (expected) => {
        expected.cause.method = "POST";
      },
    ],
    [
      "wrong route",
      (expected) => {
        expected.cause.path = "/api/session/other";
      },
    ],
    [
      "HTTP 200",
      (expected) => {
        expected.cause.status = 200;
      },
    ],
    [
      "HTTP 401",
      (expected) => {
        expected.cause.status = 401;
      },
    ],
    [
      "missing status",
      (expected) => {
        delete expected.cause.status;
      },
    ],
  ]);
});

test("post-close denial requires same-scope Prompt 401, no-store and no Set-Cookie", () => {
  rejectMutations([
    [
      "wrong method",
      (expected) => {
        expected.denial.method = "GET";
      },
    ],
    [
      "foreign denial path",
      (expected) => {
        expected.denial.path =
          "/api/app/workspace/v1/agents/agent_foreign/sessions/session_foreign/prompts";
      },
    ],
    [
      "HTTP 200",
      (expected) => {
        expected.denial.status = 200;
      },
    ],
    [
      "HTTP 403",
      (expected) => {
        expected.denial.status = 403;
      },
    ],
    [
      "HTTP 503",
      (expected) => {
        expected.denial.status = 503;
      },
    ],
    [
      "wrong refusal",
      (expected) => {
        expected.denial.code = "access_denied";
      },
    ],
    [
      "cacheable refusal",
      (expected) => {
        expected.denial.noStore = false;
      },
    ],
    [
      "rotated Cookie",
      (expected) => {
        expected.denial.setCookieCount = 1;
      },
    ],
    [
      "missing Cookie count",
      (expected) => {
        delete expected.denial.setCookieCount;
      },
    ],
    [
      "missing intent",
      (expected) => {
        delete expected.denial.intentId;
      },
    ],
    [
      "invalid intent",
      (expected) => {
        expected.denial.intentId = "not-a-uuid";
      },
    ],
  ]);
});

test("local cancellation and unfinished protocol cleanup cannot prove remote Logout closure", () => {
  rejectMutations([
    [
      "wrong transport",
      (expected) => {
        expected.transport = "websocket";
      },
    ],
    [
      "wrong reason",
      (expected) => {
        expected.reason = "expired";
      },
    ],
    [
      "wrong checkpoint reason",
      (expected) => {
        expected.checkpoint.reason = "expired";
      },
    ],
    [
      "active probe",
      (expected) => {
        expected.silent = false;
      },
    ],
    [
      "local close",
      (expected) => {
        expected.localClose = true;
      },
    ],
    [
      "local abort",
      (expected) => {
        expected.closure.kind = "local-abort";
      },
    ],
    [
      "transport failure",
      (expected) => {
        expected.closure.kind = "error";
      },
    ],
    [
      "missing remote cause",
      (expected) => {
        delete expected.closure.kind;
      },
    ],
    [
      "protocol client not joined",
      (expected) => {
        expected.protocolClientClosedLocally = false;
      },
    ],
  ]);
});

test("silent observation cannot add execution or change existing SDK requests", () => {
  rejectMutations([
    [
      "new Prompt",
      (expected) => {
        expected.sdkRequests.push({
          requestId: "2",
          method: "session/prompt",
          sessionId: expected.sessionId,
        });
      },
    ],
    [
      "new list request",
      (expected) => {
        expected.sdkRequests.push({ requestId: "2", method: "session/list" });
      },
    ],
    [
      "same count but changed request",
      (expected) => {
        expected.sdkRequests[1].method = "session/prompt";
      },
    ],
    [
      "same method but changed ID",
      (expected) => {
        expected.sdkRequests[1].requestId = "replacement";
      },
    ],
    [
      "lost request",
      (expected) => {
        expected.sdkRequests.pop();
      },
    ],
  ]);
});

test("checkpoint, Logout, remote EOF and denial retain their original order", () => {
  rejectMutations([
    [
      "stream headers after checkpoint",
      (expected) => {
        expected.checkpoint.stream.headers_at = expected.checkpoint.at + 1;
      },
    ],
    [
      "issuance after stream dispatch",
      (expected) => {
        expected.checkpoint.issuance.completedMono =
          expected.checkpoint.stream.started_at + 1;
      },
    ],
    [
      "Logout before checkpoint",
      (expected) => {
        expected.cause.startedMono = expected.checkpoint.at - 1;
      },
    ],
    [
      "Logout after EOF",
      (expected) => {
        expected.cause.startedMono = expected.closure.at + 1;
        expected.cause.completedMono = expected.closure.at + 2;
        expected.cause.startedAt = expected.closedAt + 1;
        expected.cause.completedAt = expected.closedAt + 2;
      },
    ],
    [
      "EOF before checkpoint",
      (expected) => {
        expected.closure.at = expected.checkpoint.at - 1;
      },
    ],
    [
      "denial before EOF",
      (expected) => {
        expected.denial.startedMono = expected.closure.at - 1;
        expected.denial.startedAt = expected.closedAt - 1;
      },
    ],
    [
      "denial before Logout response",
      (expected) => {
        expected.cause.completedMono = expected.denial.startedMono + 1;
      },
    ],
    [
      "reversed Logout wall interval",
      (expected) => {
        expected.cause.completedAt = expected.cause.startedAt - 1;
      },
    ],
    [
      "reversed denial monotonic interval",
      (expected) => {
        expected.denial.completedMono = expected.denial.startedMono - 1;
      },
    ],
  ]);
});

test("both monotonic and observed wall clocks enforce the original 30-second close bound", () => {
  rejectMutations([
    [
      "monotonic timeout",
      (expected) => {
        const delta = expected.checkpoint.at + 30_001 - expected.closure.at;
        expected.closure.at += delta;
        expected.denial.startedMono += delta;
        expected.denial.completedMono += delta;
      },
    ],
    [
      "wall-clock timeout",
      (expected) => {
        const delta =
          expected.checkpoint.observed_at_ms +
          30_001 -
          expected.closure.observed_at_ms;
        expected.closure.observed_at_ms += delta;
        expected.closedAt = expected.closure.observed_at_ms;
        expected.denial.startedAt += delta;
        expected.denial.completedAt += delta;
        expected.denial.serverDate = new Date(
          expected.denial.startedAt,
        ).toUTCString();
      },
    ],
    [
      "different original start",
      (expected) => {
        expected.startedAt += 1;
      },
    ],
    [
      "different original close",
      (expected) => {
        expected.closedAt += 1;
      },
    ],
  ]);
});

test("missing or nonfinite HTTP and observer timestamps cannot be accepted", () => {
  rejectMutations([
    [
      "missing checkpoint clock",
      (expected) => {
        delete expected.checkpoint.observed_at_ms;
      },
    ],
    [
      "nonfinite closure clock",
      (expected) => {
        expected.closure.at = Infinity;
      },
    ],
    [
      "nonfinite Logout clock",
      (expected) => {
        expected.cause.startedMono = NaN;
      },
    ],
    [
      "missing denial clock",
      (expected) => {
        delete expected.denial.completedAt;
      },
    ],
    [
      "missing Logout HTTP Date",
      (expected) => {
        delete expected.cause.serverDate;
      },
    ],
    [
      "invalid denial HTTP Date",
      (expected) => {
        expected.denial.serverDate = "not-an-http-date";
      },
    ],
    [
      "invalid stream HTTP Date",
      (expected) => {
        expected.checkpoint.stream.server_date = "not-an-http-date";
      },
    ],
  ]);
});
