import assert from "node:assert/strict";
import {
  inspectIdentityTraceTopology,
  identityTraceSources,
} from "../identity-closeout/support.mjs";
import {
  tag,
  traceTopology,
  owningServerTopology,
} from "../observability/trace-tree.mjs";
import { hasError } from "../acp-plan/requests.mjs";

export function inspectLifecycleTrace(trace, expected, secrets, options = {}) {
  const result = inspectIdentityTraceTopology(
    trace,
    expected,
    secrets,
    options,
  );
  const tree = traceTopology(trace);
  const { server, client } = owningServerTopology(trace, {
    ...expected,
    service: "identity-service",
  });
  const hops = tree
    .chain(server)
    .filter((span) => tag(span, "http.request.method") !== undefined)
    .reverse();
  const expectedHops = expected.console
    ? [
        ["edge-gateway", "server", "/api/admin/{path...}"],
        ["edge-gateway", "client"],
        ["admin-console", "server", expected.consoleRoute],
        ["admin-console", "client"],
        ["identity-service", "server", expected.route],
      ]
    : [
        ["edge-gateway", "server", "/scim/v2/{path...}"],
        ["edge-gateway", "client"],
        ["identity-service", "server", expected.route],
      ];
  assert.equal(
    hops.length,
    expectedHops.length,
    "unexpected lifecycle HTTP chain",
  );
  assert.equal(
    tree.parent(hops[0]),
    undefined,
    "actual Gateway SERVER must be the root",
  );
  assert.equal(
    trace.spans.filter(
      (span) =>
        tree.service(span) === "edge-gateway" &&
        tag(span, "span.kind") === "server",
    ).length,
    1,
    "exactly one Gateway SERVER required",
  );
  for (const [index, [service, kind, route]] of expectedHops.entries()) {
    const span = hops[index];
    if (index > 0)
      assert.equal(
        tree.parent(span),
        hops[index - 1],
        "lifecycle HTTP hops must have direct causal parents",
      );
    assert(
      Number.isFinite(span.duration) && span.duration > 0,
      "unfinished lifecycle HTTP span",
    );
    assert.equal(tree.service(span), service, "wrong lifecycle HTTP service");
    assert.equal(
      tag(span, "span.kind"),
      kind,
      "wrong lifecycle HTTP span kind",
    );
    assert.equal(
      tag(span, "http.request.method"),
      expected.method,
      "lifecycle HTTP method changed between hops",
    );
    assert.equal(
      tag(span, "http.response.status_code"),
      expected.status,
      "lifecycle HTTP status changed between hops",
    );
    const bytes = tag(span, "http.response.body.size");
    assert(
      Number.isSafeInteger(bytes) && bytes >= 0,
      "lifecycle response byte count missing",
    );
    if (!expected.console || index <= 2)
      assert.equal(
        bytes,
        expected.responseBytes,
        "lifecycle forwarding body differs from the received response",
      );
    else
      assert.equal(
        bytes,
        tag(hops.at(-1), "http.response.body.size"),
        "Identity RPC response was truncated before Console",
      );
    if (kind === "server") {
      assert(route, "lifecycle SERVER route expectation absent");
      assert.equal(
        tag(span, "http.route"),
        route,
        "wrong lifecycle HTTP route",
      );
    }
  }
  if (!expected.console) {
    assert(
      !trace.spans.some(
        (span) =>
          tree.service(span) === "admin-console" ||
          span.operationName === "gateway.identity.resolve",
      ),
      "SCIM must use its bearer path without Console or browser Resolve",
    );
    assert.equal(
      trace.spans.filter(
        (span) =>
          tree.service(span) === "identity-service" &&
          tag(span, "span.kind") === "server",
      ).length,
      1,
      "SCIM has an unexpected Identity request",
    );
  }
  const errorCodes = {
    400: "invalid_reference",
    401: "unauthenticated",
    404: "not_found",
    412: "precondition_failed",
  };
  if (expected.status >= 400) {
    assert.equal(
      expected.errorCode,
      errorCodes[expected.status],
      "rejection lacks an exact lifecycle error expectation",
    );
    assert(
      expected.errorCode && !expected.console,
      "only declared SCIM refusals are admitted here",
    );
    assert(
      hasError(server),
      "expected refusal lacks Identity rejection evidence",
    );
    assert.equal(tag(server, "antnest.outcome"), "rejected");
    assert.equal(tag(server, "antnest.error.code"), expected.errorCode);
    assert.equal(tag(server, "error.type"), expected.errorCode);
    assert.notEqual(
      tag(server, "otel.status_code"),
      "ERROR",
      "expected refusal became an internal server failure",
    );
    assert.notEqual(
      tag(server, "error"),
      true,
      "expected refusal became an internal server failure",
    );
    const events = (server.logs ?? []).filter((event) =>
      event.fields?.some((field) => field.value === "antnest.error"),
    );
    assert.equal(events.length, 1, "one safe rejection event required");
    assert.equal(
      events[0].fields.find((field) => field.key === "antnest.error.code")
        ?.value,
      expected.errorCode,
    );
  } else {
    assert.equal(expected.errorCode, undefined);
  }
  const expectedErrors = [];
  for (const source of identityTraceSources(trace, secrets, options)) {
    const sourceTree = traceTopology(source);
    for (const span of source.spans.filter(hasError)) {
      const ownRefusal =
        source === trace && expected.errorCode && span === server;
      const ownHTTPClient =
        source === trace && expected.errorCode && span === client;
      assert(
        ownRefusal || ownHTTPClient,
        "unclassified lifecycle or Resolve source error",
      );
      if (ownHTTPClient) {
        assert.equal(
          tag(span, "error.type"),
          String(expected.status),
          "HTTP failure is not the expected refusal",
        );
        assert.equal(
          tag(span, "antnest.error.code"),
          undefined,
          "transport failed during an expected refusal",
        );
        assert(
          Number.isSafeInteger(tag(span, "http.request.body.size")) &&
            tag(span, "http.request.body.size") >= 0,
          "HTTP request byte count missing",
        );
        assert(
          !(span.logs ?? []).some((event) =>
            event.fields?.some((field) => field.value === "antnest.error"),
          ),
          "unexpected transport error event",
        );
      }
      expectedErrors.push({
        trace_id: source.traceID,
        span_id: span.spanID,
        service: sourceTree.service(span),
        kind: tag(span, "span.kind"),
        code: ownRefusal ? expected.errorCode : String(expected.status),
      });
    }
  }
  // Raw warning/error counts and strict_trace remain the collector's results.
  // This additional classification never rewrites them into a strict pass.
  return {
    ...result,
    http_hops: hops.length,
    expected_errors: expectedErrors,
    unexpected_errors: 0,
  };
}
