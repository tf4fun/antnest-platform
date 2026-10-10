import { gatewayOrigin } from "../../support/gateway-origin.mjs";
import { gatewaySessionCookies } from "../../support/gateway-session-cookies.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  annotateFailure,
  transportFailure,
} from "../../support/verification/failure.mjs";
import { assertSecretFree } from "./evidence.mjs";
import { collectTrace } from "../observability/collect.mjs";
import {
  assertCaptureDisabled,
  owningServerTopology,
  traceTree,
  traceTopology,
  tag,
} from "../observability/trace-tree.mjs";

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

  get csrf() {
    return gatewaySessionCookies(this.cookies).csrf;
  }

  get accessToken() {
    return gatewaySessionCookies(this.cookies).accessToken;
  }

  async request(path, options = {}) {
    const {
      body,
      status = 200,
      responseType = "json",
      headers = {},
      method = body === undefined ? "GET" : "POST",
      timeoutMs = 15000,
    } = options;
    const label = `${method} ${new URL(path, this.base).pathname}`;
    this.requests++;
    let response;
    let text;
    let requestPhase = "fetch";
    try {
      response = await fetch(this.base + path, {
        method,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          "content-type": "application/json",
          Cookie: this.cookie,
          Origin: gatewayOrigin(this.base),
          "X-Antnest-CSRF-Token": this.csrf,
          "Idempotency-Key": randomUUID(),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      requestPhase = "response-body";
      text = await response.text();
    } catch (error) {
      throw annotateFailure(new Error(`${label}: request failed`), {
        request_phase: requestPhase,
        timeout_ms: timeoutMs,
        http_status: response?.status,
        ...transportFailure(error),
      });
    }
    // Deliberately exclude response bodies and request headers from failures.
    try {
      assert.equal(
        response.status,
        status,
        `${label}: HTTP ${response.status}, expected ${status}`,
      );
    } catch (error) {
      throw annotateFailure(error, {
        request_phase: "http-status",
        http_status: response.status,
        expected_status: status,
      });
    }
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
      parsed = responseType === "text" ? text : text ? JSON.parse(text) : null;
    } catch {
      throw annotateFailure(new Error(`${label}: invalid JSON response`), {
        request_phase: "json-parse",
        http_status: response.status,
      });
    }
    return {
      body: parsed,
      headers: response.headers,
      traceID: response.headers.get("x-antnest-trace-id"),
    };
  }
}

export function inspectIdentityTrace(trace, expectation, secrets) {
  traceTree(trace);
  return inspectIdentityTraceTopology(trace, expectation, secrets);
}

export function inspectIdentityTraceTopology(trace, expectation, secrets) {
  if (expectation.traceID !== undefined)
    assert.equal(trace?.traceID, expectation.traceID, "wrong Identity trace");
  const { service, chain: ancestors } = traceTopology(trace);
  assertCaptureDisabled(trace);
  assertSecretFree(JSON.stringify(trace), secrets);
  const isIdentityServer = (span) =>
    service(span) === "identity-service" && tag(span, "span.kind") === "server";
  const { server: identityRequest, database } = owningServerTopology(trace, {
    ...expectation,
    service: "identity-service",
  });
  const chain = ancestors(identityRequest);
  const edgeIndex = chain.findIndex((span) => service(span) === "edge-gateway");
  assert(edgeIndex > 0, "missing Gateway ancestry");
  if (expectation.console) {
    assert(
      chain
        .slice(1, edgeIndex)
        .some((span) => service(span) === "admin-console"),
      "missing Console ancestry",
    );
  }
  const outbound = (expectation.oidcRequests ?? []).map((expected) => {
    assert(expected.spanID, "actual IdP traceparent identity missing");
    const endpoint = new URL(expected.url);
    const matching = trace.spans.filter(
      (span) =>
        service(span) === "identity-service" &&
        tag(span, "span.kind") === "client" &&
        tag(span, "http.request.method") === expected.method &&
        span.spanID === expected.spanID &&
        tag(span, "server.address") === endpoint.hostname &&
        tag(span, "url.scheme") === endpoint.protocol.slice(0, -1) &&
        (endpoint.port === "" ||
          tag(span, "server.port") === Number(endpoint.port)),
    );
    assert.equal(matching.length, 1, "one exact IdP client request required");
    const span = matching[0];
    assert(
      span.duration > 0 && tag(span, "error") !== true,
      "IdP request did not finish successfully",
    );
    assert.equal(
      tag(span, "http.response.status_code"),
      200,
      "IdP request failed",
    );
    assert(
      ancestors(span).slice(1).find(isIdentityServer)?.spanID ===
        identityRequest.spanID,
      "IdP request is detached from the owning Identity request",
    );
    return {
      method: expected.method,
      path: new URL(expected.url).pathname,
      span_id: span.spanID,
    };
  });
  if (expectation.oidcRequests) {
    const peers = new Set(
      expectation.oidcRequests.map((item) => new URL(item.url).hostname),
    );
    const actual = trace.spans.filter(
      (span) =>
        service(span) === "identity-service" &&
        tag(span, "span.kind") === "client" &&
        peers.has(tag(span, "server.address")) &&
        ancestors(span).slice(1).find(isIdentityServer) === identityRequest,
    );
    assert.deepEqual(
      new Set(actual.map((span) => span.spanID)),
      new Set(outbound.map((item) => item.span_id)),
      "unexpected or duplicate IdP client request",
    );
  }
  return {
    trace_id: trace.traceID,
    spans: trace.spans.length,
    route: expectation.route,
    database_spans: database.length,
    capture_rpc_content: false,
    gateway_ancestry: true,
    services: [...new Set(chain.map(service))].sort(),
    ...(expectation.oidcRequests ? { oidc_requests: outbound } : {}),
  };
}

export async function verifyIdentityTraces(
  base,
  expectations,
  secrets,
  options,
) {
  const result = [];
  for (const traceID of new Set(expectations.map((item) => item.traceID))) {
    assert.match(traceID ?? "", /^[a-f0-9]{32}$/, "Gateway trace ID missing");
    result.push(
      ...(await collectTrace(
        base,
        traceID,
        (trace) =>
          expectations
            .filter((item) => item.traceID === traceID)
            .map((item) => inspectIdentityTrace(trace, item, secrets)),
        undefined,
        options,
      )),
    );
  }
  return result;
}
