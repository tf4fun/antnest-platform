import { SpanStatusCode } from "@opentelemetry/api";
import { node, tracing } from "@opentelemetry/sdk-node";
import { afterAll, beforeEach, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors.js";
import { recordAcpAccessDenial } from "../../src/telemetry/acp-http.js";
import { configureBoundaries } from "../../src/telemetry/diagnostics.js";
import { binding } from "../support/fixtures.js";

const exporter = new tracing.InMemorySpanExporter();
const provider = new node.NodeTracerProvider({
  spanProcessors: [new tracing.SimpleSpanProcessor(exporter)],
});
beforeEach(() => {
  exporter.reset();
  configureBoundaries({ captureRpcContent: false, disabled: false });
});
afterAll(() => provider.shutdown());

it.each(["session-output", "learning-notice", "permission"] as const)(
  "records the original access denial from %s without changing the span or exporting text",
  (source) => {
    const span = provider.getTracer("test").startSpan("existing GET");
    span.setStatus({ code: SpanStatusCode.ERROR });
    span.setAttributes({ "error.type": "stream_interrupted", "antnest.outcome": "disconnected" });
    const expected = binding();
    recordAcpAccessDenial(
      span,
      new DomainError("access_denied", "private-canary"),
      source,
      expected,
    );
    span.end();
    const recorded = exporter.getFinishedSpans();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.name).toBe("existing GET");
    expect(recorded[0]!.status.code).toBe(SpanStatusCode.ERROR);
    expect(recorded[0]!.attributes).toEqual({
      "error.type": "stream_interrupted",
      "antnest.outcome": "disconnected",
    });
    expect(recorded[0]!.events).toHaveLength(1);
    expect(recorded[0]!.events[0]).toMatchObject({
      name: "antnest.stream.termination",
      attributes: {
        reason: "access_denied",
        "error.type": "DomainError",
        source,
        "antnest.agent.id": expected.agentId,
        "antnest.organization.id": expected.organizationId,
      },
    });
    expect(Object.keys(recorded[0]!.events[0]!.attributes!)).toHaveLength(5);
    expect(JSON.stringify(recorded[0]!.events)).not.toContain("private-canary");
    expect(JSON.stringify(recorded[0]!.events)).not.toContain(expected.connectionId);
  },
);

it.each([
  new Error("access_denied"),
  Object.assign(new Error("private-canary"), { name: "DomainError", code: "access_denied" }),
  new Error("private-canary", { cause: new DomainError("access_denied", "private-canary") }),
  new DomainError("session_not_found", "private-canary"),
  new DOMException("private-canary", "AbortError"),
  { name: "DomainError", code: "access_denied" },
])("does not infer access-denial ownership from another error (%#)", (failure) => {
  const span = provider.getTracer("test").startSpan("existing GET");
  recordAcpAccessDenial(span, failure, "session-output", binding());
  span.end();
  expect(exporter.getFinishedSpans()[0]!.events).toEqual([]);
});

it("does not change an ended or telemetry-disabled span", () => {
  const span = provider.getTracer("test").startSpan("existing GET");
  configureBoundaries({ captureRpcContent: false, disabled: true });
  recordAcpAccessDenial(
    span,
    new DomainError("access_denied", "private-canary"),
    "learning-notice",
    binding(),
  );
  configureBoundaries({ captureRpcContent: false, disabled: false });
  span.end();
  recordAcpAccessDenial(
    span,
    new DomainError("access_denied", "private-canary"),
    "learning-notice",
    binding(),
  );
  expect(exporter.getFinishedSpans()[0]!.events).toEqual([]);
});
