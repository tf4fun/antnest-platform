import {
  context,
  isSpanContextValid,
  metrics,
  SpanStatusCode,
  trace,
  type Counter,
  type Histogram,
} from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { NodeSDK } from "@opentelemetry/sdk-node";
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
    return this.tracer.startActiveSpan(
      name,
      { attributes: cleanAttributes(attributes) },
      async (span) => {
        try {
          const result = await operation();
          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } catch (error) {
          span.setStatus({ code: SpanStatusCode.ERROR });
          const identity = errorIdentity(error);
          span.setAttribute("error.type", identity.type);
          if (identity.code !== undefined) {
            span.setAttribute("error.code", identity.code);
          }
          throw error;
        } finally {
          span.end();
        }
      },
    );
  }

  public count(name: string, attributes: TelemetryAttributes, value = 1): void {
    let counter = this.counters.get(name);
    if (counter === undefined) {
      counter = this.meter.createCounter(name);
      this.counters.set(name, counter);
    }
    counter.add(value, cleanAttributes(attributes));
  }

  public duration(name: string, milliseconds: number, attributes: TelemetryAttributes): void {
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
    const identity = error === undefined ? undefined : errorIdentity(error);
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
    };
    this.emit(JSON.stringify(payload));
  }
}

export function startTelemetry(config: AgentAcpConfig["telemetry"]): Promise<TelemetryRuntime> {
  if (
    config.disabled ||
    config.endpoint === undefined ||
    (!config.tracesEnabled && !config.metricsEnabled)
  ) {
    return Promise.resolve({
      telemetry: new ServiceTelemetry(config.serviceName),
      shutdown: () => Promise.resolve(),
    });
  }

  const sdk = new NodeSDK({
    serviceName: config.serviceName,
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
  return Object.fromEntries(
    Object.entries(attributes).filter(
      (entry): entry is [string, string | number | boolean] => entry[1] !== undefined,
    ),
  );
}

function errorIdentity(error: unknown): { type: string; code?: string } {
  if (error instanceof Error) {
    const code = errorCode(error);
    return { type: error.name, ...(code === undefined ? {} : { code }) };
  }
  return { type: typeof error };
}

function errorCode(error: Error): string | undefined {
  if ("code" in error && typeof error.code === "string" && error.code.length <= 128) {
    return error.code;
  }
  return undefined;
}

function signalUrl(endpoint: URL, signal: "traces" | "metrics"): URL {
  const url = new URL(endpoint);
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/v1/${signal}`;
  return url;
}

function defaultEmit(line: string): void {
  process.stdout.write(`${line}\n`);
}
