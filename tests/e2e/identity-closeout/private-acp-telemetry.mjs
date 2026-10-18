import assert from "node:assert/strict";
import { hostname } from "node:os";
import { ROOT_CONTEXT, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { core, node, resources, tracing } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

const service = "antnest-private-acp-client";

// SimpleSpanProcessor forgets settled export failures, and the OTLP exporter
// rejects excess concurrent work instead of queueing it. Own that delivery
// boundary without changing, resampling, or reconstructing the SDK spans.
function ownedExporter(delegate) {
  const queue = [];
  const pending = new Set();
  let inFlight = 0;
  let closed = false;
  let shutdown;
  let failure;
  function recordFailure(context, reason, cause) {
    const error = Object.assign(
      new Error(
        `private CLIENT export ${reason}: ${context.traceId}/${context.spanId}`,
        { cause },
      ),
      {
        code: "PRIVATE_ACP_EXPORT_FAILED",
        reason,
        traceID: context.traceId,
        clientSpanID: context.spanId,
      },
    );
    failure ??= error;
    return error;
  }
  function pump() {
    while (inFlight < 8 && queue.length) {
      const task = queue.shift();
      inFlight++;
      let completed = false;
      const complete = (result) => {
        if (completed) return;
        completed = true;
        if (result.code !== core.ExportResultCode.SUCCESS)
          recordFailure(task.context, "export_failed", result.error);
        try {
          task.callback(result);
        } finally {
          inFlight--;
          pending.delete(task.promise);
          task.resolve();
          queueMicrotask(pump);
        }
      };
      try {
        delegate.export(task.spans, complete);
      } catch (error) {
        complete({ code: core.ExportResultCode.FAILED, error });
      }
    }
  }
  async function drain() {
    while (pending.size) await Promise.all([...pending]);
    // A callback runs inside the delegate's pending promise. Join that promise
    // too, even when every callback in our own queue has already completed.
    try {
      await delegate.forceFlush();
    } catch (error) {
      failure ??= error;
    }
  }
  return {
    recordFailure,
    export(spans, callback) {
      const context = spans[0].spanContext();
      if (closed || pending.size >= 256) {
        const reason = closed ? "export_after_shutdown" : "queue_full";
        callback({
          code: core.ExportResultCode.FAILED,
          error: recordFailure(context, reason, new Error(reason)),
        });
        return;
      }
      const { promise, resolve } = Promise.withResolvers();
      pending.add(promise);
      queue.push({ spans, callback, context, promise, resolve });
      pump();
    },
    async forceFlush() {
      await drain();
      if (failure) throw failure;
    },
    shutdown() {
      closed = true;
      shutdown ??= (async () => {
        try {
          await drain();
        } finally {
          try {
            await delegate.shutdown();
          } catch (error) {
            failure ??= error;
          }
        }
        if (failure) throw failure;
      })();
      return shutdown;
    },
  };
}

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
  const exporter = ownedExporter(new OTLPTraceExporter({ url: url.href }));
  const active = new Set();
  const host = hostname();
  const provider = new node.NodeTracerProvider({
    resource: resources.defaultResource().merge(
      resources.resourceFromAttributes({
        "service.name": service,
        "service.instance.id": `${host}:${process.pid}`,
        "host.name": host,
        "process.pid": process.pid,
        "process.runtime.name": "nodejs",
        "process.runtime.version": process.versions.node,
      }),
    ),
    sampler: new tracing.AlwaysOnSampler(),
    spanProcessors: [new tracing.SimpleSpanProcessor(exporter)],
  });
  const tracer = provider.getTracer(service);
  let shutdown;
  return Object.freeze({
    startHTTP(method, peer = "agent-acp-workspace") {
      assert(!shutdown, "private CLIENT telemetry is shut down");
      assert(
        peer === "agent-acp-workspace" ||
          (peer === "identity-service" && method === "POST"),
        "unsupported private HTTP peer or operation",
      );
      assert(
        ["GET", "POST", "DELETE"].includes(method),
        "unsupported private HTTP method",
      );
      const span = tracer.startSpan(
        `HTTP ${method} ${peer}`,
        {
          kind: SpanKind.CLIENT,
          attributes: {
            "http.request.method": method,
            ...(peer === "agent-acp-workspace"
              ? { "antnest.protocol.version": "v1" }
              : {}),
          },
        },
        ROOT_CONTEXT,
      );
      const context = span.spanContext();
      active.add(context);
      const { traceId: traceID, spanId: clientSpanID } = context;
      let ended = false;
      return Object.freeze({
        traceID,
        clientSpanID,
        traceparent: `00-${traceID}-${clientSpanID}-01`,
        end(status, outcome, bytes = 0, bodyOutcome = outcome) {
          if (ended) return;
          assert(!shutdown, "private CLIENT telemetry is shut down");
          assert(
            ["eof", "cancelled", "failed"].includes(outcome),
            "invalid private HTTP outcome",
          );
          assert(
            ["eof", "cancelled", "failed"].includes(bodyOutcome),
            "invalid private HTTP body outcome",
          );
          assert(
            Number.isSafeInteger(bytes) && bytes >= 0,
            "invalid private HTTP byte count",
          );
          ended = true;
          if (Number.isInteger(status))
            span.setAttribute("http.response.status_code", status);
          span.setAttribute("http.response.body.size", bytes);
          span.setAttribute("antnest.outcome", outcome);
          span.setAttribute("antnest.http.body.outcome", bodyOutcome);
          if (outcome === "failed" || status >= 400) {
            span.setStatus({ code: SpanStatusCode.ERROR });
            span.setAttribute(
              "error.type",
              peer === "identity-service"
                ? "IdentityHTTPError"
                : "ACPHTTPError",
            );
          }
          active.delete(context);
          span.end();
        },
      });
    },
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
      const context = span.spanContext();
      active.add(context);
      const { traceId: traceID, spanId: clientSpanID } = context;
      let ended = false;
      return Object.freeze({
        traceID,
        clientSpanID,
        traceparent: `00-${traceID}-${clientSpanID}-01`,
        end(status, outcome = status === 101 ? "success" : "failed") {
          if (ended) return;
          assert(!shutdown, "private CLIENT telemetry is shut down");
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
          active.delete(context);
          span.end();
        },
      });
    },
    async flush() {
      let providerFailed = false;
      let providerError;
      try {
        await provider.forceFlush();
      } catch (error) {
        providerFailed = true;
        providerError = error;
      }
      // The provider's deadline does not stop its processor. Join our actual
      // queued delivery even after that deadline, then retain the original
      // export failure or, if delivery succeeded, the provider's own error.
      await exporter.forceFlush();
      if (providerFailed) throw providerError;
    },
    shutdown() {
      if (!shutdown) {
        if (active.size)
          exporter.recordFailure(
            active.values().next().value,
            "unfinished_span",
            new Error("private CLIENT spans must end before shutdown"),
          );
        shutdown = provider.shutdown();
      }
      return shutdown;
    },
  });
}
