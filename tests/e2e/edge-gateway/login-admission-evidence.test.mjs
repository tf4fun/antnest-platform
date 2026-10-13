import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { readFileSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { durablePath } from "../../support/storage.mjs";
import { archiveAdmissionSnapshot } from "./login-admission-flow.mjs";
import {
  assertAdmissionReceipts,
  inspectAdmissionTrace,
  admissionPrincipal,
  assertAdmissionArchive,
  attemptAdmissionArchive,
  admissionFailure,
} from "./login-admission-evidence.mjs";

test("failed diagnostic storage preserves the original business failure", async () => {
  const original = new Error("business failure");
  const failures = [];
  for (const label of ["business-failure", "progress"])
    await attemptAdmissionArchive(failures, label, () => {
      throw new Error("storage full");
    });
  assert.deepEqual(failures, ["business-failure", "progress"]);
  assert.equal(admissionFailure(original, failures), original);
  assert.match(
    admissionFailure(undefined, failures).message,
    /archive incomplete/,
  );
  assert.equal(admissionFailure(undefined, []), undefined);
});
import {
  resolutionFixture,
  setTag,
} from "../observability/gateway-resolution-fixtures.mjs";

function fixture() {
  const clients = { a: "192.0.2.10", b: "192.0.2.11" };
  const sequence = [
    ["a", "exhaust", "/api/session/oidc/start", 200],
    ["a", "exhaust", "/api/session/oidc/start", 200],
    ["a", "exhaust", "/api/session/oidc/start", 429],
    ["b", "login", "/api/session/oidc/start", 200],
    ["b", "login", "/protocol/oidc/callback", 303],
    ["b", "login", "/api/session", 200],
    ["a", "refused", "/api/session/oidc/start", 429],
  ];
  const receipts = sequence.map(([client, action, path, status], index) => ({
    client,
    action,
    path,
    status,
    method: path.endsWith("/start") ? "POST" : "GET",
    trace_id: (index + 1).toString(16).padStart(32, "0"),
    no_store: true,
    body_complete: true,
    set_cookie_count: status === 429 || path === "/api/session" ? 0 : 1,
    retry_after: status === 429 ? 600 : null,
    cookies_unchanged: status === 429,
  }));
  const gatewayLogs = receipts.map((r) => ({
    msg: "Edge Gateway request completed",
    trace_id: r.trace_id,
    method: r.method,
    route: r.path,
    status_code: r.status,
    client_address: clients[r.client],
    handler_completed: true,
  }));
  const identityLogs = receipts
    .filter((r) => r.status !== 429)
    .map((r) => ({
      msg: "Identity HTTP request completed",
      trace_id: r.trace_id,
      method: r.path.endsWith("/callback") ? "GET" : "POST",
      route: r.path.endsWith("/start")
        ? "/rpc/identity/start-oidc-login"
        : r.path.endsWith("/callback")
          ? r.path
          : "/rpc/identity/resolve-access-token",
      status_code: 200,
      result: "success",
    }));
  return {
    clients,
    receipts,
    gatewayLogs,
    identityLogs,
    sourceLimit: 2,
    windowMs: 600000,
    elapsedMs: 450,
  };
}

test("admission inventory binds each response to its actual client and exact owning RPC", () => {
  const report = assertAdmissionReceipts(fixture());
  assert.equal(report.start_rpc_count, 3);
  assert.equal(report.refused_upstream_count, 0);
  assert.equal(report.gateway_request_count, 7);
});

for (const defect of [
  "same-source",
  "wrong-source",
  "expired-window",
  "missing-start",
  "refusal-rpc",
  "duplicate-completion",
  "wrong-rpc",
  "unrelated-rpc",
  "missing-trace",
  "omitted-final-refusal",
  "cookie-on-refusal",
]) {
  test(`rejects ${defect} instead of mistaking it for two-source isolation`, () => {
    const value = fixture();
    if (defect === "same-source") value.clients.b = value.clients.a;
    if (defect === "wrong-source")
      value.gatewayLogs[3].client_address = value.clients.a;
    if (defect === "expired-window") value.elapsedMs = value.windowMs;
    if (defect === "missing-start") value.identityLogs.shift();
    if (defect === "refusal-rpc")
      value.identityLogs.push({
        ...value.identityLogs[0],
        trace_id: value.receipts[2].trace_id,
      });
    if (defect === "duplicate-completion")
      value.gatewayLogs.push(value.gatewayLogs[0]);
    if (defect === "wrong-rpc")
      value.identityLogs[0].route = "/rpc/identity/local-login";
    if (defect === "unrelated-rpc")
      value.identityLogs[0].trace_id = "f".repeat(32);
    if (defect === "missing-trace") value.receipts[0].trace_id = null;
    if (defect === "omitted-final-refusal") value.receipts.pop();
    if (defect === "cookie-on-refusal") value.receipts[2].set_cookie_count = 1;
    assert.throws(() => assertAdmissionReceipts(value));
  });
}

function refusalTrace() {
  const traceID = "1".repeat(32),
    spanID = "2".repeat(16);
  return {
    traceID,
    processes: { gateway: { serviceName: "edge-gateway" } },
    spans: [
      {
        traceID,
        spanID,
        processID: "gateway",
        operationName: "HTTP POST /api/session/oidc/start",
        startTime: 1000,
        duration: 50,
        references: [],
        tags: Object.entries({
          "span.kind": "server",
          "http.request.method": "POST",
          "http.route": "/api/session/oidc/start",
          "http.response.status_code": 429,
          "client.address": "192.0.2.10",
        }).map(([key, value]) => ({ key, value })),
      },
    ],
  };
}
const refusal = {
  traceID: "1".repeat(32),
  path: "/api/session/oidc/start",
  method: "POST",
  status: 429,
  address: "192.0.2.10",
};
test("expected member Organization comes from the authenticated session's scope", () => {
  const created = {
    user: { id: "member", system_role: "user", active: true },
    membership: {
      id: "membership",
      user_id: "member",
      role: "member",
      active: true,
    },
  };
  const session = {
    principal: {
      organization_id: "org",
      organization_slug: "stage3",
      organization_name: "Lifecycle test",
    },
  };
  assert.deepEqual(admissionPrincipal(created, session), {
    user_id: "member",
    membership_id: "membership",
    organization_id: "org",
    organization_slug: "stage3",
    organization_name: "Lifecycle test",
    system_role: "user",
    organization_role: "member",
    active: true,
  });
  delete session.principal.organization_id;
  assert.throws(() => admissionPrincipal(created, session));
});

test("a 200 diagnostic response must contain the requested, capture-free, closed Trace", () => {
  const trace = refusalTrace();
  const valid = { data: [trace], errors: null };
  assertAdmissionArchive(valid, trace.traceID, []);
  for (const body of [
    { data: [], errors: null },
    { data: [trace], errors: ["backend error"] },
    { data: [trace, trace], errors: [] },
    { data: [{ ...trace, traceID: "f".repeat(32) }] },
  ])
    assert.throws(() => assertAdmissionArchive(body, trace.traceID, []));
  const secret = structuredClone(valid);
  secret.data[0].spans[0].tags.push({
    key: "unexpected",
    value: "secret-canary",
  });
  assert.throws(() =>
    assertAdmissionArchive(secret, trace.traceID, ["secret-canary"]),
  );
  const detached = structuredClone(valid);
  detached.data[0].spans[0].references = [
    { refType: "CHILD_OF", traceID: trace.traceID, spanID: "f".repeat(16) },
  ];
  assert.throws(() => assertAdmissionArchive(detached, trace.traceID, []));
});

test("final diagnostic snapshots create a private child directory and preserve rejected raw responses", (t) => {
  const directory = durablePath(
    `artifacts/verification/login-admission-archive/${randomUUID()}`,
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const trace = refusalTrace();
  const text = JSON.stringify({ data: [trace], errors: [] });
  archiveAdmissionSnapshot(directory, trace.traceID, 200, text, []);
  const file = join(directory, "final-traces", `${trace.traceID}.private.json`);
  assert.equal(readFileSync(file, "utf8"), text);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(join(directory, "final-traces")).mode & 0o777, 0o700);
  const failed = JSON.stringify({ data: [], errors: ["backend failure"] });
  assert.throws(() =>
    archiveAdmissionSnapshot(directory, trace.traceID, 200, failed, []),
  );
  assert.equal(readFileSync(file, "utf8"), failed);
});
test("429 raw trace must prove zero upstream spans, even without an Identity SERVER export", () => {
  const trace = refusalTrace();
  assert.equal(inspectAdmissionTrace(trace, refusal, []).upstream_requests, 0);
  trace.spans.push({
    ...structuredClone(trace.spans[0]),
    spanID: "3".repeat(16),
    references: [
      {
        refType: "CHILD_OF",
        traceID: trace.traceID,
        spanID: trace.spans[0].spanID,
      },
    ],
    tags: [
      { key: "span.kind", value: "client" },
      { key: "server.address", value: "identity-service" },
    ],
  });
  assert.throws(() => inspectAdmissionTrace(trace, refusal, []));
});
test("429 cannot conceal an unrelated root CLIENT in the same Trace", () => {
  const trace = refusalTrace();
  trace.spans.push({
    ...structuredClone(trace.spans[0]),
    spanID: "3".repeat(16),
    references: [],
    tags: [
      { key: "span.kind", value: "client" },
      { key: "server.address", value: "identity-service" },
    ],
  });
  assert.throws(() => inspectAdmissionTrace(trace, refusal, []));
});
test("raw error and missing parent cannot be reclassified as clock diagnostics", () => {
  const errored = refusalTrace();
  errored.spans[0].tags.push({ key: "error", value: true });
  assert.throws(() => inspectAdmissionTrace(errored, refusal, []));
  const detached = refusalTrace();
  detached.spans[0].references = [
    { refType: "CHILD_OF", traceID: detached.traceID, spanID: "f".repeat(16) },
  ];
  assert.throws(() => inspectAdmissionTrace(detached, refusal, []));
});

test("GET session proves its live Resolve without inventing later business forwarding", () => {
  const value = resolutionFixture("rpc");
  value.trace.spans = value.trace.spans.filter(
    (span) => span !== value.upstream,
  );
  value.root.operationName = "HTTP GET /api/session";
  setTag(value.root, "http.route", "/api/session");
  setTag(value.root, "client.address", "192.0.2.11");
  setTag(value.decision, "antnest.identity.resolve.profile", "session");
  const client = value.trace.spans.find(
    (span) => span.spanID === "resolve-client",
  );
  setTag(client, "server.address", "identity-service");
  const expected = {
    traceID: value.trace.traceID,
    path: "/api/session",
    method: "GET",
    status: 200,
    address: "192.0.2.11",
    identityHost: "identity-service",
    resolveTTLms: 10000,
  };
  const report = inspectAdmissionTrace(value.trace, expected, [], value);
  assert.equal(report.gateway_resolution.profile, "session");
  setTag(value.decision, "antnest.identity.resolve.profile", "console");
  assert.throws(() => inspectAdmissionTrace(value.trace, expected, [], value));
});
