import assert from "node:assert/strict";
import {
  chatRequestBoundary,
  inspectWorkspaceChatTrace,
} from "./chat-trace.mjs";
import { assertWorkspaceResolveReceipt } from "./request-trace.mjs";
import {
  inspectGatewayResolution,
  assertGatewayResolutionAttributes,
} from "../../support/gateway-resolution.mjs";
import {
  resolveTraceSources,
  resolveTraceDiagnostics,
} from "../../support/gateway-resolution-evidence.mjs";
import { inspectRunInformationReads } from "../observability/runtime-information-run.mjs";
import {
  privateACPDiagnosticView,
  privateACPProcessIdentity,
  assertPrivateACPApplicationJoined,
} from "../observability/private-acp-diagnostics.mjs";
import { assertSessionSuccess } from "../identity-closeout/session-diagnostics.mjs";
import { assertRuntimeBinding } from "../acp-restart/trace.mjs";
import {
  nativeFinishQuery,
  nativeBoundaryFailure,
  nativeBefore,
} from "../acp-multimodal/private-trace.mjs";
import { tag } from "../observability/trace-tree.mjs";

const one = (spans, label) => {
  assert.equal(spans.length, 1, `one original C4 ${label} required`);
  return spans[0];
};
const normalize = (sql) => sql?.replace(/\s+/gu, " ").trim();

function originalReceipt(expected) {
  const receipt = expected.receipt;
  assert(receipt, "original page Prompt receipt required");
  for (const [key, value] of Object.entries({
    method: "POST",
    status: 202,
    original_browser_authority: true,
    traceID: expected.traceID,
    agentId: expected.agentId,
    sessionId: expected.sessionId,
    phase: expected.phase,
  }))
    assert.equal(receipt[key], value);
  assert.equal(
    receipt.path,
    `/api/app/workspace/v1/agents/${encodeURIComponent(expected.agentId)}/sessions/${encodeURIComponent(expected.sessionId)}/prompts`,
  );
  assert.deepEqual(JSON.parse(receipt.request.rawBody), receipt.request.body);
  assert.deepEqual(receipt.request.body.prompt, expected.run.input);
  assert.deepEqual(JSON.parse(receipt.rawBody), receipt.body);
  assert.deepEqual(receipt.body, {
    operationId: receipt.request.body.intentId,
    acceptance: "bridge",
    phase: "dispatching",
  });
}

function audioFailure(trace, expected, { tree, prompt, run }, models, clients) {
  assert.deepEqual(expected.requests, [], "audio refusal reached the Provider");
  assert.equal(clients.length, 0, "audio refusal reached the Provider");
  const model = one(models, "audio model attempt");
  assert.equal(expected.run.state, "failed");
  assert.equal(expected.run.error_class, "model_unsupported_content");
  const views = new Map([
    [
      model,
      nativeBoundaryFailure(
        model,
        "ModelError",
        "model_unsupported_content",
        "model.complete",
      ),
    ],
    [
      prompt,
      nativeBoundaryFailure(prompt, "RequestError", -32022, "acp.dispatch"),
    ],
  ]);
  assert.equal(tag(run, "antnest.operation.phase"), "execute");
  assert.equal(
    new Set(run.tags.map(({ key }) => key)).size,
    run.tags.length,
    "duplicate C4 audio Run field",
  );
  assert.equal(tag(run, "antnest.outcome"), "failed");
  assert.equal(tag(run, "error.type"), "run_failed");
  assert(["ERROR", 2].includes(tag(run, "otel.status_code")));
  assert([undefined, true].includes(tag(run, "error")));
  views.set(run, {
    ...run,
    tags: run.tags.filter(
      ({ key }) =>
        ![
          "antnest.outcome",
          "error.type",
          "otel.status_code",
          "error",
        ].includes(key),
    ),
  });
  return {
    views,
    owned_error_spans: [model, run, prompt].map((span) => ({
      trace_id: trace.traceID,
      span_id: span.spanID,
      service: tree.service(span),
      operation: span.operationName,
      reason: "multimodal-model-unsupported-content",
    })),
  };
}

export function inspectC4RunTrace(trace, expected, secrets = [], options = {}) {
  assert.equal(trace.traceID, expected.traceID);
  assert.equal(expected.bridge, true);
  assert.equal(expected.kind, "c4_run");
  assert.equal(expected.run?.run_id, expected.runId);
  assert.equal(expected.run.agent_id, expected.agentId);
  assert.equal(expected.run.session_id, expected.sessionId);
  originalReceipt(expected);
  const sources = resolveTraceSources(trace, secrets, options);
  for (const source of sources) assertGatewayResolutionAttributes(source);
  const boundary = chatRequestBoundary(trace, expected),
    { tree, root, upstream, prompt, run } = boundary,
    audio = expected.phase === "c4-browser-unsupported-audio";
  assert.equal(tag(prompt, "antnest.agent.id"), expected.agentId);
  assert.equal(tag(prompt, "antnest.protocol.version"), "v1");
  assert.equal(tag(run, "antnest.run.id"), expected.runId);
  for (const [key, value] of Object.entries({
    "antnest.runtime.revision": expected.runtime.runtime_revision,
    "antnest.runtime.execution_id": expected.runtime.runtime_execution_id,
    "antnest.execution.revision":
      expected.run.execution_snapshot.executionRevision,
  }))
    assert.equal(tag(run, key), value);
  for (const key of ["terminal_class", "executor_state", "tool_effect_state"])
    assert.equal(tag(run, "run." + key), expected.run[key]);
  for (const span of [root, upstream]) {
    assert.equal(tag(span, "http.request.method"), "POST");
    assert.equal(Number(tag(span, "http.response.status_code")), 202);
  }
  const decision = one(
      trace.spans.filter(
        (span) => span.operationName === "gateway.identity.resolve",
      ),
      "Bridge Resolve decision",
    ),
    resolution = inspectGatewayResolution(
      trace,
      {
        rootSpanID: root.spanID,
        upstreamSpanID: upstream.spanID,
        decisionSpanID: decision.spanID,
        profile: "workspace",
        ttlMs: expected.resolveTTLMS ?? 10000,
      },
      options,
    );
  assertWorkspaceResolveReceipt(trace, resolution, options);
  const acp = (name) =>
      trace.spans.filter(
        (span) =>
          tree.service(span) === "agent-acp-service" &&
          span.operationName === name,
      ),
    models = acp("model.complete"),
    clients = acp("HTTP POST model"),
    finish = one(
      acp("SELECT").filter((span) =>
        /^WITH finished AS \(UPDATE runs\b/iu.test(
          normalize(tag(span, "db.query.text")) ?? "",
        ),
      ),
      "durable Run closure",
    );
  assert.equal(normalize(tag(finish, "db.query.text")), nativeFinishQuery);
  assert.equal(tree.parent(finish), run);
  for (const [key, value] of Object.entries({
    "span.kind": "client",
    "db.system.name": "postgresql",
    "db.namespace": "antnest_agent_acp",
    "db.operation.name": "SELECT",
  }))
    assert.equal(tag(finish, key), value);
  assertSessionSuccess(finish);
  const timeObservations = [];
  assertPrivateACPApplicationJoined(
    trace,
    prompt,
    run,
    timeObservations,
    "c4-run-joined-by-prompt",
  );
  assertPrivateACPApplicationJoined(
    trace,
    run,
    finish,
    timeObservations,
    "c4-finish-joined-by-run",
  );
  for (const model of models) {
    assert.equal(tag(model, "model.name"), expected.modelName);
    assert(tree.chain(model).includes(run));
    assert.deepEqual(
      privateACPProcessIdentity(trace, model),
      privateACPProcessIdentity(trace, run),
    );
    assertPrivateACPApplicationJoined(
      trace,
      run,
      model,
      timeObservations,
      "c4-model-joined-by-run",
    );
    nativeBefore(
      trace,
      timeObservations,
      model,
      finish,
      model.startTime + model.duration,
      finish.startTime,
      "model-before-durable-finish",
    );
  }
  assertRuntimeBinding(trace, expected.run, expected.runtime);
  let informationTrace = trace,
    informationRun = run;
  if (expected.phase === "c4-browser-hold-cancel") {
    assert.equal(expected.requests.length, 1);
    assert.equal(expected.requests[0].stage, "reply");
    assert.equal(expected.requests[0].disconnected, true);
    assert.equal(expected.run.state, "cancelled");
    assert.equal(expected.run.executor_state, "quiescent");
    assert.equal(expected.run.tool_effect_state, "none");
    assert.equal(tag(run, "antnest.outcome"), "cancelled");
    // The original durable Run cancellation belongs to the Chat gate below.
    // Keep its terminal facts and all other fields while the independent
    // Runtime gate checks only its own read/tool cancellation inventory.
    informationRun = {
      ...run,
      tags: run.tags.filter(({ key }) => key !== "antnest.outcome"),
    };
    informationTrace = {
      ...trace,
      spans: trace.spans.map((span) => (span === run ? informationRun : span)),
    };
  }
  const information = inspectRunInformationReads(informationTrace, {
      request: prompt,
      run: informationRun,
      postPromptRequestOutcome: audio ? "failed-v1-run-response" : "success",
    }),
    calls = information.toolLifecycles.filter(
      (proof) => proof.owner.operationName === "mcp.tools.call",
    ),
    actualTools = trace.spans.filter(
      (span) =>
        tree.service(span) === "antnest-runtime" &&
        span.operationName === "runtime.mcp.tool",
    );
  assert.equal(calls.length, expected.toolName ? 1 : 0);
  assert.equal(actualTools.length, calls.length);
  for (const proof of calls) {
    assert.equal(tag(proof.owner, "tool.name"), expected.toolName);
    assert.equal(tag(proof.owner, "antnest.run.id"), expected.runId);
    assert.equal(
      tag(proof.owner, "antnest.mcp.tool_result.outcome"),
      "success",
    );
    assert(tree.chain(actualTools[0]).includes(proof.owner));
  }
  const runtimeSpans = new Set([
      ...information.spans,
      ...information.toolLifecycles.flatMap((proof) => [
        proof.owner,
        ...proof.clients,
        ...proof.servers,
        ...proof.exchanges.map((exchange) => exchange.operation),
      ]),
    ]),
    local = audio
      ? audioFailure(trace, expected, boundary, models, clients)
      : { views: new Map(), owned_error_spans: [] },
    projected = {
      ...trace,
      spans: trace.spans.map(
        (span) =>
          local.views.get(span) ??
          privateACPDiagnosticView(
            trace,
            span,
            information.neutralDiagnostics,
            runtimeSpans,
          ),
      ),
    };
  let checked = {};
  if (audio) for (const span of projected.spans) assertSessionSuccess(span);
  else {
    // This is only a diagnostic validation view after the complete Runtime
    // proof. Archives, inventory, timings and final strict verdict use raw data.
    const traces = new Map(options.traces ?? [[trace.traceID, trace]]);
    traces.set(trace.traceID, projected);
    checked = inspectWorkspaceChatTrace(projected, expected, secrets, {
      ...options,
      traces,
    });
    const cancellation = new Set(
      checked.owned_error_spans.map((claim) => claim.span_id),
    );
    for (const span of projected.spans)
      if (!cancellation.has(span.spanID))
        assertSessionSuccess(
          span,
          span.spanID === run.spanID &&
            expected.phase === "c4-browser-hold-cancel"
            ? { "antnest.outcome": "cancelled" }
            : {},
        );
  }
  return {
    ...checked,
    kind: "c4_run",
    phase: expected.phase,
    trace_id: trace.traceID,
    run_id: expected.runId,
    session_id: expected.sessionId,
    provider_requests: expected.requests.length,
    runtime_tool_calls: calls.length,
    local_failures: audio ? 1 : 0,
    persistence: true,
    gateway_resolution: resolution,
    runtime_information_reads: information.informationReads,
    post_prompt_information_reads: information.postPromptInformationReads,
    neutral_diagnostics: information.neutralDiagnostics,
    time_observations: [...timeObservations, ...information.timeObservations],
    owned_error_spans: [
      ...(checked.owned_error_spans ?? []),
      ...local.owned_error_spans,
    ],
    ...resolveTraceDiagnostics(trace, sources),
  };
}
