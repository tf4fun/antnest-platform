import assert from "node:assert/strict";
import { ROOT_CONTEXT, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { node, resources, tracing } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

const service = "antnest-private-acp-client";

// This provider owns only these fixture CLIENT spans. It does not replace a
// process-global provider or fabricate a parent for the private ACP SERVER.
export function createPrivateACPTelemetry(endpoint) {
  assert(typeof endpoint === "string" && endpoint.length > 0);
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("invalid private CLIENT telemetry endpoint");
  }
  assert(
    ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash,
    "plain OTLP HTTP endpoint required",
  );
  const provider = new node.NodeTracerProvider({
    resource: resources.resourceFromAttributes({ "service.name": service }),
    sampler: new tracing.AlwaysOnSampler(),
    spanProcessors: [
      new tracing.SimpleSpanProcessor(new OTLPTraceExporter({ url: url.href })),
    ],
  });
  const tracer = provider.getTracer(service);
  let shutdown;
  return Object.freeze({
    startUpgrade(version) {
      assert(!shutdown, "private CLIENT telemetry is shut down");
      assert([1, 2].includes(version), "unsupported private ACP version");
      const span = tracer.startSpan(
        "HTTP GET agent-acp-workspace",
        {
          kind: SpanKind.CLIENT,
          attributes: {
            "http.request.method": "GET",
            "antnest.protocol.version": `v${version}`,
          },
        },
        ROOT_CONTEXT,
      );
      const { traceId: traceID, spanId: clientSpanID } = span.spanContext();
      let ended = false;
      return Object.freeze({
        traceID,
        clientSpanID,
        traceparent: `00-${traceID}-${clientSpanID}-01`,
        end(status, outcome = status === 101 ? "success" : "failed") {
          if (ended) return;
          ended = true;
          if (Number.isInteger(status))
            span.setAttribute("http.response.status_code", status);
          if (status !== 101 || outcome !== "success") {
            span.setStatus({ code: SpanStatusCode.ERROR });
            span.setAttribute("error.type", "ACPUpgradeError");
            span.setAttribute(
              "antnest.outcome",
              status >= 400 && status < 500 ? "rejected" : outcome,
            );
          }
          span.end();
        },
      });
    },
    flush: () => provider.forceFlush(),
    shutdown() {
      shutdown ??= provider.shutdown();
      return shutdown;
    },
  });
}
