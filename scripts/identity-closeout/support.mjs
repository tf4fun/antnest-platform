import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { assertSecretFree } from "./evidence.mjs";
import { collectTrace } from "../observability/collect.mjs";
import {
  assertCaptureDisabled,
  owningServer,
  traceTree,
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

  async request(path, options = {}) {
    const {
      body,
      status = 200,
      responseType = "json",
      headers = {},
      method = body === undefined ? "GET" : "POST",
    } = options;
    const label = `${method} ${new URL(path, this.base).pathname}`;
    this.requests++;
    let response;
    let text;
    try {
      response = await fetch(this.base + path, {
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
      text = await response.text();
    } catch {
      throw new Error(`${label}: request failed`);
    }
    // Deliberately exclude response bodies and request headers from failures.
    assert.equal(
      response.status,
      status,
      `${label}: HTTP ${response.status}, expected ${status}`,
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
      parsed = responseType === "text" ? text : text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`${label}: invalid JSON response`);
    }
    return {
      body: parsed,
      headers: response.headers,
      traceID: response.headers.get("x-antnest-trace-id"),
    };
  }
}

export function inspectIdentityTrace(trace, expectation, secrets) {
  const { service, chain: ancestors } = traceTree(trace);
  assertCaptureDisabled(trace);
  assertSecretFree(JSON.stringify(trace), secrets);
  const isIdentityServer = (span) =>
    service(span) === "identity-service" && tag(span, "span.kind") === "server";
  const { server: identityRequest, database } = owningServer(trace, {
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
    const matching = trace.spans.filter(
      (span) =>
        service(span) === "identity-service" &&
        tag(span, "span.kind") === "client" &&
        tag(span, "http.request.method") === expected.method &&
        tag(span, "url.full") === expected.url,
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
