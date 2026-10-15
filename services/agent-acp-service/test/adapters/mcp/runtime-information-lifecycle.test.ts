import { context, propagation, SpanStatusCode, trace } from "@opentelemetry/api";
import { node, tracing } from "@opentelemetry/sdk-node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { McpToolCatalog, type McpConnection } from "../../../src/adapters/mcp/tool-catalog.js";
import { configureBoundaries } from "../../../src/telemetry/diagnostics.js";
import { runtimeInformation, runtimeSnapshot } from "../../fixtures/runtime-information.js";

const exporter = new tracing.InMemorySpanExporter();
const provider = new node.NodeTracerProvider({
  spanProcessors: [new tracing.SimpleSpanProcessor(exporter)],
});
beforeAll(() => provider.register());
beforeEach(() => {
  exporter.reset();
  configureBoundaries({ captureRpcContent: false, disabled: false });
});
afterEach(() => {
  vi.restoreAllMocks();
  configureBoundaries({ captureRpcContent: false, disabled: false });
});
afterAll(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
  propagation.disable();
});

function fixture() {
  const { executionId, ...information } = runtimeInformation();
  information.instructions!.content = "PRIVATE-RESOURCE-CONTENT";
  const resource = {
    contents: [
      {
        uri: "antnest://runtime/info",
        mimeType: "application/json",
        text: JSON.stringify({ execution_id: executionId, ...information }),
      },
    ],
  };
  const readResource = vi.fn<McpConnection["readResource"]>().mockResolvedValue(resource);
  const close = vi.fn<McpConnection["close"]>().mockResolvedValue();
  const connect = vi.fn().mockResolvedValue({ readResource, close });
  const reportConnectionCloseFailure = vi.fn();
  const catalog = new McpToolCatalog({
    runtimeDialer: { connect },
    revisions: { getClientMcpRevision: vi.fn() },
    reportConnectionCloseFailure,
  });
  const abort = new AbortController();
  const read = () => catalog.readBinding(runtimeSnapshot().runtime, abort.signal);
  const span = () => {
    const found = exporter.getFinishedSpans().filter((row) => row.name === "mcp.runtime.info.read");
    expect(found).toHaveLength(1);
    return found[0]!;
  };
  return {
    resource,
    readResource,
    close,
    connect,
    reportConnectionCloseFailure,
    abort,
    read,
    span,
  };
}

describe("Runtime information read and close provenance", () => {
  it("records parsed information before close and exports only bounded lifecycle metadata", async () => {
    const f = fixture();
    let activeRead: string | undefined;
    f.readResource.mockImplementation(() => {
      activeRead = trace.getActiveSpan()?.spanContext().spanId;
      return Promise.resolve(f.resource);
    });
    f.close.mockImplementation(() => {
      expect(trace.getActiveSpan()?.spanContext().spanId).toBe(activeRead);
      expect(exporter.getFinishedSpans()).toHaveLength(0);
      return Promise.resolve();
    });
    await expect(f.read()).resolves.toMatchObject({ executionId: "runtime-execution-1" });
    const span = f.span();
    expect(span.spanContext().spanId).toBe(activeRead);
    expect(span.attributes).toEqual({
      "antnest.runtime.execution.id": "runtime-execution-1",
      "antnest.mcp.resource_read.outcome": "success",
      "antnest.mcp.connection.close.outcome": "closed",
      "antnest.mcp.caller_cancelled": false,
    });
    expect(span.events.map((event) => event.name)).toEqual([
      "antnest.mcp.discovery.ready",
      "antnest.mcp.resource.read.started",
      "antnest.mcp.resource.validated",
      "antnest.mcp.connection.close.started",
      "antnest.mcp.connection.close.completed",
    ]);
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
    expect(f.close).toHaveBeenCalledExactlyOnceWith();
    expect(JSON.stringify({ attributes: span.attributes, events: span.events })).not.toContain(
      "PRIVATE",
    );
  });

  it("records readiness only after connect and dispatch before invoking the resource read", async () => {
    const f = fixture();
    const connected = Promise.withResolvers<Pick<McpConnection, "readResource" | "close">>();
    const parsed = Promise.withResolvers<unknown>();
    const entered = Promise.withResolvers<void>();
    const dispatched = Promise.withResolvers<void>();
    let atDispatch: string[] = [];
    let names = () => [] as string[];
    f.connect.mockImplementation(() => {
      const events = vi.spyOn(trace.getActiveSpan()!, "addEvent");
      names = () => events.mock.calls.map(([name]) => name);
      entered.resolve();
      return connected.promise;
    });
    f.readResource.mockImplementation(() => {
      atDispatch = names();
      dispatched.resolve();
      return parsed.promise;
    });
    const reading = f.read();
    const wait = async (gate: Promise<void>) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          gate,
          reading.then(() => {
            throw new Error("read finished before the controlled resource was released");
          }),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error("read lifecycle gate deadline")), 1000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    try {
      await wait(entered.promise);
      expect(names()).toEqual([]);
      expect(f.readResource).not.toHaveBeenCalled();
      connected.resolve({ readResource: f.readResource, close: f.close });
      await wait(dispatched.promise);
      expect(atDispatch).toEqual([
        "antnest.mcp.discovery.ready",
        "antnest.mcp.resource.read.started",
      ]);
      expect(f.close).not.toHaveBeenCalled();
      expect(exporter.getFinishedSpans()).toHaveLength(0);
    } finally {
      connected.resolve({ readResource: f.readResource, close: f.close });
      parsed.resolve(f.resource);
      await reading;
    }
    expect(
      f
        .span()
        .events.slice(0, 3)
        .map((event) => event.name),
    ).toEqual([
      "antnest.mcp.discovery.ready",
      "antnest.mcp.resource.read.started",
      "antnest.mcp.resource.validated",
    ]);
  });

  it.each(["request", "synchronous-request", "schema", "execution"] as const)(
    "retains %s failure even when cleanup succeeds",
    async (kind) => {
      const f = fixture();
      if (kind === "request") f.readResource.mockRejectedValue(new Error("PRIVATE-READ-ERROR"));
      else if (kind === "synchronous-request")
        f.readResource.mockImplementation(() => {
          throw new Error("PRIVATE-READ-ERROR");
        });
      else if (kind === "schema") f.resource.contents[0]!.text = "{}";
      else
        f.resource.contents[0]!.text = f.resource.contents[0]!.text.replace(
          "runtime-execution-1",
          "foreign",
        );
      await expect(f.read()).rejects.toThrow();
      const span = f.span();
      expect(span.attributes["antnest.mcp.resource_read.outcome"]).toBe("failed");
      expect(span.attributes["antnest.mcp.connection.close.outcome"]).toBe("closed");
      expect(span.status.code).toBe(
        kind.endsWith("request") ? SpanStatusCode.ERROR : SpanStatusCode.UNSET,
      );
      expect(span.attributes["antnest.outcome"]).toBe(
        kind.endsWith("request") ? "error" : "rejected",
      );
      expect(span.events.map((event) => event.name)).toEqual([
        "antnest.mcp.discovery.ready",
        "antnest.mcp.resource.read.started",
        "antnest.error",
        "antnest.mcp.connection.close.started",
        "antnest.mcp.connection.close.completed",
      ]);
      expect(f.close).toHaveBeenCalledTimes(1);
      expect(JSON.stringify({ attributes: span.attributes, events: span.events })).not.toContain(
        "PRIVATE",
      );
    },
  );

  it.each(["before-read", "during-close"] as const)(
    "retains caller cancellation %s",
    async (when) => {
      const f = fixture();
      if (when === "before-read") f.abort.abort();
      else
        f.close.mockImplementation(() => {
          f.abort.abort();
          return Promise.resolve();
        });
      await f.read();
      expect(f.span().attributes["antnest.mcp.caller_cancelled"]).toBe(true);
    },
  );

  it("reports close failure without changing the successful business result", async () => {
    const f = fixture();
    const failure = new Error("PRIVATE-CLOSE-ERROR");
    f.close.mockRejectedValue(failure);
    await expect(f.read()).resolves.toMatchObject({ executionId: "runtime-execution-1" });
    const span = f.span();
    expect(span.attributes["antnest.mcp.resource_read.outcome"]).toBe("success");
    expect(span.attributes["antnest.mcp.connection.close.outcome"]).toBe("failed");
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(f.reportConnectionCloseFailure).toHaveBeenCalledExactlyOnceWith(
      "runtime",
      "runtime",
      failure,
    );
  });

  it("does not invent a read or close receipt when connect fails", async () => {
    const f = fixture();
    f.connect.mockRejectedValue(new Error("PRIVATE-CONNECT-ERROR"));
    await expect(f.read()).rejects.toThrow("PRIVATE-CONNECT-ERROR");
    const span = f.span();
    expect(span.attributes["antnest.mcp.resource_read.outcome"]).toBe("failed");
    expect(span.attributes["antnest.mcp.connection.close.outcome"]).toBe("not_started");
    expect(span.events.map((event) => event.name)).toEqual(["antnest.error"]);
    expect(f.readResource).not.toHaveBeenCalled();
    expect(f.close).not.toHaveBeenCalled();
  });

  it("keeps result and cleanup semantics when telemetry is disabled", async () => {
    configureBoundaries({ captureRpcContent: false, disabled: true });
    const f = fixture();
    await expect(f.read()).resolves.toMatchObject({ executionId: "runtime-execution-1" });
    expect(f.close).toHaveBeenCalledExactlyOnceWith();
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it("joins pending close before ending the span and retains an abort during that wait", async () => {
    const f = fixture();
    const closing = Promise.withResolvers<void>();
    f.close.mockImplementation(() => closing.promise);
    const reading = f.read();
    try {
      await vi.waitFor(() => expect(f.close).toHaveBeenCalledTimes(1));
      f.abort.abort();
      expect(exporter.getFinishedSpans()).toHaveLength(0);
    } finally {
      closing.resolve();
      await reading;
    }
    expect(f.span().attributes["antnest.mcp.caller_cancelled"]).toBe(true);
    expect(f.span().attributes["antnest.mcp.connection.close.outcome"]).toBe("closed");
  });

  it("preserves the original read error when both read and close fail", async () => {
    const f = fixture();
    const readFailure = new Error("PRIVATE-READ-ERROR");
    const closeFailure = new DOMException("PRIVATE-CLOSE-ERROR", "AbortError");
    f.readResource.mockRejectedValue(readFailure);
    f.close.mockRejectedValue(closeFailure);
    await expect(f.read()).rejects.toBe(readFailure);
    expect(f.reportConnectionCloseFailure).toHaveBeenCalledExactlyOnceWith(
      "runtime",
      "runtime",
      closeFailure,
    );
    expect(f.span().attributes["antnest.mcp.resource_read.outcome"]).toBe("failed");
    expect(f.span().attributes["antnest.mcp.connection.close.outcome"]).toBe("failed");
    expect(f.span().events.map((event) => event.name)).not.toContain(
      "antnest.mcp.resource.validated",
    );
  });

  it.each(["name", "cause"])(
    "does not replace the original failure when its %s getter throws",
    async (field) => {
      const f = fixture();
      const failure = new Error("PRIVATE-ORIGINAL-ERROR");
      Object.defineProperty(failure, field, {
        get() {
          throw new Error("PRIVATE-GETTER-ERROR");
        },
      });
      f.readResource.mockRejectedValue(failure);
      await expect(f.read()).rejects.toBe(failure);
      expect(f.close).toHaveBeenCalledTimes(1);
      expect(f.span().attributes["antnest.mcp.resource_read.outcome"]).toBe("failed");
      expect(f.span().status.code).toBe(SpanStatusCode.ERROR);
    },
  );
});
