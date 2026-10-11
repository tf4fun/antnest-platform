import assert from "node:assert/strict";
import { hasError } from "../acp-plan/requests.mjs";
import {
  databaseChildrenTopology,
  tag,
  traceTopology,
} from "../observability/trace-tree.mjs";
import {
  assertGatewayResolutionAttributes,
  inspectGatewayResolution,
} from "../../support/gateway-resolution.mjs";
import {
  collectResolveTraceEvidence,
  resolveTraceSources,
} from "../../support/gateway-resolution-evidence.mjs";

// This is the normal Console POST admission, including read-only Create replay.
// Offboarding, stream revalidation and killed-process recovery have other roots
// or explicit topology scopes and keep their own owning inspectors.
export function inspectLifecycleResolution(
  trace,
  expected,
  secrets,
  options = {},
) {
  assert.equal(trace.traceID, expected.traceID);
  const sources = resolveTraceSources(trace, secrets, options);
  for (const source of sources) assertGatewayResolutionAttributes(source);
  const tree = traceTopology(trace);
  const one = (items, label) => {
    assert.equal(items.length, 1, `missing or duplicate ${label}`);
    return items[0];
  };
  const root = one(
    trace.spans.filter((span) => !tree.parent(span)),
    "Lifecycle Gateway root",
  );
  assert.equal(tree.service(root), "edge-gateway");
  assert.equal(tag(root, "span.kind"), "server");
  assert.equal(tag(root, "http.route"), "/api/admin/{path...}");
  assert.equal(tag(root, "http.request.method"), "POST");
  assert.equal(tag(root, "http.response.status_code"), 202);
  const consoleServer = one(
    trace.spans.filter(
      (span) =>
        tree.service(span) === "admin-console" &&
        tag(span, "span.kind") === "server",
    ),
    "Lifecycle Console SERVER",
  );
  assert.equal(tag(consoleServer, "http.request.method"), "POST");
  assert.equal(tag(consoleServer, "http.response.status_code"), 202);
  const upstream = tree.parent(consoleServer);
  assert.equal(tree.service(upstream), "edge-gateway");
  assert.equal(tag(upstream, "span.kind"), "client");
  assert.equal(tag(upstream, "http.request.method"), "POST");
  assert.equal(
    tree.parent(upstream),
    root,
    "Console forwarding is not under the actual root",
  );
  const decision = one(
    trace.spans.filter(
      (span) => span.operationName === "gateway.identity.resolve",
    ),
    "Lifecycle Resolve decision",
  );
  const resolution = inspectGatewayResolution(
    trace,
    {
      rootSpanID: root.spanID,
      upstreamSpanID: upstream.spanID,
      decisionSpanID: decision.spanID,
      profile: "console",
      ttlMs: expected.resolveTTLMS ?? 10000,
    },
    options,
  );
  if (resolution.rpc_client_span_id) {
    const source = sources.find(
      (item) => item.traceID === resolution.source_trace_id,
    );
    const sourceTree = traceTopology(source);
    const client = sourceTree.spans.get(resolution.rpc_client_span_id);
    const server = sourceTree.spans.get(resolution.identity_server_span_id);
    const sql = databaseChildrenTopology(source, server);
    assert(
      ![client, server, ...sql].some(hasError),
      "failed actual Resolve RPC or SQL",
    );
  }
  return resolution;
}

export async function collectLifecycleAdmissionTrace(
  base,
  expected,
  secrets,
  options = {},
) {
  assert.equal(
    typeof options.inspect,
    "function",
    "owning Lifecycle inspector required",
  );
  const attempts = options.attempts ?? 40;
  assert(
    Number.isSafeInteger(attempts) && attempts >= 3,
    "invalid Lifecycle convergence attempts",
  );
  const [result] = await collectResolveTraceEvidence(
    base,
    [expected],
    secrets,
    {
      ...options,
      attempts,
      inspect: async (trace, selected, privateValues, collection) => {
        const resolution = inspectLifecycleResolution(
          trace,
          selected,
          privateValues,
          collection,
        );
        const checked = await options.inspect(trace, selected, privateValues);
        // Existing scoped business exceptions classify only the current trace.
        // Errors in linked caller/refresh/trigger traces cannot inherit them.
        const sourceErrors = [...collection.traces.values()]
          .filter((source) => source.traceID !== trace.traceID)
          .reduce(
            (count, source) => count + source.spans.filter(hasError).length,
            0,
          );
        return {
          ...checked,
          gateway_resolution: resolution,
          resolve_source_error_spans: sourceErrors,
        };
      },
    },
  );
  return result;
}
