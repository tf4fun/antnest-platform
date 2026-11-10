import { describe, expect, it, afterAll, afterEach, vi } from "vitest";
import { node, tracing } from "@opentelemetry/sdk-node";

import { rpcContent, configureBoundaries } from "../../src/telemetry/diagnostics.js";

const exporter = new tracing.InMemorySpanExporter();
const provider = new node.NodeTracerProvider({
  spanProcessors: [new tracing.SimpleSpanProcessor(exporter)],
});

describe("rpcContent secret redaction", () => {
  afterAll(async () => {
    await provider.shutdown();
  });
  afterEach(() => {
    exporter.reset();
    configureBoundaries({ captureRpcContent: false, disabled: false });
  });

  it("redacts nested secret keys while retaining public RPC fields", async () => {
    configureBoundaries({ captureRpcContent: true, disabled: false });
    const payload = {
      public: "x".repeat(20_000),
      nested: { password: "PRIVATE-CANARY", access_token: "PRIVATE-CANARY" },
      rows: [{ client_secret: "PRIVATE-CANARY" }],
    };
    const input = structuredClone(payload);
    provider.getTracer("fixture").startActiveSpan("rpc", (span) => {
      rpcContent(span, "request", input);
      rpcContent(span, "response", input);
      span.end();
    });
    await provider.forceFlush();
    const ended = exporter.getFinishedSpans();
    expect(ended.length).toBe(1);
    for (const direction of ["antnest.request", "antnest.response"]) {
      const event = ended[0]!.events.find((item) => item.name === direction);
      expect(event, `${direction} missing`).toBeDefined();
      const captured = String(event!.attributes?.["antnest.payload.json"] ?? "");
      expect(captured).not.toContain("PRIVATE-CANARY");
      const decoded = JSON.parse(captured) as typeof payload;
      expect(decoded.public).toBe(payload.public);
      expect(decoded.nested.password).toBe("[REDACTED]");
      expect(decoded.nested.access_token).toBe("[REDACTED]");
      expect(decoded.rows).toHaveLength(1);
      expect(decoded.rows[0]!.client_secret).toBe("[REDACTED]");
    }
    expect(input).toEqual(payload);
  });

  it("never serializes payloads when capture is disabled", async () => {
    configureBoundaries({ captureRpcContent: false, disabled: false });
    const probe = vi.fn(() => {
      throw new Error("payload must never serialize");
    });
    provider.getTracer("fixture").startActiveSpan("rpc", (span) => {
      rpcContent(span, "request", { toJSON: probe });
      rpcContent(span, "response", { toJSON: probe });
      span.end();
    });
    await provider.forceFlush();
    const ended = exporter.getFinishedSpans();
    expect(ended.length).toBe(1);
    expect(ended[0]!.events.length).toBe(0);
    expect(probe).not.toHaveBeenCalled();
  });
});
