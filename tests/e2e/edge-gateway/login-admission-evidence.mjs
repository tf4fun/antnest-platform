import assert from "node:assert/strict";
import { isIP } from "node:net";
import { hasError } from "../acp-plan/requests.mjs";
import {
  tag,
  traceTopology,
  assertCaptureDisabled,
  owningServerTopology,
} from "../observability/trace-tree.mjs";
import { inspectIdentityTraceTopology } from "../identity-closeout/support.mjs";
import { inspectGatewayResolution } from "../../support/gateway-resolution.mjs";
import { assertSecretFree } from "../identity-closeout/evidence.mjs";

const startPath = "/api/session/oidc/start";
const startRPC = "/rpc/identity/start-oidc-login";

export async function attemptAdmissionArchive(failures, name, action) {
  try {
    await action();
  } catch {
    failures.push(name);
  }
}

export function admissionFailure(original, archiveFailures) {
  return (
    original ??
    (archiveFailures.length
      ? new Error("login admission diagnostic archive incomplete")
      : undefined)
  );
}

export function admissionPrincipal(created, session) {
  assert.equal(created.user.system_role, "user");
  assert.equal(created.membership.role, "member");
  assert.equal(created.user.active, true);
  assert.equal(created.membership.active, true);
  assert.equal(created.membership.user_id, created.user.id);
  const principal = {
    user_id: created.user.id,
    membership_id: created.membership.id,
    organization_id: session.principal.organization_id,
    organization_slug: session.principal.organization_slug,
    organization_name: session.principal.organization_name,
    system_role: "user",
    organization_role: "member",
    active: true,
  };
  for (const [key, value] of Object.entries(principal))
    if (key !== "active")
      assert(
        typeof value === "string" && value.length > 0,
        "missing expected Principal field",
      );
  return principal;
}

export function assertAdmissionArchive(body, traceID, secrets) {
  assert(
    body.errors == null ||
      (Array.isArray(body.errors) && body.errors.length === 0),
    "Jaeger backend diagnostic errors",
  );
  assert(
    Array.isArray(body.data) && body.data.length === 1,
    "diagnostic trace missing or duplicated",
  );
  const trace = body.data[0];
  assert.equal(trace.traceID, traceID, "wrong diagnostic Trace");
  traceTopology(trace);
  assertCaptureDisabled(trace);
  assertSecretFree(JSON.stringify(body), secrets);
  return trace;
}

export function identityExpectation(receipt) {
  if (receipt.status === 429) return null;
  if (receipt.path === startPath)
    return {
      method: "POST",
      route: startRPC,
      rpcMethod: "start_oidc_login",
      status: 200,
    };
  if (receipt.path === "/protocol/oidc/callback")
    return { method: "GET", route: receipt.path, status: 200 };
  assert.equal(receipt.path, "/api/session");
  return {
    method: "POST",
    route: "/rpc/identity/resolve-access-token",
    status: 200,
    resolveProfile: "session",
  };
}

export function assertAdmissionReceipts({
  clients,
  receipts,
  sourceLimit,
  windowMs,
  elapsedMs,
  gatewayLogs,
  identityLogs,
}) {
  assert(isIP(clients.a) && isIP(clients.b));
  assert.notEqual(
    clients.a,
    clients.b,
    "acceptance requires two actual source addresses",
  );
  assert(Number.isSafeInteger(sourceLimit) && sourceLimit > 0);
  assert(Number.isFinite(windowMs) && windowMs > 0);
  assert(
    Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs < windowMs,
    "natural expiry could explain admission recovery",
  );
  const expected = [
    ...Array.from({ length: sourceLimit }, () => [
      "a",
      "exhaust",
      "POST",
      startPath,
      200,
    ]),
    ["a", "exhaust", "POST", startPath, 429],
    ["b", "login", "POST", startPath, 200],
    ["b", "login", "GET", "/protocol/oidc/callback", 303],
    ["b", "login", "GET", "/api/session", 200],
    ["a", "refused", "POST", startPath, 429],
  ];
  assert.deepEqual(
    receipts.map((r) => [r.client, r.action, r.method, r.path, r.status]),
    expected,
  );
  assert.equal(
    new Set(receipts.map((r) => r.trace_id)).size,
    receipts.length,
    "response Trace IDs must be distinct",
  );
  let startCount = 0;
  for (const receipt of receipts) {
    assert.match(receipt.trace_id ?? "", /^[a-f0-9]{32}$/);
    assert(receipt.no_store);
    assert.equal(receipt.body_complete, true);
    const gateway = gatewayLogs.filter(
      (row) =>
        row.msg === "Edge Gateway request completed" &&
        row.trace_id === receipt.trace_id,
    );
    assert.equal(gateway.length, 1, "missing or duplicate Gateway completion");
    assert.equal(gateway[0].client_address, clients[receipt.client]);
    assert.equal(gateway[0].route, receipt.path);
    assert.equal(gateway[0].method, receipt.method);
    assert.equal(gateway[0].status_code, receipt.status);
    assert.equal(gateway[0].handler_completed, true);
    const identity = identityLogs.filter(
      (row) =>
        row.msg === "Identity HTTP request completed" &&
        row.trace_id === receipt.trace_id,
    );
    const expectedIdentity = identityExpectation(receipt);
    assert.equal(
      identity.length,
      expectedIdentity ? 1 : 0,
      "unexpected Identity request inventory",
    );
    if (expectedIdentity) {
      for (const key of ["method", "route"])
        assert.equal(identity[0][key], expectedIdentity[key]);
      assert.equal(identity[0].status_code, expectedIdentity.status);
      assert.equal(identity[0].result, "success");
      if (expectedIdentity.route === startRPC) startCount++;
    } else {
      assert.equal(receipt.set_cookie_count, 0);
      assert.equal(receipt.cookies_unchanged, true);
      assert.equal(
        receipt.retry_after,
        Math.max(1, Math.ceil(windowMs / 1000)),
      );
    }
  }
  assert.equal(startCount, sourceLimit + 1);
  return {
    gateway_request_count: receipts.length,
    start_rpc_count: startCount,
    refused_upstream_count: 0,
    elapsed_ms: elapsedMs,
    window_ms: windowMs,
    clients,
  };
}

export function inspectAdmissionTrace(trace, expected, secrets, options = {}) {
  assert.equal(trace.traceID, expected.traceID);
  const { service, parent, chain } = traceTopology(trace);
  assertCaptureDisabled(trace);
  assert(!trace.spans.some(hasError), "admission trace errors require review");
  const roots = trace.spans.filter(
    (span) =>
      service(span) === "edge-gateway" && tag(span, "span.kind") === "server",
  );
  assert.equal(roots.length, 1);
  const root = roots[0];
  assert.equal(parent(root), undefined);
  assert.equal(tag(root, "http.route"), expected.path);
  assert.equal(tag(root, "http.request.method"), expected.method);
  assert.equal(tag(root, "http.response.status_code"), expected.status);
  assert.equal(tag(root, "client.address"), expected.address);
  const outbound = trace.spans.filter(
    (span) =>
      service(span) === "edge-gateway" &&
      tag(span, "span.kind") === "client" &&
      chain(span).includes(root),
  );
  if (expected.status === 429) {
    assert(
      !trace.spans.some((span) => tag(span, "span.kind") === "client"),
      "Gateway refusal reached an upstream",
    );
    assert(trace.spans.every((span) => service(span) === "edge-gateway"));
    return { trace_id: trace.traceID, status: 429, upstream_requests: 0 };
  }
  assert.equal(
    outbound.length,
    1,
    "one actual Gateway-to-Identity CLIENT required",
  );
  assert.equal(tag(outbound[0], "server.address"), expected.identityHost);
  if (expected.path === "/api/session") {
    const decisions = trace.spans.filter(
      (span) =>
        service(span) === "edge-gateway" &&
        span.operationName === "gateway.identity.resolve" &&
        parent(span) === root,
    );
    assert.equal(decisions.length, 1);
    const { database } = owningServerTopology(trace, {
      ...identityExpectation(expected),
      service: "identity-service",
      clientService: "edge-gateway",
      clientSpanID: outbound[0].spanID,
    });
    // Session reads terminate at Gateway after Resolve. The Resolve CLIENT
    // must not be mistaken for a subsequent forwarded business request.
    const resolution = inspectGatewayResolution(
      trace,
      {
        rootSpanID: root.spanID,
        decisionSpanID: decisions[0].spanID,
        profile: "session",
        ttlMs: expected.resolveTTLms,
      },
      options,
    );
    return {
      trace_id: trace.traceID,
      gateway_resolution: resolution,
      database_spans: database.length,
    };
  }
  return inspectIdentityTraceTopology(
    trace,
    {
      ...identityExpectation(expected),
      traceID: expected.traceID,
      ...(expected.oidcRequests ? { oidcRequests: expected.oidcRequests } : {}),
      resolveTTLms: expected.resolveTTLms,
      clientService: "edge-gateway",
      clientSpanID: outbound[0].spanID,
    },
    secrets,
    options,
  );
}
