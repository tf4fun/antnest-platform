import { randomUUID } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { hostname } from "node:os";
import { context, createContextKey, isSpanContextValid, metrics, propagation, ROOT_CONTEXT,
  SpanKind, SpanStatusCode, trace, type Span } from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { core, NodeSDK, resources, tracing } from "@opentelemetry/sdk-node";
import { SEMCONV } from "./semconv.gen.ts";
import { metricAttributes, normalizeAttributes } from "./telemetry-names.ts";
import type { BridgeRuntimeMetrics } from "./workspace-runtime.ts";
import type { BridgeScope } from "./bridge/registry.ts";
import type { StreamTermination } from "./bridge/stream-journal.ts";
import type { AcpCloseReceipt } from "./adapters/acp-close-diagnostics.ts";

export type BridgeTelemetry = {
  observeHttp(method: string, route: string, work: () => Promise<number>,
    headers?: { traceparent?: string | string[]; tracestate?: string | string[] }): Promise<number>;
  registerRuntimeMetrics(snapshot: () => BridgeRuntimeMetrics): void;
  recordColdReplay(durationMs: number, outcome: "success" | "error"): void;
  recordLocalIntentReuse(outcome: "hit" | "conflict"): void;
  shutdown(): Promise<void>;
};

const HTTP_BOUNDARY = createContextKey("antnest.ui.active-http-boundary");
type PromptInputState = { next: number; bytes: number };
type HttpBoundary = { active: boolean; span: Span; streamDelegationRecorded?: boolean;
  inputDiagnostics: boolean; promptInput?: PromptInputState };
export type PromptInputPhase = "receive-started" | "body-eof" | "body-parsed";
export type PromptInputObserver = (phase: PromptInputPhase, bytes: number) => void;
const promptInputPhases = ["receive-started", "body-eof", "body-parsed", "input-prepared"] as const;
const promptInputChannel = channel("antnest.ui.prompt_input.v1");

function recordPromptInput(boundary: HttpBoundary, state: PromptInputState, phase: string, bytes: number): void {
  try {
    if (!boundary.active || !boundary.inputDiagnostics || !boundary.span.isRecording() ||
      boundary.promptInput !== state || phase !== promptInputPhases[state.next] ||
      !Number.isSafeInteger(bytes) || bytes < 1 || bytes > 64 * 1024 * 1024 ||
      (state.next === 1 && bytes < state.bytes) || (state.next >= 2 && bytes !== state.bytes)) return;
    const monotonic_ns = process.hrtime.bigint().toString();
    boundary.span.addEvent(SEMCONV.ANTNEST_UI_PROMPT_INPUT, { phase, bytes, monotonic_ns });
    state.next++; state.bytes = bytes;
    if ((phase === "receive-started" || phase === "body-eof") && promptInputChannel.hasSubscribers) {
      const source = boundary.span.spanContext();
      if (!isSpanContextValid(source)) return;
      // Advance the phase before notifying; a subscriber cannot repeat this EOF.
      // Subscribers own their errors and must not wait or extend native parsing.
      promptInputChannel.publish(Object.freeze({
        traceId: source.traceId, spanId: source.spanId, processIdentity,
        phase, bytes, monotonic_ns,
      }));
    }
  } catch { /* Diagnostics must not change request outcomes or resource cleanup. */ }
}

/** At most one native Prompt observer, bound to the original live HTTP span. */
export function capturePromptInput(): PromptInputObserver | undefined {
  try {
    const boundary = context.active().getValue(HTTP_BOUNDARY) as HttpBoundary | undefined;
    if (!boundary?.active || !boundary.inputDiagnostics || !boundary.span.isRecording() || boundary.promptInput) return;
    const state: PromptInputState = { next: 0, bytes: 0 };
    boundary.promptInput = state;
    return (phase, bytes) => recordPromptInput(boundary, state, phase, bytes);
  } catch { return; }
}

/** Antnest's wire sizing, canonical digest and intent insertion have returned. */
export function recordPromptInputPrepared(): void {
  try {
    const boundary = context.active().getValue(HTTP_BOUNDARY) as HttpBoundary | undefined;
    if (boundary?.promptInput)
      recordPromptInput(boundary, boundary.promptInput, "input-prepared", boundary.promptInput.bytes);
  } catch { /* An observation cannot turn an accepted intent into an error. */ }
}
const processIdentity = Object.freeze({
  "host.name": hostname(),
  "process.pid": process.pid,
  "service.instance.id": randomUUID(),
});

/** The original verified SSE delegation, never renewed by later requests. */
export function recordStreamDelegation(expiresAtUnixMs: number): void {
  try {
    const boundary = context.active().getValue(HTTP_BOUNDARY) as HttpBoundary | undefined;
    if (boundary?.active !== true || boundary.streamDelegationRecorded || !boundary.span.isRecording()) return;
    const remainingMs = expiresAtUnixMs - Date.now();
    if (!Number.isSafeInteger(expiresAtUnixMs) || expiresAtUnixMs <= 0 ||
      !Number.isSafeInteger(remainingMs) || remainingMs <= 0) return;
    boundary.streamDelegationRecorded = true;
    boundary.span.setAttributes({
      [SEMCONV.ANTNEST_UI_STREAM_DELEGATION_EXPIRES_AT_UNIX_MS]: expiresAtUnixMs,
      [SEMCONV.ANTNEST_UI_STREAM_DELEGATION_REMAINING_MS]: remainingMs,
    });
  } catch { /* Diagnostics never change authentication or stream delivery. */ }
}

const agentViewFailureCodes = new Map([
  ["Bridge owner cleanup failed", "owner_cleanup_failed"],
  ["ACP cleanup failed", "acp_cleanup_failed"],
  ["ACP DELETE cleanup failed", "acp_delete_failed"],
  ["ACP response body cleanup failed", "acp_body_cleanup_failed"],
  ["HTTP response body cleanup failed", "body_cleanup_failed"],
  ["ACP cleanup deadline exceeded", "acp_cleanup_timeout"],
  ["ACP cleanup target has no unique DELETE receipt", "acp_delete_receipt_missing"],
  ["caller_context_invalid", "caller_context_invalid"],
  ["caller_context_scope_conflict", "caller_context_scope_conflict"],
  ["ACP Bridge connection is unavailable", "acp_connection_unavailable"],
  ["Bridge owner is retired", "owner_retired"],
  ["Bridge owner is draining or retired", "owner_draining"],
  ["ACP Agent access was revoked", "agent_access_revoked"],
  ["ACP workspace access is unavailable", "acp_access_unavailable"],
]);

/** Records only fixed classifications; remote exception contents are private. */
export function recordAgentViewFailure(stage: "owner" | "view", cause: unknown): void {
  try {
    const boundary = context.active().getValue(HTTP_BOUNDARY) as HttpBoundary | undefined;
    if (boundary?.active !== true || !boundary.span.isRecording()) return;
    const pending = [cause];
    const causes: string[] = [];
    let truncated = false;
    try {
      while (pending.length && causes.length < 16) {
        const current = pending.shift();
        const message = current instanceof Error ? current.message : undefined;
        causes.push(typeof message === "string" && message.length <= 160
          ? agentViewFailureCodes.get(message) ?? "unknown" : "unknown");
        if (current instanceof AggregateError && Array.isArray(current.errors)) {
          pending.push(...current.errors.slice(0, 16));
          truncated ||= current.errors.length > 16;
        }
        if (current instanceof Error && current.cause !== undefined) pending.push(current.cause);
      }
      truncated ||= pending.length > 0;
    } catch {
      causes.push("classification_failed");
      truncated = true;
    }
    boundary.span.addEvent(SEMCONV.ANTNEST_UI_AGENT_VIEW_FAILURE, {
      stage, causes: causes.slice(0, 16), truncated,
    });
  } catch { /* Diagnostics must preserve the original response and failure. */ }
}

export type AcpCloseTrigger = "requested" | "transport_failure" | "initialization_failure";

export function captureAcpCloseTrace() {
  const boundary = context.active().getValue(HTTP_BOUNDARY) as HttpBoundary | undefined;
  const source = boundary?.active ? boundary.span.spanContext() : undefined;
  return (trigger: AcpCloseTrigger) => {
    const span = trace.getTracer("antnest-agent-ui-bridge").startSpan("agent_ui.acp.close", {
      kind: SpanKind.INTERNAL,
      links: source && isSpanContextValid(source) ? [{ context: source }] : [],
      attributes: { [SEMCONV.ANTNEST_UI_ACP_CLOSE_TRIGGER]: trigger },
    }, ROOT_CONTEXT);
    const closingContext = trace.setSpan(ROOT_CONTEXT, span);
    return {
      fetch(fetchImpl: typeof fetch, input: Parameters<typeof fetch>[0], init?: RequestInit) {
        const headers = new Headers(input instanceof Request ? input.headers : undefined);
        new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
        headers.delete("traceparent");
        headers.delete("tracestate");
        propagation.inject(closingContext, headers, {
          set: (carrier, key, value) => carrier.set(key, value),
        });
        // ROOT_CONTEXT has no HTTP boundary: an old async callback or unrelated
        // request cannot overwrite the actual cleanup parent in bridgeFetch.
        return context.with(closingContext, () => fetchImpl(input, { ...init, headers }));
      },
      finish(outcome: "closed" | "no_target" | "failed", receipt: AcpCloseReceipt) {
        span.setAttribute(SEMCONV.ANTNEST_UI_ACP_CLOSE_OUTCOME, outcome);
        if (outcome === "failed") span.setStatus({ code: SpanStatusCode.ERROR });
        span.setAttributes({
          [SEMCONV.ANTNEST_UI_ACP_CLOSE_TARGET_OBSERVED]: receipt.targetObserved,
          [SEMCONV.ANTNEST_UI_ACP_CLOSE_DELETE_ATTEMPTS]: receipt.deleteAttempts,
          [SEMCONV.ANTNEST_UI_ACP_CLOSE_DELETE_RESPONSES]: receipt.deleteResponses,
          [SEMCONV.ANTNEST_UI_ACP_CLOSE_DELETE_COMPLETED]: receipt.deleteCompleted,
          [SEMCONV.ANTNEST_UI_ACP_CLOSE_DELETE_STATUS]: receipt.deleteStatus,
          [SEMCONV.ANTNEST_UI_ACP_CLOSE_PENDING_REQUESTS]: receipt.pendingRequests,
          [SEMCONV.ANTNEST_UI_ACP_CLOSE_STREAM_JOINED]: receipt.streamJoined,
          [SEMCONV.ANTNEST_UI_ACP_CLOSE_FAILURES]: receipt.failures.count,
          [SEMCONV.ANTNEST_UI_ACP_CLOSE_DIAGNOSTICS_TRUNCATED]: receipt.failures.truncated,
        });
        for (const failure of receipt.failures.entries)
          span.addEvent(SEMCONV.ANTNEST_UI_ACP_CLOSE_FAILURE, failure);
        span.end();
      },
    };
  };
}

export function captureStreamTermination(scope: BridgeScope): (value: unknown) => void {
  const boundary = context.active().getValue(HTTP_BOUNDARY) as HttpBoundary | undefined;
  const { organizationId, principalId, agentId } = scope;
  let recorded = false;
  return value => {
    if (recorded || boundary?.active !== true || !boundary.span.isRecording() ||
      value === null || typeof value !== "object") return;
    const cause = value as Partial<StreamTermination>;
    if (cause.reason !== "access_denied" || cause.source !== "agent-execution-state" ||
      cause.organizationId !== organizationId || cause.principalId !== principalId ||
      cause.agentId !== agentId) return;
    recorded = true;
    boundary.span.addEvent(SEMCONV.ANTNEST_STREAM_TERMINATION, normalizeAttributes({
      reason: "access_denied", source: "agent-execution-state",
      [SEMCONV.ANTNEST_ORGANIZATION_ID]: organizationId,
      [SEMCONV.ANTNEST_PRINCIPAL_ID]: principalId, [SEMCONV.ANTNEST_AGENT_ID]: agentId,
    }));
  };
}

export function withActiveHttpTrace(fetchImpl: typeof fetch): typeof fetch {
  return (input, init) => {
    const boundary = context.active().getValue(HTTP_BOUNDARY) as HttpBoundary | undefined;
    if (boundary?.active !== true) return fetchImpl(input, init);
    const carrier: Record<string, string> = {};
    propagation.inject(context.active(), carrier, {
      set: (target, key, value) => { target[key] = value; },
    });
    if (!carrier.traceparent) return fetchImpl(input, init);
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
    for (const [name, value] of Object.entries(carrier)) headers.set(name, value);
    return fetchImpl(input, { ...init, headers });
  };
}

export async function startBridgeTelemetry(config: {
  disabled: boolean;
  endpoint?: URL;
  serviceName: string;
}): Promise<BridgeTelemetry> {
  let sdk: NodeSDK | undefined;
  if (!config.disabled && config.endpoint) {
    sdk = new NodeSDK({
      serviceName: config.serviceName,
      // Last detector wins: deployment attributes remain, but process identity
      // cannot be supplied by the environment or repeated on a PID 1 restart.
      resourceDetectors: [resources.envDetector, resources.processDetector,
        resources.hostDetector, { detect: () => ({ attributes: processIdentity }) }],
      textMapPropagator: new core.W3CTraceContextPropagator(),
      spanProcessors: [new tracing.BatchSpanProcessor(
        new OTLPTraceExporter({ url: signalUrl(config.endpoint, "traces"), timeoutMillis: 5_000 }),
        { exportTimeoutMillis: 5_000 },
      )],
      metricReaders: [new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: signalUrl(config.endpoint, "metrics"), timeoutMillis: 5_000 }),
        exportIntervalMillis: 60_000,
        exportTimeoutMillis: 5_000,
      })],
    });
    sdk.start();
  }
  const tracer = trace.getTracer(config.serviceName);
  const meter = metrics.getMeter(config.serviceName);
  const requests = meter.createCounter(SEMCONV.ANTNEST_UI_HTTP_REQUESTS);
  const duration = meter.createHistogram(SEMCONV.ANTNEST_UI_HTTP_DURATION, { unit: "ms" });
  const coldReplayDuration = meter.createHistogram(SEMCONV.ANTNEST_UI_BRIDGE_COLD_REPLAY_DURATION, {
    unit: "ms",
  });
  const localIntentReuse = meter.createCounter(SEMCONV.ANTNEST_UI_BRIDGE_LOCAL_INTENT_REUSE);
  let runtimeMetricsRegistered = false;
  let closing: Promise<void> | undefined;
  return {
    recordColdReplay(durationMs, outcome) {
      coldReplayDuration.record(durationMs, metricAttributes({ outcome }));
    },
    recordLocalIntentReuse(outcome) {
      localIntentReuse.add(1, metricAttributes({ outcome }));
    },
    registerRuntimeMetrics(snapshot) {
      if (runtimeMetricsRegistered) throw new Error("Bridge runtime metrics already registered");
      runtimeMetricsRegistered = true;
      const owners = meter.createObservableGauge(SEMCONV.ANTNEST_UI_BRIDGE_OWNERS);
      const observers = meter.createObservableGauge(SEMCONV.ANTNEST_UI_BRIDGE_OBSERVER_LEASES);
      const work = meter.createObservableGauge(SEMCONV.ANTNEST_UI_BRIDGE_HELD_WORK);
      const cached = meter.createObservableGauge(SEMCONV.ANTNEST_UI_BRIDGE_CACHED_HISTORY_BYTES, { unit: "By" });
      const subscribers = meter.createObservableGauge(SEMCONV.ANTNEST_UI_BRIDGE_STREAM_SUBSCRIBERS);
      const queued = meter.createObservableGauge(SEMCONV.ANTNEST_UI_BRIDGE_JOURNAL_QUEUED_BYTES, { unit: "By" });
      const retained = meter.createObservableGauge(SEMCONV.ANTNEST_UI_BRIDGE_JOURNAL_RETAINED_BYTES, { unit: "By" });
      const activeReplays = meter.createObservableGauge(SEMCONV.ANTNEST_UI_BRIDGE_ACTIVE_REPLAYS);
      const queuedReplays = meter.createObservableGauge(SEMCONV.ANTNEST_UI_BRIDGE_QUEUED_REPLAYS);
      const uncertainOperations = meter.createObservableGauge(SEMCONV.ANTNEST_UI_BRIDGE_UNCERTAIN_OPERATIONS);
      const oldestUncertainMs = meter.createObservableGauge(SEMCONV.ANTNEST_UI_BRIDGE_OLDEST_UNCERTAIN_MS, { unit: "ms" });
      const heap = meter.createObservableGauge(SEMCONV.ANTNEST_UI_PROCESS_HEAP_USED_BYTES, { unit: "By" });
      const rss = meter.createObservableGauge(SEMCONV.ANTNEST_UI_PROCESS_RSS_BYTES, { unit: "By" });
      meter.addBatchObservableCallback((result) => {
        const state = snapshot();
        const memory = process.memoryUsage();
        result.observe(owners, state.owners);
        result.observe(observers, state.observerLeases);
        result.observe(work, state.heldWork);
        result.observe(cached, state.cachedBytes);
        result.observe(subscribers, state.streamSubscribers);
        result.observe(queued, state.journalQueuedBytes);
        result.observe(retained, state.journalRetainedBytes);
        result.observe(activeReplays, state.activeReplays);
        result.observe(queuedReplays, state.queuedReplays);
        result.observe(uncertainOperations, state.uncertainOperations);
        result.observe(oldestUncertainMs, state.oldestUncertainMs);
        result.observe(heap, memory.heapUsed);
        result.observe(rss, memory.rss);
      }, [owners, observers, work, cached, subscribers, queued, retained,
        activeReplays, queuedReplays, uncertainOperations, oldestUncertainMs, heap, rss]);
    },
    observeHttp(method, route, work, headers = {}) {
      const parent = propagation.extract(ROOT_CONTEXT, headers, {
        keys: () => ["traceparent", "tracestate"],
        get: (carrier, key) => {
          const value = carrier[key as "traceparent" | "tracestate"];
          return typeof value === "string" && value.length <= 512 ? value : undefined;
        },
      });
      return tracer.startActiveSpan("agent_ui.http.request", {
        kind: SpanKind.SERVER,
        attributes: { "http.request.method": method, "http.route": route },
      }, parent, async (span) => {
        const boundary: HttpBoundary = { active: true, span, inputDiagnostics: !config.disabled };
        if (!config.disabled && span.isRecording())
          span.setAttribute(SEMCONV.ANTNEST_UI_HTTP_STARTED_MONOTONIC_NS, process.hrtime.bigint().toString());
        return context.with(context.active().setValue(HTTP_BOUNDARY, boundary), async () => {
          const startedAt = performance.now();
          let status = 503;
          try {
            status = await work();
            if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
            return status;
          } catch (error) {
            span.recordException(error instanceof Error ? error : new Error("HTTP request failed"));
            span.setStatus({ code: SpanStatusCode.ERROR });
            throw error;
          } finally {
            boundary.active = false;
            const attributes = { "http.request.method": method, "http.route": route,
              "http.response.status_code": status };
            requests.add(1, metricAttributes(attributes));
            duration.record(performance.now() - startedAt, metricAttributes(attributes));
            span.setAttribute("http.response.status_code", status);
            span.end();
          }
        });
      });
    },
    shutdown() {
      closing ??= sdk?.shutdown() ?? Promise.resolve();
      return closing;
    },
  };
}

function signalUrl(endpoint: URL, signal: "traces" | "metrics"): string {
  const url = new URL(endpoint);
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/v1/${signal}`;
  return url.href;
}
