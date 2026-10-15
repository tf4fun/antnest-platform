import assert from "node:assert/strict";
import test from "node:test";
import {
  bridgeSessionTraceFixture,
  sessionTraceBase,
} from "./bridge-session-trace-fixtures.mjs";
import { setTag } from "../observability/gateway-resolution-fixtures.mjs";

const url = new URL("./bridge-session-trace.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
const inspect = (f) =>
  implementation.inspectBridgeSessionBoundary(
    f.trace,
    f.expected,
    ["PRIVATE-SESSION-TRACE-CANARY"],
    f.collection,
  );
const ready = () =>
  assert.equal(typeof implementation.inspectBridgeSessionBoundary, "function");
const expiryKey = "antnest.ui.stream.delegation_expires_at_unix_ms";
const remainingKey = "antnest.ui.stream.delegation_remaining_ms";

test("Gateway has its own clock, independent of the upstream Agent UI Date", () => {
  ready();
  const f = bridgeSessionTraceFixture();
  for (const span of f.trace.spans)
    if (f.trace.processes[span.processID].serviceName === "edge-gateway")
      span.startTime += 5000000;
  assert.equal(inspect(f).authorizationCauseVerified, false);
});

test("original CCT remaining budget preserves the UI verifier's permitted clock skew", () => {
  ready();
  const f = bridgeSessionTraceFixture();
  f.ui.startTime -= 5000000;
  f.expected.checkpoint.stream.server_date = new Date(
    sessionTraceBase - 5000,
  ).toUTCString();
  setTag(f.ui, remainingKey, 64920);
  assert.equal(inspect(f).authorizationCauseVerified, false);
});

test("absolute expiry admits the Gateway hard cap before the original UI CCT timer", () => {
  ready();
  const f = bridgeSessionTraceFixture("expired");
  f.expected.closedAt = sessionTraceBase + 4805;
  f.expected.closure.observed_at_ms = f.expected.closedAt;
  f.expected.closure.at = 5805;
  f.root.duration = 4750000;
  f.upstream.duration = 4720000;
  f.ui.duration = 4710000;
  assert.equal(inspect(f).authorizationCauseVerified, false);
});

test("absolute expiry uses original server deadlines independently of the client's wall clock", () => {
  ready();
  const f = bridgeSessionTraceFixture("expired");
  f.expected.checkpoint.observed_at_ms += 300000;
  f.expected.startedAt += 300000;
  f.expected.closure.observed_at_ms += 300000;
  f.expected.closedAt += 300000;
  assert.equal(inspect(f).authorizationCauseVerified, false);
});

for (const reason of ["revoked", "unavailable", "expired"])
  test(`original Bridge ${reason} boundary binds actual SSE and frozen delegation without claiming the cause`, () => {
    ready();
    const f = bridgeSessionTraceFixture(reason);
    const raw = JSON.stringify(f.trace);
    const result = inspect(f);
    assert.equal(result.root, f.root);
    assert.equal(result.upstream, f.upstream);
    assert.equal(result.ui, f.ui);
    assert.equal(result.initialResolution.profile, "workspace");
    assert.equal(
      result.delegation.expires_at_unix_ms,
      sessionTraceBase + (reason === "expired" ? 5000 : 60000),
    );
    assert.equal(result.authorizationCauseVerified, false);
    assert.equal(JSON.stringify(f.trace), raw);
  });

for (const [name, change] of [
  ["a different original Trace", (f) => (f.expected.traceID = "f".repeat(32))],
  [
    "a different closed Trace",
    (f) => (f.expected.closure.trace_id = "f".repeat(32)),
  ],
  [
    "a different original credential",
    (f) =>
      (f.expected.credentialScope = "00000000-0000-4000-8000-000000000002"),
  ],
  ["a different Session", (f) => (f.expected.sessionId = "another")],
  [
    "a different Agent in the actual URL",
    (f) =>
      (f.expected.checkpoint.stream.path =
        f.expected.checkpoint.stream.path.replace("agent-1", "another")),
  ],
  ["local closure", (f) => (f.expected.closure.kind = "local-close")],
  [
    "pre-trigger closure",
    (f) => (f.expected.closure.at = f.expected.checkpoint.at - 1),
  ],
  [
    "closure beyond thirty seconds",
    (f) => (f.expected.closure.at = f.expected.checkpoint.at + 30001),
  ],
  [
    "changed SDK request inventory",
    (f) =>
      f.expected.sdkRequests.push({ requestId: "2", method: "session/prompt" }),
  ],
  ["missing raw archive", (f) => f.collection.archivedTraceIDs.clear()],
  [
    "the retired WebSocket route",
    (f) => setTag(f.root, "http.route", "/api/app/agents/{agent_id}/v1/acp"),
  ],
  [
    "a fabricated upgrade",
    (f) => setTag(f.root, "http.response.status_code", 101),
  ],
  ["a detached UI", (f) => (f.ui.references = [])],
  [
    "UI under a different parent",
    (f) => (f.ui.references[0].spanID = f.root.spanID),
  ],
  [
    "another Gateway process",
    (f) => {
      f.trace.processes.another = { serviceName: "edge-gateway" };
      f.upstream.processID = "another";
    },
  ],
  ["forwarding after the Gateway ended", (f) => (f.root.duration = 20000)],
  [
    "missing actual HTTP Date",
    (f) => delete f.expected.checkpoint.stream.server_date,
  ],
  [
    "root outside observed request window",
    (f) => (f.root.startTime -= 10000000),
  ],
  ["missing original delegation", (f) => setTag(f.ui, expiryKey, undefined)],
  [
    "delegation on the wrong span",
    (f) => {
      setTag(f.root, expiryKey, sessionTraceBase + 60000);
      setTag(f.ui, expiryKey, undefined);
    },
  ],
  [
    "duplicate original delegation",
    (f) => f.ui.tags.push({ key: remainingKey, value: 120000 }),
  ],
  [
    "expiry contradicting its original remaining budget",
    (f) => setTag(f.ui, expiryKey, sessionTraceBase + 1000),
  ],
  [
    "delegation sample after initial headers",
    (f) => setTag(f.ui, remainingKey, 50000),
  ],
  ["unbounded original delegation", (f) => setTag(f.ui, remainingKey, 90001)],
  ["already expired original delegation", (f) => setTag(f.ui, remainingKey, 0)],
  [
    "logout at the original delegation deadline",
    (f) =>
      setTag(
        f.ui,
        remainingKey,
        f.expected.closure.at - f.expected.checkpoint.stream.started_at,
      ),
  ],
  [
    "natural Session expiry used as logout",
    (f) => (f.expected.checkpoint.expiresAt = f.expected.closedAt + 500),
  ],
  [
    "missing initial workspace admission",
    (f) => (f.trace.spans = f.trace.spans.filter((s) => s !== f.decision)),
  ],
  [
    "wrong initial Resolve profile",
    (f) => setTag(f.decision, "antnest.identity.resolve.profile", "acp"),
  ],
  ["unfinished UI span", (f) => delete f.ui.duration],
  [
    "private captured data",
    (f) => setTag(f.ui, "unclassified", "PRIVATE-SESSION-TRACE-CANARY"),
  ],
])
  test(`original Bridge boundary rejects ${name}`, () => {
    ready();
    const f = bridgeSessionTraceFixture();
    change(f);
    assert.throws(() => inspect(f));
  });

for (const [name, change] of [
  [
    "a later request's delegation",
    (f) => setTag(f.ui, expiryKey, sessionTraceBase + 6000),
  ],
  [
    "an earlier idle expiry",
    (f) =>
      (f.expected.checkpoint.idleExpiresAt =
        f.expected.checkpoint.expiresAt - 2000),
  ],
  [
    "closure before both original expiry timers",
    (f) => {
      f.expected.closedAt = sessionTraceBase + 4705;
      f.expected.closure.observed_at_ms = f.expected.closedAt;
      f.expected.closure.at = 5705;
      f.root.duration = 4650000;
      f.upstream.duration = 4620000;
      f.ui.duration = 4610000;
    },
  ],
])
  test(`absolute expiry rejects ${name}`, () => {
    ready();
    const f = bridgeSessionTraceFixture("expired");
    change(f);
    assert.throws(() => inspect(f));
  });
