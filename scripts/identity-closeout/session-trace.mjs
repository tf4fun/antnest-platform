import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import {
  traceTopology,
  tag,
  assertCaptureDisabled,
  owningServerTopology,
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

export function saveSessionTrace(trace) {
  const directory = process.env.ANTNEST_IDENTITY_EVIDENCE_DIR;
  if (!directory || !trace) return;
  assert.match(trace.traceID, /^[a-f0-9]{32}$/);
  mkdirSync(directory, { recursive: true });
  writeFileSync(`${directory}/${trace.traceID}.json`, JSON.stringify(trace), {
    mode: 0o600,
  });
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
  assert.equal(
    attempts.length,
    1,
    "missing or duplicate Identity admission check",
  );
  const client = attempts[0];
  assert.equal(tree.parent(client), root);
  assert(hasError(client), "denied Identity check error missing");
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
    1,
    "denied message was forwarded",
  );
  let sql = 0;
  if (expected.reason === "unavailable")
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
    identity_sql: sql,
    spans: trace.spans.length,
    warning_count: warnings.length,
    warnings: [...new Set(warnings)],
    error_spans: trace.spans.filter(hasError).length,
    strict_trace: "failed",
  };
}

export async function collectDeniedMessage(base, expected, secrets) {
  const query = new URLSearchParams({
    service: "edge-gateway",
    limit: "100",
    lookback: "1h",
    tags: JSON.stringify({ "rpc.method": expected.method }),
  });
  for (let attempt = 0; attempt < 40; attempt++) {
    let response, body;
    try {
      response = await fetch(`${base}/api/traces?${query}`, {
        signal: AbortSignal.timeout(5000),
      });
      body = await response.json();
    } catch {
      throw new Error("Gateway denial trace query failed");
    }
    assert(
      response.ok && !body.errors?.length,
      "Gateway denial trace query failed",
    );
    const id = selectDeniedMessage(body.data, expected);
    if (id)
      return collectTrace(base, id, (trace) => {
        saveSessionTrace(trace);
        return inspectDeniedMessage(trace, expected, secrets);
      });
    await delay(1000);
  }
  throw new Error("actual denied Gateway message trace missing");
}
