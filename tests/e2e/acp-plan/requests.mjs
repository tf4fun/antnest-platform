import assert from "node:assert/strict";
import { inspectRuntimeInformationRead } from "../observability/runtime-information-read.mjs";
import {
  assertPrivateACPApplicationJoined,
  privateACPDiagnosticView,
  privateACPRejection,
} from "../observability/private-acp-diagnostics.mjs";
import { assertSessionSuccess } from "../identity-closeout/session-diagnostics.mjs";
import { searchJaegerTraces } from "../../support/jaeger-search.mjs";
import { setTimeout as delay } from "node:timers/promises";
import { collectTrace } from "../managed-mcp/trace.mjs";
import { assertSecretFree } from "../identity-closeout/evidence.mjs";
import {
  assertCaptureDisabled,
  traceTopology,
  tag,
} from "../observability/trace-tree.mjs";

// Only an explicit private-boundary inspection can attach this proof. Callers
// must not infer private transport merely because Gateway spans are absent.
const privateConnections = new WeakMap();

export function requestBoundaryKind(expected) {
  const kind = expected.boundary === undefined ? "gateway" : expected.boundary;
  assert(["gateway", "private-acp"].includes(kind), "unknown ACP boundary");
  return kind;
}

// Full raw diagnostics include events and numeric OTel status codes that the
// older request-specific error checks do not use.
const diagnosticFields = (span) => [
  ...(span.tags ?? []),
  ...(span.logs ?? []).flatMap((event) => event.fields ?? []),
];
export function hasDiagnosticError(span) {
  return (
    hasError(span) ||
    diagnosticFields(span).some(
      ({ key, value }) =>
        (key === "error" && value === true) ||
        (/^(error\.|exception\.|antnest\.error\.)/u.test(key) &&
          !(key === "error.type" && value === "")) ||
        (key === "otel.status_code" && ["ERROR", 2].includes(value)) ||
        (key === "antnest.outcome" &&
          ["rejected", "error", "failed", "failure"].includes(value)) ||
        (key === "event" &&
          ["error", "exception", "antnest.error"].includes(value)),
    )
  );
}

// Cancellation alone is not a raw error, but a successful private upgrade
// must also exclude cancelled exchanges from its connection proof.
export const hasPrivateACPError = (span) =>
  hasDiagnosticError(span) ||
  diagnosticFields(span).some(
    ({ key, value }) => key === "antnest.outcome" && value === "cancelled",
  );

function privateACPProcessIdentity(trace, span) {
  const resource = trace.processes?.[span.processID];
  assert.equal(resource?.serviceName, "agent-acp-service");
  const values = new Map();
  for (const { key, value } of resource.tags ?? []) {
    assert(!values.has(key), "duplicate private ACP resource attribute");
    values.set(key, value);
  }
  for (const key of ["host.name", "service.instance.id"])
    assert(
      typeof values.get(key) === "string" && values.get(key).length > 0,
      "private ACP process identity missing",
    );
  const pid = values.get("process.pid");
  assert(
    Number.isSafeInteger(pid) && pid > 0,
    "private ACP process PID missing",
  );
  return [values.get("host.name"), pid, values.get("service.instance.id")];
}

export function inspectPrivateACPConnection(expected, secrets = []) {
  assert.equal(requestBoundaryKind(expected), "private-acp");
  assert.equal(expected.transport, "websocket");
  assert([1, 2].includes(expected.protocolVersion));
  for (const key of ["agentId", "requestId", "method"])
    assert(typeof expected[key] === "string" && expected[key].length > 0);
  const mayOmitSession =
    ["initialize", "session/list"].includes(expected.method) ||
    (expected.method === "session/new" &&
      (expected.denial === "access_denied" ||
        expected.rejection === "access_denied"));
  if (expected.sessionId !== undefined || !mayOmitSession)
    assert(
      typeof expected.sessionId === "string" &&
        expected.sessionId.trim().length > 0,
      "actual Session identity required for private request",
    );
  assert.match(expected.connectionTraceID ?? "", /^[a-f0-9]{32}$/u);
  for (const key of ["connectionSpanID", "clientSpanID"])
    assert.match(expected[key] ?? "", /^[a-f0-9]{16}$/u);
  const raw = expected.connectionTrace;
  assert.equal(
    raw?.traceID,
    expected.connectionTraceID,
    "actual upgrade raw required",
  );
  const tree = traceTopology(raw);
  assertCaptureDisabled(raw);
  assertSecretFree(JSON.stringify(raw), secrets);
  assert(
    !raw.spans.some(hasPrivateACPError),
    "private upgrade contains an error",
  );
  const roots = raw.spans.filter((span) => !tree.parent(span));
  assert.equal(
    roots.length,
    1,
    "private upgrade requires one exported CLIENT root",
  );
  const client = roots[0];
  assert.equal(client.spanID, expected.clientSpanID);
  assert.equal(tree.service(client), "antnest-private-acp-client");
  assert.equal(client.operationName, "HTTP GET agent-acp-workspace");
  assert.equal(tag(client, "span.kind"), "client");
  assert.equal(tag(client, "http.request.method"), "GET");
  assert.equal(tag(client, "http.response.status_code"), 101);
  const route = `/v${expected.protocolVersion}/acp`;
  const upgrades = raw.spans.filter(
    (span) =>
      tree.service(span) === "agent-acp-service" &&
      tag(span, "span.kind") === "server" &&
      tag(span, "http.request.method") === "GET" &&
      tag(span, "http.route") === route,
  );
  assert.equal(upgrades.length, 1, "missing or duplicate actual ACP upgrade");
  const server = upgrades[0];
  assert.equal(server.spanID, expected.connectionSpanID);
  assert.equal(server.operationName, `HTTP GET ${route}`);
  assert.equal(
    tree.parent(server),
    client,
    "upgrade detached from actual CLIENT",
  );
  assert.equal(tag(server, "antnest.listener"), "workspace");
  assert.equal(tag(server, "http.response.status_code"), 101);
  const processIdentity = privateACPProcessIdentity(raw, server);
  return { raw, tree, client, server, processIdentity };
}

function privateRequestMatches(trace, span, expected) {
  return (
    trace.processes?.[span.processID]?.serviceName === "agent-acp-service" &&
    tag(span, "span.kind") === "server" &&
    tag(span, "rpc.method") === expected.method &&
    tag(span, "antnest.request.id") === expected.requestId &&
    tag(span, "antnest.agent.id") === expected.agentId &&
    tag(span, "antnest.session.id") === expected.sessionId &&
    (expected.method !== "session/new" ||
      expected.sessionId !== undefined ||
      (tag(span, "antnest.outcome") === "rejected" &&
        tag(span, "rpc.response.status_code") === -32020 &&
        tag(span, "antnest.error.code") === "-32020")) &&
    tag(span, "antnest.protocol.version") === `v${expected.protocolVersion}` &&
    span.references?.some(
      (ref) =>
        ref.refType === "FOLLOWS_FROM" &&
        ref.traceID === expected.connectionTraceID &&
        ref.spanID === expected.connectionSpanID,
    )
  );
}

export function requestBoundary(trace, expected, secrets = []) {
  const tree = traceTopology(trace);
  assertCaptureDisabled(trace);
  assertSecretFree(JSON.stringify(trace), secrets);
  if (requestBoundaryKind(expected) === "private-acp") {
    const connection = inspectPrivateACPConnection(expected, secrets);
    const roots = trace.spans.filter((span) => !tree.parent(span));
    assert.equal(roots.length, 1, "private request requires one ACP root");
    const request = roots[0];
    assert(
      privateRequestMatches(trace, request, expected),
      "wrong private request boundary",
    );
    assert.deepEqual(
      privateACPProcessIdentity(trace, request),
      connection.processIdentity,
      "private request process resource differs from its actual upgrade",
    );
    const links = request.references.filter(
      (ref) => ref.refType === "FOLLOWS_FROM",
    );
    assert.equal(
      links.length,
      1,
      "private request has ambiguous connection Links",
    );
    assert.equal(
      trace.spans.filter((span) => privateRequestMatches(trace, span, expected))
        .length,
      1,
      "duplicate private ACP request",
    );
    privateConnections.set(tree, connection);
    return { tree, root: request, request, connection };
  }
  assert(
    expected.agentId && expected.connectionTraceID,
    "actual request identity required",
  );
  const roots = trace.spans.filter((span) => !tree.parent(span));
  assert.equal(roots.length, 1, "missing or duplicate Gateway root");
  const root = roots[0];
  assert.equal(tree.service(root), "edge-gateway");
  assert.equal(tag(root, "rpc.method"), expected.method);
  assert.equal(tag(root, "span.kind"), "server");
  assert(
    root.references.some(
      (ref) =>
        ref.refType === "FOLLOWS_FROM" &&
        ref.traceID === expected.connectionTraceID,
    ),
    "request not linked to actual connection",
  );
  const requests = trace.spans.filter(
    (span) =>
      tree.service(span) === "agent-acp-service" &&
      tag(span, "span.kind") === "server" &&
      tag(span, "rpc.method") === expected.method,
  );
  assert.equal(requests.length, 1, "missing or duplicate ACP request");
  const request = requests[0];
  assert.equal(tag(request, "antnest.session.id"), expected.sessionId);
  assert.equal(tag(request, "antnest.agent.id"), expected.agentId);
  const forwarded = tree.parent(request);
  assert.equal(tree.service(forwarded), "edge-gateway");
  assert.equal(tag(forwarded, "span.kind"), "producer");
  assert.equal(tag(forwarded, "antnest.operation.phase"), "forward");
  assert.equal(tree.parent(forwarded), root);
  return { tree, root, request, forwarded };
}
export const hasError = (span) =>
  tag(span, "error") === true ||
  tag(span, "otel.status_code") === "ERROR" ||
  tag(span, "antnest.outcome") === "rejected" ||
  tag(span, "antnest.outcome") === "error" ||
  span.logs?.some((event) =>
    event.fields?.some((field) => field.value === "antnest.error"),
  );
// A v1 prompt answers only after its Run; when the client has already closed
// the socket, the completed Run's response dispatch fails by itself.
export const closedV1PromptResponse = (span, request) =>
  span === request &&
  tag(span, "rpc.method") === "session/prompt" &&
  tag(span, "antnest.protocol.version") === "v1" &&
  tag(span, "antnest.outcome") === "error" &&
  tag(span, "antnest.operation.phase") === "acp.dispatch";
export function timingEvidence(trace, tree, request, forwarded) {
  const connection = privateConnections.get(tree);
  const sources = [
    { trace, tree },
    ...(connection ? [{ trace: connection.raw, tree: connection.tree }] : []),
  ];
  const warnings = [
    ...sources.flatMap(({ trace: source }) => [
      ...(source.warnings ?? []),
      ...source.spans.flatMap((span) => span.warnings ?? []),
    ]),
  ];
  return {
    ...(connection
      ? {
          transport_boundary: "private-acp",
          source_trace_ids: [connection.raw.traceID],
          connection_span_id: connection.server.spanID,
        }
      : {}),
    warning_count: warnings.length,
    warnings: [...new Set(warnings)],
    strict_trace: warnings.length ? "failed" : "passed",
    timing: connection
      ? {
          acp_start_minus_upgrade_us:
            request.startTime - connection.server.startTime,
        }
      : { acp_start_minus_gateway_us: request.startTime - forwarded.startTime },
    warning_edges: sources.flatMap(({ trace: source, tree }) =>
      source.spans.flatMap((span) => {
        const parent = tree.parent(span);
        if (
          !span.warnings?.length ||
          !parent ||
          tree.service(span) === tree.service(parent)
        )
          return [];
        return [
          {
            ...(connection ? { trace_id: source.traceID } : {}),
            service: tree.service(span),
            operation: span.operationName,
            parent_service: tree.service(parent),
            parent_operation: parent.operationName,
            warnings: [...new Set(span.warnings)],
            child_start_minus_parent_us: span.startTime - parent.startTime,
            child_end_minus_parent_us:
              span.startTime +
              span.duration -
              parent.startTime -
              parent.duration,
          },
        ];
      }),
    ),
  };
}
// Session setup and replay may read the Runtime Skill catalog; nothing else.
export function inspectCatalogRuntime(trace, tree, request, expected) {
  const reads = trace.spans.filter(
    (span) => span.operationName === "mcp.runtime.info.read",
  );
  const runtime = trace.spans.filter(
    (span) => tree.service(span) === "antnest-runtime",
  );
  const clients = trace.spans.filter(
    (span) =>
      tree.service(span) === "agent-acp-service" &&
      (span.operationName === "HTTP POST antnest-runtime" ||
        tag(span, "peer.service") === "antnest-runtime"),
  );
  if (!reads.length && !runtime.length && !clients.length)
    return {
      informationReads: 0,
      spans: new Set(),
      neutralDiagnostics: [],
      timeObservations: [],
    };
  assert(
    !expected.rejection &&
      [
        "initialize",
        "session/new",
        "session/load",
        "session/fork",
        "session/resume",
        "session/prompt",
      ].includes(expected.method),
    "request cannot refresh Skill catalog",
  );
  assert.equal(reads.length, 1, "missing or repeated parsed catalog read");
  const proof = inspectRuntimeInformationRead(trace, reads[0]);
  assert.equal(
    proof.request,
    request,
    "catalog read detached from its direct ACP request",
  );
  assert.equal(
    proof.agentId,
    tag(request, "antnest.agent.id"),
    "catalog read belongs to another Agent",
  );
  if (expected.agentId !== undefined)
    assert.equal(proof.agentId, expected.agentId);
  const spans = new Set(proof.spans);
  for (const span of [...reads, ...runtime, ...clients])
    assert(
      spans.has(span),
      "unexpected Runtime work outside parsed catalog read",
    );
  return {
    informationReads: 1,
    spans,
    neutralDiagnostics: proof.neutralDiagnostics,
    timeObservations: proof.timeObservations,
  };
}

function privateSessionApplication(
  trace,
  tree,
  request,
  expected,
  timeObservations,
  diagnosticOwner,
) {
  const input = expected.inputSessionID;
  if (["initialize", "session/new"].includes(expected.method))
    assert.equal(input, null, "new/initialize must have no input Session");
  else
    assert(
      typeof input === "string" && input.trim().length > 0,
      "actual input Session required",
    );
  if (expected.method === "initialize") {
    assert.equal(expected.sessionId, undefined);
    assert.equal(expected.denial, undefined);
    return;
  }
  const method =
    expected.method === "session/load"
      ? "resume"
      : expected.method.split("/")[1];
  const applications = trace.spans.filter(
    (span) =>
      tree.service(span) === "agent-acp-service" &&
      span.operationName === `acp.session.${method}`,
  );
  assert.equal(
    applications.length,
    1,
    "one original Plan application request required",
  );
  const application = applications[0];
  assert.equal(
    tree.parent(application),
    request,
    "Plan application belongs to another RPC",
  );
  assert.deepEqual(
    privateACPProcessIdentity(trace, application),
    privateACPProcessIdentity(trace, request),
  );
  if (!expected.denial)
    assertPrivateACPApplicationJoined(
      trace,
      request,
      application,
      timeObservations,
      `${diagnosticOwner}-application-joined-by-rpc`,
    );
  assert.equal(tag(application, "span.kind"), "internal");
  for (const key of ["agent.id", "antnest.agent.id"])
    assert.equal(tag(application, key), expected.agentId);
  for (const key of ["session.id", "antnest.session.id"])
    assert.equal(
      tag(application, key),
      input ?? undefined,
      "Plan application input Session mismatch",
    );
  if (expected.method === "session/fork" && !expected.denial)
    assert.notEqual(expected.sessionId, input, "fork reused its input Session");
  else if (expected.method !== "session/new")
    assert.equal(
      expected.sessionId,
      input,
      "replay/denial changed its input Session",
    );
}

export function inspectSessionRequestTrace(
  trace,
  expected,
  secrets = [],
  { strictPrivate = false, diagnosticOwner = "plan" } = {},
) {
  assert(["plan", "files"].includes(diagnosticOwner));
  if (strictPrivate) {
    assert.equal(requestBoundaryKind(expected), "private-acp");
    assert.equal(
      expected.rejection,
      undefined,
      "Plan uses its own denial receipt",
    );
    assert.notEqual(
      expected.closedBeforeResponse,
      true,
      "Plan must finish its original request",
    );
  }
  assert(
    [
      "session/load",
      "session/resume",
      "session/fork",
      "session/new",
      ...(strictPrivate ? ["initialize"] : []),
    ].includes(expected.method),
  );
  assert(
    expected.method !== "session/new" ||
      expected.denial === "access_denied" ||
      strictPrivate,
  );
  assert(
    expected.denial === undefined ||
      ["access_denied", "session_access_denied"].includes(expected.denial),
  );
  const { tree, request, forwarded } = requestBoundary(
    trace,
    expected,
    secrets,
  );
  if (expected.denial) {
    assert.equal(
      tag(request, "rpc.response.status_code"),
      -32020,
      "denial response missing",
    );
    assert.equal(tag(request, "antnest.outcome"), "rejected");
  }
  const catalog = inspectCatalogRuntime(trace, tree, request, {
    method: expected.method,
    rejection: expected.denial,
  });
  let denialProof;
  if (strictPrivate) {
    privateSessionApplication(
      trace,
      tree,
      request,
      expected,
      catalog.timeObservations,
      diagnosticOwner,
    );
    for (const span of expected.connectionTrace.spans)
      assertSessionSuccess(span);
    denialProof = expected.denial
      ? privateACPRejection(
          trace,
          tree,
          request,
          { ...expected, rejection: expected.denial },
          catalog.timeObservations,
        )
      : { views: new Map(), records: [] };
  }
  for (const span of trace.spans) {
    assert(
      catalog.spans.has(span) ||
        !/^(agent\.run$|model\.|mcp\.|HTTP POST model$)/.test(
          span.operationName,
        ),
      "non-execution request executed work",
    );
    if (strictPrivate) {
      const view = privateACPDiagnosticView(
        trace,
        span,
        catalog.neutralDiagnostics,
        catalog.spans,
      );
      assertSessionSuccess(denialProof.views.get(span) ?? view);
      continue;
    }
    if (!hasError(span)) continue;
    assert(expected.denial, "successful replay failed");
    assert.equal(tree.service(span), "agent-acp-service");
    assert.equal(
      tag(span, "antnest.outcome"),
      "rejected",
      "unexpected failure during denial",
    );
    assert(tree.chain(span).includes(request), "error outside denied request");
    if (span === request)
      assert.equal(tag(span, "antnest.error.code"), "-32020");
    else {
      const operation = {
        "session/load": "resume",
        "session/resume": "resume",
        "session/fork": "fork",
        "session/new": "new",
      }[expected.method];
      assert.equal(span.operationName, `acp.session.${operation}`);
      assert.equal(tag(span, "error.type"), "DomainError");
      // session_access_denied is deliberately absent from the telemetry code allowlist.
      // The wire response is checked separately for its exact generic denial.
      assert.equal(
        tag(span, "antnest.error.code"),
        expected.denial === "access_denied" ? "access_denied" : undefined,
      );
    }
  }
  return {
    trace_id: trace.traceID,
    method: expected.method,
    session_id: expected.sessionId,
    agent_id: expected.agentId,
    spans: trace.spans.length,
    no_execution: true,
    runtime_information_reads: catalog.informationReads,
    neutral_diagnostics: catalog.neutralDiagnostics,
    time_observations: catalog.timeObservations,
    ...(strictPrivate
      ? {
          input_session_id: expected.inputSessionID,
          owned_error_spans: denialProof.records.map((record) => ({
            ...record,
            reason: `${diagnosticOwner}-rejection`,
          })),
        }
      : {}),
    ...(expected.denial ? { denial: expected.denial } : {}),
    ...timingEvidence(trace, tree, request, forwarded),
  };
}

// Non-executing ACP methods share one wire contract across consumer suites.
// Each owner keeps its own exact diagnostic inventory label.
export function inspectPlanRequestTrace(
  trace,
  expected,
  secrets = [],
  options = {},
) {
  return inspectSessionRequestTrace(trace, expected, secrets, {
    ...options,
    diagnosticOwner: "plan",
  });
}

export function inspectPrivatePlanRequestTrace(trace, expected, secrets = []) {
  return inspectPlanRequestTrace(trace, expected, secrets, {
    strictPrivate: true,
  });
}
export function selectRequestTrace(data, expected) {
  assert(
    Array.isArray(data) && data.length < 100,
    "request trace query invalid or truncated",
  );
  if (requestBoundaryKind(expected) === "private-acp") {
    inspectPrivateACPConnection(expected);
    const matches = data.flatMap((trace) =>
      (trace.spans ?? [])
        .filter((span) => privateRequestMatches(trace, span, expected))
        .map(() => trace.traceID),
    );
    assert(
      matches.length <= 1,
      "ambiguous private request on actual connection",
    );
    return matches[0];
  }
  const matches = data.filter((trace) =>
    trace.spans?.some(
      (span) =>
        trace.processes?.[span.processID]?.serviceName === "edge-gateway" &&
        tag(span, "span.kind") === "server" &&
        tag(span, "rpc.method") === expected.method &&
        span.references?.some(
          (ref) =>
            ref.refType === "FOLLOWS_FROM" &&
            ref.traceID === expected.connectionTraceID,
        ),
    ),
  );
  assert(matches.length <= 1, "ambiguous request trace on actual connection");
  return matches[0]?.traceID;
}
export async function collectPlanRequestTrace(
  base,
  expected,
  secrets = [],
  signal,
) {
  const query = new URLSearchParams({
    service: "agent-acp-service",
    limit: "100",
    lookback: "1h",
    tags: JSON.stringify({
      "rpc.method": expected.method,
      "antnest.agent.id": expected.agentId,
      ...(expected.sessionId
        ? { "antnest.session.id": expected.sessionId }
        : {}),
    }),
  });
  for (let attempt = 0; attempt < 40; attempt++) {
    signal?.throwIfAborted();
    const data = await searchJaegerTraces(base, query, {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(5000)])
        : AbortSignal.timeout(5000),
    });
    const id = selectRequestTrace(data, expected);
    if (id)
      return collectTrace(
        base,
        id,
        (trace) => inspectPlanRequestTrace(trace, expected, secrets),
        signal,
      );
    await delay(1000, undefined, { signal });
  }
  throw new Error("actual request trace missing");
}
