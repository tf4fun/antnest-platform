import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

export function assertNoStore(headers) {
  // A proxy may append the same cache directive as its upstream.
  const directives = new Set(
    (headers.get("cache-control") ?? "")
      .toLowerCase()
      .split(",")
      .map((part) => part.trim()),
  );
  assert.deepEqual(directives, new Set(["no-store"]));
}

export function assertCookiesCleared(cookie) {
  assert(cookie === "", "Logout did not clear session cookies");
}

export class GatewayClient {
  cookies = new Map();
  requests = 0;

  constructor(base) {
    this.base = new URL(base).origin;
  }

  get cookie() {
    return [...this.cookies]
      .map(([key, value]) => `${key}=${value}`)
      .join("; ");
  }

  async request(path, options = {}) {
    const {
      body,
      status = 200,
      headers = {},
      method = body === undefined ? "GET" : "POST",
    } = options;
    this.requests++;
    const response = await fetch(this.base + path, {
      method,
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
      headers: {
        "content-type": "application/json",
        Cookie: this.cookie,
        Origin: this.base,
        "X-Antnest-CSRF-Token": this.cookies.get("antnest_csrf") ?? "",
        "Idempotency-Key": randomUUID(),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    // Deliberately exclude response bodies and request headers from failures.
    assert.equal(
      response.status,
      status,
      `${method} ${path}: HTTP ${response.status}, expected ${status}`,
    );
    for (const raw of response.headers.getSetCookie()) {
      const pair = raw.split(";", 1)[0];
      const split = pair.indexOf("=");
      const name = pair.slice(0, split);
      const value = pair.slice(split + 1);
      if (value) this.cookies.set(name, value);
      else this.cookies.delete(name);
    }
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`${method} ${path}: invalid JSON response`);
    }
    return {
      body: parsed,
      headers: response.headers,
      traceID: response.headers.get("x-antnest-trace-id"),
    };
  }
}

export function inspectIdentityTrace(trace, expectation, secrets) {
  assert(trace?.spans?.length, "trace not exported");
  const spans = new Map(trace.spans.map((span) => [span.spanID, span]));
  const service = (span) => trace.processes[span.processID]?.serviceName;
  function ancestors(span) {
    const chain = [];
    const seen = new Set();
    while (span && !seen.has(span.spanID)) {
      seen.add(span.spanID);
      chain.push(span);
      const parent = span.references?.find(
        (ref) => ref.refType === "CHILD_OF" && ref.traceID === trace.traceID,
      );
      span = spans.get(parent?.spanID);
    }
    return chain;
  }
  const repository = trace.spans.find(
    (span) =>
      service(span) === "identity-service" &&
      span.operationName === expectation.repository,
  );
  assert(repository, "missing expected Identity repository operation");
  const chain = ancestors(repository);
  const edgeIndex = chain.findIndex((span) => service(span) === "edge-gateway");
  assert(edgeIndex > 0, "missing Gateway ancestry");
  assert(
    chain
      .slice(1, edgeIndex)
      .some(
        (span) =>
          service(span) === "identity-service" &&
          span.operationName.startsWith("HTTP "),
      ),
    "missing Identity HTTP ancestry",
  );
  if (expectation.console) {
    assert(
      chain
        .slice(1, edgeIndex)
        .some((span) => service(span) === "admin-console"),
      "missing Console ancestry",
    );
  }
  const encoded = JSON.stringify(trace);
  for (const secret of secrets)
    assert(!secret || !encoded.includes(secret), "secret exported in trace");
  return {
    trace_id: trace.traceID,
    spans: trace.spans.length,
    repository: expectation.repository,
    gateway_ancestry: true,
    services: [...new Set(chain.map(service))].sort(),
  };
}

export async function verifyIdentityTraces(base, expectations, secrets) {
  const result = [];
  for (const expectation of expectations) {
    assert.match(
      expectation.traceID ?? "",
      /^[a-f0-9]{32}$/,
      "Gateway trace ID missing",
    );
    const deadline = Date.now() + 45000;
    let lastError;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(
          `${base}/api/traces/${expectation.traceID}`,
          { signal: AbortSignal.timeout(5000) },
        );
        assert.equal(response.status, 200, "Jaeger trace request failed");
        const trace = (await response.json()).data?.[0];
        assert.equal(
          trace?.traceID,
          expectation.traceID,
          "Jaeger returned wrong trace",
        );
        result.push(inspectIdentityTrace(trace, expectation, secrets));
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        await delay(500);
      }
    }
    if (lastError) throw lastError;
  }
  return result;
}
