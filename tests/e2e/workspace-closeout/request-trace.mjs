import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { searchJaegerTraces } from "../../support/jaeger-search.mjs";
import { hasError } from "../acp-plan/requests.mjs";
import {
  databaseChildrenTopology,
  traceTopology,
} from "../observability/trace-tree.mjs";
import {
  requestTraceBoundary,
  selectCommandTrace,
} from "../acp-commands/trace.mjs";
import {
  assertGatewayResolutionAttributes,
  inspectGatewayResolution,
} from "../../support/gateway-resolution.mjs";
import {
  collectResolveTraceEvidence,
  resolveTraceSources,
} from "../../support/gateway-resolution-evidence.mjs";

// The shared oracle proves topology. Workspace additionally rejects errors in
// the exact admitted RPC receipt; an original caller's cancellation is separate.
export function assertWorkspaceResolveReceipt(trace, resolution, options) {
  if (!resolution.rpc_client_span_id) return;
  const source =
    resolution.source_trace_id === trace.traceID
      ? trace
      : options.traces.get(resolution.source_trace_id);
  const tree = traceTopology(source);
  const client = tree.spans.get(resolution.rpc_client_span_id);
  const server = tree.spans.get(resolution.identity_server_span_id);
  const database = databaseChildrenTopology(source, server);
  assert(
    ![client, server, ...database].some(hasError),
    "failed actual Resolve RPC or SQL",
  );
}

// Direct ACP HTTP requests and individual WebSocket messages both select acp.
// Connection/watch roots and the Agent UI HTTP Bridge have separate gates.
export function inspectWorkspaceRequestResolution(
  trace,
  expected,
  secrets,
  options = {},
) {
  const { root, forwarded } = requestTraceBoundary(trace, expected, secrets);
  for (const source of resolveTraceSources(trace, secrets, options))
    assertGatewayResolutionAttributes(source);
  const decisions = trace.spans.filter(
    (span) => span.operationName === "gateway.identity.resolve",
  );
  assert.equal(
    decisions.length,
    1,
    "missing or duplicate ACP request Resolve decision",
  );
  const resolution = inspectGatewayResolution(
    trace,
    {
      rootSpanID: root.spanID,
      upstreamSpanID: forwarded.spanID,
      decisionSpanID: decisions[0].spanID,
      profile: "acp",
      ttlMs: expected.resolveTTLMS ?? 10000,
    },
    options,
  );
  assertWorkspaceResolveReceipt(trace, resolution, options);
  return resolution;
}

export async function collectWorkspaceRequestTrace(
  base,
  expected,
  secrets,
  requests = [],
  options = {},
) {
  const {
    inspect,
    onSelected,
    signal,
    request = fetch,
    wait = delay,
    attempts = 40,
  } = options;
  assert.equal(
    typeof inspect,
    "function",
    "owning Workspace request inspector required",
  );
  assert(
    Number.isSafeInteger(attempts) && attempts >= 3,
    "invalid trace convergence attempts",
  );
  signal?.throwIfAborted();
  let traceID;
  if (expected.transport === "http") traceID = expected.traceID;
  else {
    assert.equal(expected.transport, "websocket");
    assert(
      expected.requestId && expected.agentId && expected.connectionTraceID,
      "actual request identity missing",
    );
    const query = new URLSearchParams({
      service: "agent-acp-service",
      limit: "100",
      lookback: "1h",
      tags: JSON.stringify({
        "rpc.method": expected.method,
        "antnest.agent.id": expected.agentId,
        "antnest.request.id": expected.requestId,
        ...(expected.sessionId
          ? { "antnest.session.id": expected.sessionId }
          : {}),
      }),
    });
    for (let attempt = 0; attempt < attempts; attempt++) {
      signal?.throwIfAborted();
      const data = await searchJaegerTraces(base, query, {
        fetchImpl: request,
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
          : AbortSignal.timeout(10000),
      });
      signal?.throwIfAborted();
      traceID = selectCommandTrace(data, expected);
      if (traceID) break;
      if (attempt + 1 < attempts) await wait(1000, undefined, { signal });
    }
    assert(traceID, "actual Workspace request trace missing");
  }
  assert.match(
    traceID ?? "",
    /^[a-f0-9]{32}$/u,
    "actual Gateway trace ID missing",
  );
  await onSelected?.(traceID);
  signal?.throwIfAborted();
  const [result] = await collectResolveTraceEvidence(
    base,
    [{ ...expected, traceID }],
    secrets,
    {
      ...options,
      inspect: async (trace, selected, privateValues, collection) => {
        const resolution = inspectWorkspaceRequestResolution(
          trace,
          selected,
          privateValues,
          collection,
        );
        const checked = await inspect(
          trace,
          selected,
          privateValues,
          requests.filter((item) => item.trace_id === trace.traceID),
        );
        return { ...checked, gateway_resolution: resolution };
      },
    },
  );
  return result;
}
