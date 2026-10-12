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
import { resolveTraceSources } from "../../support/gateway-resolution-evidence.mjs";

// Policy writes return 200 under a PUT boundary. The normal lifecycle POST/202
// admission and its business inspector remain separate.
export function inspectPolicyResolution(
  trace,
  expected,
  secrets,
  options = {},
) {
  assert.equal(trace.traceID, expected.traceID);
  const sources = resolveTraceSources(trace, secrets, options);
  for (const source of sources) assertGatewayResolutionAttributes(source);
  const tree = traceTopology(trace);
  const one = (spans, label) => {
    assert.equal(spans.length, 1, `missing or duplicate ${label}`);
    return spans[0];
  };
  const root = one(
    trace.spans.filter((span) => !tree.parent(span)),
    "policy Gateway root",
  );
  assert.equal(tree.service(root), "edge-gateway");
  assert.equal(tag(root, "span.kind"), "server");
  assert.equal(tag(root, "http.route"), "/api/admin/{path...}");
  assert.equal(tag(root, "http.request.method"), "PUT");
  assert.equal(tag(root, "http.response.status_code"), 200);
  const consoleServer = one(
    trace.spans.filter(
      (span) =>
        tree.service(span) === "admin-console" &&
        tag(span, "span.kind") === "server",
    ),
    "policy Console SERVER",
  );
  assert.equal(
    tag(consoleServer, "http.route"),
    "/api/admin/agents/{agent_id}/network-policy",
  );
  assert.equal(tag(consoleServer, "http.request.method"), "PUT");
  assert.equal(tag(consoleServer, "http.response.status_code"), 200);
  const upstream = tree.parent(consoleServer);
  assert.equal(tree.service(upstream), "edge-gateway");
  assert.equal(tag(upstream, "span.kind"), "client");
  assert.equal(tag(upstream, "http.request.method"), "PUT");
  assert.equal(tag(upstream, "http.response.status_code"), 200);
  assert.equal(
    tree.parent(upstream),
    root,
    "policy forwarding is not under the actual Gateway root",
  );
  const egress = one(
    trace.spans.filter(
      (span) =>
        tree.service(span) === "antnest-runtime-egress" &&
        span.operationName ===
          "HTTP PUT /internal/agent-policy-assignments/{agent_id}",
    ),
    "policy Egress write",
  );
  assert(
    tree.chain(egress).includes(consoleServer),
    "policy write is outside the admitted Console request",
  );
  const decision = one(
    trace.spans.filter(
      (span) => span.operationName === "gateway.identity.resolve",
    ),
    "policy Resolve decision",
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
      (candidate) => candidate.traceID === resolution.source_trace_id,
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
