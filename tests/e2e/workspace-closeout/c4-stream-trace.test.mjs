import assert from "node:assert/strict";
import test from "node:test";
import {
  bridgeSessionTraceFixture,
  sessionTraceBase,
} from "../identity-closeout/bridge-session-trace-fixtures.mjs";
import { setTag } from "../observability/gateway-resolution-fixtures.mjs";

const moduleURL = new URL("./c4-stream-trace.mjs", import.meta.url);
const { inspectC4StreamBoundary } = await import(moduleURL).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(moduleURL.pathname)
  )
    throw error;
  return {};
});

function fixture() {
  const f = bridgeSessionTraceFixture(),
    expected = f.expected,
    point = expected.checkpoint;
  const issued = {
    principal: {
      user_id: "user-1",
      organization_id: "org-1",
      membership_id: "member-1",
      organization_slug: "stage3",
      organization_name: "Stage 3",
      system_role: "user",
      organization_role: "member",
      active: true,
    },
    expires_at: new Date(point.expiresAt).toISOString(),
    idle_expires_at: new Date(point.idleExpiresAt).toISOString(),
    activity_interval_ms: 30000,
  };
  expected.login = {
    issued,
    receipt: {
      method: "POST",
      path: "/api/session/login",
      status: 200,
      traceID: "d".repeat(32),
      serverDate: new Date(sessionTraceBase - 1000).toUTCString(),
      rawBody: JSON.stringify(issued),
      startedMono: 200,
      completedMono: 900,
      startedAt: sessionTraceBase - 800,
      completedAt: sessionTraceBase - 100,
    },
  };
  expected.principal = structuredClone(issued.principal);
  expected.gateway = "http://127.0.0.1:8123";
  expected.pageOwned = true;
  expected.closure.kind = "remote-end";
  point.stream.origin = expected.gateway;
  point.stream.path += "&cursor=actual-page-cursor";
  point.stream.content_type = "text/event-stream; charset=utf-8";
  point.stream.started_at_ms = sessionTraceBase;
  point.stream.headers_at_ms = sessionTraceBase + 200;
  for (const key of [
    "sdkRequests",
    "silent",
    "protocolVersion",
    "protocolClientClosedLocally",
  ])
    delete expected[key];
  for (const key of [
    "sdkRequests",
    "browserRequests",
    "expiresAt",
    "idleExpiresAt",
  ])
    delete point[key];
  return f;
}
const inspect = (f) => {
  assert.equal(typeof inspectC4StreamBoundary, "function");
  return inspectC4StreamBoundary(
    f.trace,
    f.expected,
    ["C4-PRIVATE-TRACE-CANARY"],
    f.collection,
  );
};

test("C4 page boundary uses its actual cursor and original login lifetime without SDK fields", () => {
  const f = fixture(),
    raw = JSON.stringify([f.trace, f.expected]);
  const result = inspect(f);
  assert.equal(result.root, f.root);
  assert.equal(result.upstream, f.upstream);
  assert.equal(result.ui, f.ui);
  assert.equal(result.initialResolution.profile, "workspace");
  assert.equal(result.authorizationCauseVerified, false);
  assert.equal(JSON.stringify([f.trace, f.expected]), raw);
});

for (const [name, change] of [
  [
    "host-created stream",
    (f) => {
      f.expected.pageOwned = false;
    },
  ],
  [
    "invented SDK version",
    (f) => {
      f.expected.protocolVersion = 1;
    },
  ],
  [
    "invented SDK requests",
    (f) => {
      f.expected.checkpoint.sdkRequests = [];
    },
  ],
  [
    "wrong Gateway origin",
    (f) => {
      f.expected.gateway = "http://127.0.0.1:9000";
    },
  ],
  [
    "foreign trace",
    (f) => {
      f.expected.traceID = "f".repeat(32);
    },
  ],
  [
    "changed credential scope",
    (f) => {
      f.expected.credentialScope = "00000000-0000-4000-8000-000000000002";
    },
  ],
  [
    "foreign Session URL",
    (f) => {
      f.expected.checkpoint.stream.path =
        f.expected.checkpoint.stream.path.replace("session-1", "other");
    },
  ],
  [
    "duplicate Session query",
    (f) => {
      f.expected.checkpoint.stream.path += "&sessionId=session-1";
    },
  ],
  [
    "redirect-style stream path",
    (f) => {
      f.expected.checkpoint.stream.path =
        "https://other.invalid" + f.expected.checkpoint.stream.path;
    },
  ],
  [
    "local closure",
    (f) => {
      f.expected.closure.kind = "local-page-close";
    },
  ],
  [
    "pre-trigger EOF",
    (f) => {
      f.expected.closure.at = f.expected.checkpoint.at - 1;
    },
  ],
  [
    "late EOF",
    (f) => {
      f.expected.closure.at = f.expected.checkpoint.at + 30001;
    },
  ],
  [
    "rotated SSE authority",
    (f) => {
      f.expected.checkpoint.stream.set_cookie_count = 1;
    },
  ],
  ["missing archive", (f) => f.collection.archivedTraceIDs.clear()],
  [
    "different original login body",
    (f) => {
      f.expected.login.issued.principal.user_id = "other";
    },
  ],
  [
    "different login Principal",
    (f) => {
      f.expected.principal.user_id = "other";
    },
  ],
  [
    "login after stream dispatch",
    (f) => {
      f.expected.login.receipt.completedMono = 1100;
    },
  ],
  [
    "missing login window",
    (f) => {
      delete f.expected.login.receipt.startedAt;
    },
  ],
  [
    "CCT beyond original login expiry",
    (f) => {
      f.expected.login.issued.expires_at = new Date(
        sessionTraceBase + 30000,
      ).toISOString();
      f.expected.login.issued.idle_expires_at =
        f.expected.login.issued.expires_at;
      f.expected.login.receipt.rawBody = JSON.stringify(
        f.expected.login.issued,
      );
    },
  ],
  [
    "foreign Gateway route",
    (f) => setTag(f.root, "http.route", "/api/app/agents/{agent_id}/v1/acp"),
  ],
  [
    "missing UI receiver",
    (f) => {
      f.trace.spans = f.trace.spans.filter((span) => span !== f.ui);
    },
  ],
  [
    "natural CCT expiry",
    (f) => setTag(f.ui, "antnest.ui.stream.delegation_remaining_ms", 1000),
  ],
])
  test(`C4 page boundary rejects ${name}`, () => {
    assert.equal(typeof inspectC4StreamBoundary, "function");
    const f = fixture();
    change(f);
    assert.throws(() => inspect(f));
  });
