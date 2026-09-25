import { context, createContextKey, metrics, propagation, ROOT_CONTEXT,
  SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { core, NodeSDK, tracing } from "@opentelemetry/sdk-node";
import type { BridgeRuntimeMetrics } from "./workspace-runtime.ts";

export type BridgeTelemetry = {
  observeHttp(method: string, route: string, work: () => Promise<number>,
    headers?: { traceparent?: string | string[]; tracestate?: string | string[] }): Promise<number>;
  registerRuntimeMetrics(snapshot: () => BridgeRuntimeMetrics): void;
  recordColdReplay(durationMs: number, outcome: "success" | "error"): void;
  recordLocalIntentReuse(outcome: "hit" | "conflict"): void;
  shutdown(): Promise<void>;
};

const HTTP_BOUNDARY = createContextKey("antnest.ui.active-http-boundary");
type HttpBoundary = { active: boolean };

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
        const boundary: HttpBoundary = { active: true };
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
