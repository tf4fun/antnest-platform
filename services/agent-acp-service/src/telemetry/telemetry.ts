import {
  context,
  isSpanContextValid,
  metrics,
  ROOT_CONTEXT,
  trace,
  type Counter,
  type Histogram,
} from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { core, node, NodeSDK, resources } from "@opentelemetry/sdk-node";
import { hostname } from "node:os";
import {
  boundaryConfig,
  configureBoundaries,
  recordBoundaryError,
  safeError,
} from "./diagnostics.js";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";

import type { AgentAcpConfig } from "../config.js";
import type { LogLevel, TelemetryAttributes, TelemetryPort } from "../ports/telemetry.js";

type EmitLog = (line: string) => void;

export type TelemetryRuntime = {
  telemetry: TelemetryPort;
  shutdown(): Promise<void>;
};

export class ServiceTelemetry implements TelemetryPort {
  private readonly tracer;
  private readonly meter;
  private readonly counters = new Map<string, Counter>();
  private readonly histograms = new Map<string, Histogram>();

  public constructor(
    private readonly serviceName: string,
    private readonly emit: EmitLog = defaultEmit,
  ) {
    this.tracer = trace.getTracer(serviceName);
    this.meter = metrics.getMeter(serviceName);
  }

  public span<Result>(
    name: string,
    attributes: TelemetryAttributes,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    if (boundaryConfig().disabled) return operation();
    const source = trace.getSpan(context.active())?.spanContext();
    return this.tracer.startActiveSpan(
      name,
      {
        attributes: cleanAttributes(attributes),
        ...(name === "agent.run" && source !== undefined && isSpanContextValid(source)
          ? { links: [{ context: source }] }
          : {}),
      },
      name === "agent.run" ? ROOT_CONTEXT : context.active(),
      async (span) => {
        try {
          const result = await operation();
          return result;
        } catch (error) {
          recordBoundaryError(span, error, name);
          throw error;
        } finally {
          span.end();
        }
      },
    );
  }

  public count(name: string, attributes: TelemetryAttributes, value = 1): void {
    if (boundaryConfig().disabled) return;
    let counter = this.counters.get(name);
    if (counter === undefined) {
      counter = this.meter.createCounter(name);
      this.counters.set(name, counter);
    }
    counter.add(value, cleanAttributes(attributes));
  }

  public duration(name: string, milliseconds: number, attributes: TelemetryAttributes): void {
    if (boundaryConfig().disabled) return;
    let histogram = this.histograms.get(name);
    if (histogram === undefined) {
      histogram = this.meter.createHistogram(name, { unit: "ms" });
      this.histograms.set(name, histogram);
    }
    histogram.record(milliseconds, cleanAttributes(attributes));
  }

  public log(
    level: LogLevel,
    event: string,
    attributes: TelemetryAttributes = {},
    error?: unknown,
  ): void {
    const spanContext = trace.getSpan(context.active())?.spanContext();
    const identity = error === undefined ? undefined : safeError(error);
    const payload = {
      timestamp: new Date().toISOString(),
      level,
      event,
      service: this.serviceName,
      ...cleanAttributes(attributes),
      ...(spanContext !== undefined && isSpanContextValid(spanContext)
        ? { trace_id: spanContext.traceId, span_id: spanContext.spanId }
        : {}),
      ...(identity === undefined ? {} : { error_type: identity.type }),
      ...(identity?.code === undefined ? {} : { error_code: identity.code }),
      ...(identity === undefined ? {} : { error_message: identity.message }),
    };
    try {
      this.emit(JSON.stringify(payload));
    } catch {
      // A log sink failure cannot alter permission or execution outcomes.
    }
  }
}

export function startTelemetry(config: AgentAcpConfig["telemetry"]): Promise<TelemetryRuntime> {
  configureBoundaries({
    captureRpcContent: config.captureRpcContent ?? false,
    disabled: config.disabled,
  });
  if (
    config.disabled ||
    config.endpoint === undefined ||
    (!config.tracesEnabled && !config.metricsEnabled)
  ) {
    const provider = new node.NodeTracerProvider({ spanProcessors: [] });
    provider.register({ propagator: new core.W3CTraceContextPropagator() });
    return Promise.resolve({
      telemetry: new ServiceTelemetry(config.serviceName),
      shutdown: () => provider.shutdown(),
    });
  }

  const sdk = new NodeSDK({
    serviceName: config.serviceName,
    textMapPropagator: new core.W3CTraceContextPropagator(),
    resource: resources.resourceFromAttributes({
      "service.namespace": "antnest",
      "service.version": "0.1.0",
      "service.instance.id": `${hostname()}:${process.pid}`,
    }),
    ...(config.tracesEnabled ? {} : { spanProcessors: [] }),
    ...(config.metricsEnabled ? {} : { metricReaders: [] }),
    ...(config.tracesEnabled
      ? {
          traceExporter: new OTLPTraceExporter({
            url: signalUrl(config.endpoint, "traces").href,
          }),
        }
      : {}),
    ...(config.metricsEnabled
      ? {
          metricReaders: [
            new PeriodicExportingMetricReader({
              exporter: new OTLPMetricExporter({
                url: signalUrl(config.endpoint, "metrics").href,
              }),
            }),
          ],
        }
      : {}),
  });
  sdk.start();
  return Promise.resolve({
    telemetry: new ServiceTelemetry(config.serviceName),
    shutdown: async () => sdk.shutdown(),
  });
}

function cleanAttributes(
  attributes: TelemetryAttributes,
): Record<string, string | number | boolean> {
  const clean = Object.fromEntries(
    Object.entries(attributes).filter(
      (entry): entry is [string, string | number | boolean] => entry[1] !== undefined,
    ),
  );
  const aliases: Record<string, string> = {
    "request.id": "antnest.request.id",
    "agent.id": "antnest.agent.id",
    "run.id": "antnest.run.id",
    "session.id": "antnest.session.id",
    "admission.id": "antnest.admission.id",
    "execution.revision": "antnest.execution.revision",
  };
  for (const [original, alias] of Object.entries(aliases)) {
    const value = clean[original];
    if (value !== undefined) clean[alias] = value;
  }
  return clean;
}

function signalUrl(endpoint: URL, signal: "traces" | "metrics"): URL {
  const url = new URL(endpoint);
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/v1/${signal}`;
  return url;
}

function defaultEmit(line: string): void {
  process.stdout.write(`${line}\n`);
}
