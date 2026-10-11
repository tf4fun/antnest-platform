import assert from "node:assert/strict";
import { searchJaegerTraces } from "../../support/jaeger-search.mjs";
import {
  evidenceDirectory,
  evidenceFilePath,
  writeEvidenceFile,
} from "../../support/storage.mjs";
import { setTimeout as delay } from "node:timers/promises";
import {
  traceTopology,
  tag,
  assertCaptureDisabled,
  owningServerTopology,
  databaseChildrenTopology,
} from "../observability/trace-tree.mjs";
import { hasError, selectRequestTrace } from "../acp-plan/requests.mjs";
import { assertSecretFree } from "./evidence.mjs";
import { collectTrace } from "../managed-mcp/trace.mjs";

export function selectDeniedMessage(data, expected) {
  assert(
    Array.isArray(data) && data.length < 100,
    "denial trace query invalid or truncated",
  );
  return selectRequestTrace(
    data.filter((trace) =>
      trace.spans?.some(
        (span) =>
          trace.processes?.[span.processID]?.serviceName === "edge-gateway" &&
          tag(span, "span.kind") === "server" &&
          tag(span, "rpc.method") === expected.method &&
          hasError(span),
      ),
    ),
    expected,
  );
}

export function strictSessionEvidence(result, trace) {
  const errors = trace.spans.filter(hasError).length;
  return {
    ...result,
    error_spans: errors,
    strict_trace: errors ? "failed" : result.strict_trace,
  };
}

export function saveSessionTrace(
  trace,
  directory = process.env.ANTNEST_IDENTITY_EVIDENCE_DIR,
) {
  directory = evidenceDirectory(directory);
  if (!directory || !trace) return;
  assert.match(trace.traceID, /^[a-f0-9]{32}$/);
  writeEvidenceFile(directory, `${trace.traceID}.json`, JSON.stringify(trace));
}

export function inspectDeniedMessage(trace, expected, secrets) {
  assert(["unavailable", "expired", "revoked"].includes(expected.reason));
  assert.equal(
    expected.closeCode,
    expected.reason === "unavailable" ? 1013 : 1008,
  );
  const tree = traceTopology(trace);
  assertCaptureDisabled(trace);
  assertSecretFree(JSON.stringify(trace), secrets);
  const roots = trace.spans.filter((s) => !tree.parent(s));
  assert.equal(roots.length, 1, "denial must have one complete message root");
  const root = roots[0];
  assert.equal(tree.service(root), "edge-gateway");
  assert.equal(tag(root, "span.kind"), "server");
  assert.equal(tag(root, "rpc.method"), expected.method);
  assert.equal(tag(root, "network.transport"), "websocket");
  assert.equal(
    selectDeniedMessage([trace], expected),
    trace.traceID,
    "wrong connection link",
  );
  assert(hasError(root), "denied message error missing");
  const attempts = trace.spans.filter(
    (s) =>
      tree.service(s) === "edge-gateway" &&
      tag(s, "span.kind") === "client" &&
      s.operationName === "HTTP POST identity-service" &&
      tag(s, "http.request.method") === "POST" &&
      tag(s, "server.address") === "identity-service" &&
      tag(s, "server.port") === 8080 &&
      tag(s, "url.scheme") === "http",
  );
  // Gateway closes on an expired caller context before re-resolving the
  // session, so only an expiry denial may omit the Identity check.
  const localExpiry = expected.reason === "expired" && attempts.length === 0;
  if (localExpiry)
    assert.equal(trace.spans.length, 1, "local expiry denial was forwarded");
  else
    assert.equal(
      attempts.length,
      1,
      "missing or duplicate Identity admission check",
    );
  const client = attempts[0];
  if (client) {
    assert.equal(tree.parent(client), root);
    assert(hasError(client), "denied Identity check error missing");
  }
  for (const span of trace.spans)
    assert(
      ["edge-gateway", "identity-service"].includes(tree.service(span)),
      "denied message reached execution service",
    );
  assert.equal(
    trace.spans.filter(
      (s) =>
        tree.service(s) === "edge-gateway" && tag(s, "span.kind") === "client",
    ).length,
    attempts.length,
    "denied message was forwarded",
  );
  let sql = 0;
  if (localExpiry || expected.reason === "unavailable")
    assert(
      !trace.spans.some((s) => tree.service(s) === "identity-service"),
      "outage fabricated Identity response",
    );
  else {
    const owner = owningServerTopology(trace, {
      service: "identity-service",
      route: "/rpc/identity/resolve-access-token",
      method: "POST",
      rpcMethod: "resolve_access_token",
      clientService: "edge-gateway",
      clientSpanID: client.spanID,
    });
    sql = owner.database.length;
  }
  const warnings = [
    ...(trace.warnings ?? []),
    ...trace.spans.flatMap((s) => s.warnings ?? []),
  ];
  return {
    trace_id: trace.traceID,
    method: expected.method,
    reason: expected.reason,
    close_code: expected.closeCode,
    no_execution: true,
    identity_checks: attempts.length,
    identity_sql: sql,
    spans: trace.spans.length,
    warning_count: warnings.length,
    warnings: [...new Set(warnings)],
    error_spans: trace.spans.filter(hasError).length,
    strict_trace: "failed",
  };
}

export async function collectDeniedMessage(base, expected, secrets) {
  const directory = evidenceDirectory(
    process.env.ANTNEST_IDENTITY_EVIDENCE_DIR,
  );
  const query = new URLSearchParams({
    service: "edge-gateway",
    limit: "100",
    lookback: "1h",
    tags: JSON.stringify({ "rpc.method": expected.method }),
  });
  for (let attempt = 0; attempt < 40; attempt++) {
    let data;
    try {
      data = await searchJaegerTraces(base, query, {
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      throw new Error("Gateway denial trace query failed");
    }
    const id = selectDeniedMessage(data, expected);
    if (id) {
      evidenceFilePath(directory, `${id}.json`);
      return collectTrace(base, id, (trace) => {
        saveSessionTrace(trace, directory);
        return inspectDeniedMessage(trace, expected, secrets);
      });
    }
    await delay(1000);
  }
  throw new Error("actual denied Gateway message trace missing");
}

export function inspectSessionClosure(trace, expected, secrets) {
  assert.match(expected.connectionTraceID ?? "", /^[a-f0-9]{32}$/);
  assert.equal(
    trace?.traceID,
    expected.connectionTraceID,
    "wrong closed connection trace",
  );
  assert([1, 2].includes(expected.version));
  const cause = {
    revoked: [1008, ["session_rejected"]],
    expired: [1008, ["caller_context_expired", "session_rejected"]],
    unavailable: [1013, ["identity_unavailable"]],
  }[expected.reason];
  assert(cause, "unknown closure reason");
  assert.equal(expected.closeCode, cause[0]);
  assert(cause[1].includes(expected.closeReason));
  assert.equal(expected.localClose, false);
  assert.equal(expected.postCloseRequestSent, false);
  assert(Number.isInteger(expected.requestCount) && expected.requestCount > 0);
  assert(
    Number.isFinite(expected.startedAt) &&
      Number.isFinite(expected.closedAt) &&
      expected.closedAt >= expected.startedAt &&
      expected.closedAt <= expected.startedAt + 30000,
    "closure evidence exceeded its authority bound",
  );
  if (expected.reason === "expired")
    assert(
      Number.isFinite(expected.expiresAt) &&
        expected.derivedCCTExpiresAt ===
          Math.floor(expected.expiresAt / 1000) * 1000 &&
        expected.closedAt >= expected.derivedCCTExpiresAt - 1000 &&
        expected.closedAt <= expected.derivedCCTExpiresAt,
      "closure does not match its issued expiry",
    );
  const tree = traceTopology(trace);
  assertCaptureDisabled(trace);
  assertSecretFree(JSON.stringify(trace), secrets);
  const roots = trace.spans.filter((span) => !tree.parent(span));
  assert.equal(roots.length, 1, "connection must have one complete root");
  const root = roots[0];
  assert.equal(tree.service(root), "edge-gateway");
  assert.equal(tag(root, "span.kind"), "server");
  assert.equal(tag(root, "http.request.method"), "GET");
  assert.equal(
    tag(root, "http.route"),
    `/api/app/agents/{agent_id}/v${expected.version}/acp`,
  );
  assert.equal(tag(root, "http.response.status_code"), 101);
  const receivers = trace.spans.filter(
    (span) =>
      tree.service(span) === "agent-acp-service" &&
      tag(span, "span.kind") === "server",
  );
  assert.equal(receivers.length, 1, "one real ACP upgrade required");
  const receiver = receivers[0];
  assert.equal(tag(receiver, "http.request.method"), "GET");
  assert.equal(tag(receiver, "http.route"), `/v${expected.version}/acp`);
  assert.equal(tag(receiver, "http.response.status_code"), 101);
  const socketClient = tree.parent(receiver);
  assert.equal(tree.service(socketClient), "edge-gateway");
  assert.equal(tag(socketClient, "span.kind"), "client");
  assert.equal(tree.parent(socketClient), root);
  const resolutions = trace.spans.filter(
    (span) =>
      tree.service(span) === "identity-service" &&
      tag(span, "span.kind") === "server" &&
      tag(span, "http.route") === "/rpc/identity/resolve-access-token" &&
      tag(span, "http.response.status_code") === 200,
  );
  assert(
    resolutions.length > 0,
    "successful initial Identity resolution missing",
  );
  let sql = 0,
    initialResolutions = 0;
  assert(Number.isFinite(socketClient.startTime), "socket dial start missing");
  for (const server of resolutions) {
    assert.equal(tag(server, "http.request.method"), "POST");
    assert.equal(tag(server, "rpc.method"), "resolve_access_token");
    const client = tree.parent(server);
    assert.equal(tree.service(client), "edge-gateway");
    assert.equal(tag(client, "span.kind"), "client");
    assert.equal(tree.parent(client), root);
    assert(
      Number.isFinite(client.startTime) &&
        Number.isFinite(client.duration) &&
        client.duration >= 0,
      "Identity client timing missing",
    );
    if (client.startTime + client.duration <= socketClient.startTime)
      initialResolutions++;
    sql += databaseChildrenTopology(trace, server).length;
  }
  assert(
    initialResolutions > 0,
    "initial Identity admission before socket dial missing",
  );
  assert(
    !trace.spans.some((span) =>
      tag(span, "rpc.method")?.startsWith("session/"),
    ),
    "connection closure cannot fabricate an ACP message trace",
  );
  const warnings = [
    ...(trace.warnings ?? []),
    ...trace.spans.flatMap((span) => span.warnings ?? []),
  ];
  const errors = trace.spans.filter(hasError).length;
  return {
    ...expected,
    trace_id: trace.traceID,
    closure: "silent",
    identity_sql: sql,
    spans: trace.spans.length,
    warning_count: warnings.length,
    warnings: [...new Set(warnings)],
    error_spans: errors,
    strict_trace: warnings.length || errors ? "failed" : "passed",
  };
}

export async function collectSessionClosure(base, expected, secrets) {
  return collectTrace(base, expected.connectionTraceID, (trace) => {
    saveSessionTrace(trace);
    return inspectSessionClosure(trace, expected, secrets);
  });
}
