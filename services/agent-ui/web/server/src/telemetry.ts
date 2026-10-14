import { context, createContextKey, isSpanContextValid, metrics, propagation, ROOT_CONTEXT,
  SpanKind, SpanStatusCode, trace, type Span } from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { core, NodeSDK, tracing } from "@opentelemetry/sdk-node";
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
type HttpBoundary = { active: boolean; span: Span };

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
    boundary.span.addEvent("antnest.ui.agent_view.failure", {
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
      attributes: { "antnest.ui.acp.close.trigger": trigger },
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
        span.setAttribute("antnest.ui.acp.close.outcome", outcome);
        if (outcome === "failed") span.setStatus({ code: SpanStatusCode.ERROR });
        span.setAttributes({
          "antnest.ui.acp.close.target_observed": receipt.targetObserved,
          "antnest.ui.acp.close.delete_attempts": receipt.deleteAttempts,
          "antnest.ui.acp.close.delete_responses": receipt.deleteResponses,
          "antnest.ui.acp.close.delete_completed": receipt.deleteCompleted,
          "antnest.ui.acp.close.delete_status": receipt.deleteStatus,
          "antnest.ui.acp.close.pending_requests": receipt.pendingRequests,
          "antnest.ui.acp.close.stream_joined": receipt.streamJoined,
          "antnest.ui.acp.close.failures": receipt.failures.count,
          "antnest.ui.acp.close.diagnostics_truncated": receipt.failures.truncated,
        });
        for (const failure of receipt.failures.entries)
          span.addEvent("antnest.ui.acp.close.failure", failure);
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
    boundary.span.addEvent("antnest.stream.termination", {
      reason: "access_denied", source: "agent-execution-state",
      "antnest.organization.id": organizationId,
      "antnest.principal.id": principalId, "antnest.agent.id": agentId,
    });
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
  const requests = meter.createCounter("antnest.ui.http.requests");
  const duration = meter.createHistogram("antnest.ui.http.duration", { unit: "ms" });
  const coldReplayDuration = meter.createHistogram("antnest.ui.bridge.cold_replay_duration", {
    unit: "ms",
  });
  const localIntentReuse = meter.createCounter("antnest.ui.bridge.local_intent_reuse");
  let runtimeMetricsRegistered = false;
  let closing: Promise<void> | undefined;
  return {
    recordColdReplay(durationMs, outcome) {
      coldReplayDuration.record(durationMs, { outcome });
    },
    recordLocalIntentReuse(outcome) {
      localIntentReuse.add(1, { outcome });
    },
    registerRuntimeMetrics(snapshot) {
      if (runtimeMetricsRegistered) throw new Error("Bridge runtime metrics already registered");
      runtimeMetricsRegistered = true;
      const owners = meter.createObservableGauge("antnest.ui.bridge.owners");
      const observers = meter.createObservableGauge("antnest.ui.bridge.observer_leases");
      const work = meter.createObservableGauge("antnest.ui.bridge.held_work");
      const cached = meter.createObservableGauge("antnest.ui.bridge.cached_history_bytes", { unit: "By" });
      const subscribers = meter.createObservableGauge("antnest.ui.bridge.stream_subscribers");
      const queued = meter.createObservableGauge("antnest.ui.bridge.journal_queued_bytes", { unit: "By" });
      const retained = meter.createObservableGauge("antnest.ui.bridge.journal_retained_bytes", { unit: "By" });
      const activeReplays = meter.createObservableGauge("antnest.ui.bridge.active_replays");
      const queuedReplays = meter.createObservableGauge("antnest.ui.bridge.queued_replays");
      const uncertainOperations = meter.createObservableGauge("antnest.ui.bridge.uncertain_operations");
      const oldestUncertainMs = meter.createObservableGauge("antnest.ui.bridge.oldest_uncertain_ms", { unit: "ms" });
      const heap = meter.createObservableGauge("antnest.ui.process.heap_used_bytes", { unit: "By" });
      const rss = meter.createObservableGauge("antnest.ui.process.rss_bytes", { unit: "By" });
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
        const boundary: HttpBoundary = { active: true, span };
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
            requests.add(1, attributes);
            duration.record(performance.now() - startedAt, attributes);
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
