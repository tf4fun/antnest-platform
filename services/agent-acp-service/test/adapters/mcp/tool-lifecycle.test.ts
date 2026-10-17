import { context, propagation, SpanStatusCode, trace } from "@opentelemetry/api";
import { node, tracing } from "@opentelemetry/sdk-node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  McpToolCatalog,
  type McpConnection,
  type McpDialer,
} from "../../../src/adapters/mcp/tool-catalog.js";
import { NOOP_TELEMETRY } from "../../../src/ports/telemetry.js";
import type { ToolCatalogPort } from "../../../src/ports/tools.js";
import { configureBoundaries } from "../../../src/telemetry/diagnostics.js";
import { InstrumentedToolCatalog } from "../../../src/telemetry/instrumented-ports.js";
import { ServiceTelemetry } from "../../../src/telemetry/telemetry.js";
import { runtimeSnapshot } from "../../fixtures/runtime-information.js";

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

type Method = "list" | "call";
const sequence = [
  "antnest.mcp.discovery.ready",
  "antnest.mcp.tool.dispatch.started",
  "antnest.mcp.tool.result.parsed",
  "antnest.mcp.connection.close.started",
  "antnest.mcp.connection.close.completed",
];
const nanos = ([seconds, fraction]: readonly [number, number]) =>
  BigInt(seconds) * 1_000_000_000n + BigInt(fraction);

function fixture(method: Method, telemetry = new ServiceTelemetry("tool-lifecycle")) {
  const snapshot = runtimeSnapshot();
  const reply = {
    content: [{ type: "text" as const, text: "PRIVATE-TOOL-CONTENT" }],
    isError: false,
    structuredContent: { effect_state: "settled", effect_source: null },
  };
  const listTools = vi
    .fn<McpConnection["listTools"]>()
    .mockResolvedValue([{ name: "bash", description: "PRIVATE-TOOL-DESCRIPTION" }]);
  const callTool = vi.fn<McpConnection["callTool"]>().mockResolvedValue(reply);
  const close = vi.fn<McpConnection["close"]>().mockResolvedValue();
  const connection = { readResource: vi.fn(), listTools, callTool, close };
  const connect = vi.fn<McpDialer["connect"]>().mockResolvedValue(connection);
  const reportConnectionCloseFailure = vi.fn();
  const raw = new McpToolCatalog({
    runtimeDialer: { connect },
    revisions: { getClientMcpRevision: () => Promise.resolve([]) },
    reportConnectionCloseFailure,
  });
  const catalog = new InstrumentedToolCatalog(raw, telemetry);
  const caller = new AbortController();
  const run = (target: ToolCatalogPort = catalog) =>
    method === "list"
      ? target.list(snapshot, caller.signal)
      : target.call({
          runId: "run-1",
          snapshot,
          tool: {
            source: "runtime",
            sourceId: "runtime",
            name: "bash",
            modelName: "bash",
            description: "PRIVATE-TOOL-DESCRIPTION",
          },
          arguments: { command: "PRIVATE-TOOL-ARGUMENT" },
          signal: caller.signal,
        });
  const span = () => {
    const found = exporter.getFinishedSpans().filter((row) => row.name === `mcp.tools.${method}`);
    expect(found).toHaveLength(1);
    return found[0]!;
  };
  return {
    snapshot,
    reply,
    listTools,
    callTool,
    close,
    connection,
    connect,
    reportConnectionCloseFailure,
    raw,
    catalog,
    caller,
    run,
    span,
  };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("tool lifecycle barrier deadline")), 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe.each(["list", "call"] as const)("Runtime tools/%s lifecycle", (method) => {
  it("binds original receipts to its existing owning span, with no tool content", async () => {
    const f = fixture(method);
    let ownerId: string | undefined;
    f.connect.mockImplementation(() => {
      ownerId = trace.getActiveSpan()?.spanContext().spanId;
      return Promise.resolve(f.connection);
    });
    await f.run();
    const span = f.span();
    expect(span.spanContext().spanId).toBe(ownerId);
    expect(span.attributes).toMatchObject({
      "antnest.runtime.execution.id": "runtime-execution-1",
      "antnest.mcp.method": `tools/${method}`,
      "antnest.mcp.tool_result.outcome": "success",
      "antnest.mcp.connection.close.outcome": "closed",
      "antnest.mcp.caller_cancelled": false,
    });
    expect(span.events.map((event) => event.name)).toEqual(sequence);
    expect(span.events[2]!.attributes).toEqual({ outcome: "success" });
    expect(span.events[3]!.attributes).toEqual({ "antnest.mcp.caller_cancelled": false });
    expect(span.events[4]!.attributes).toEqual({ outcome: "closed" });
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
    let previous = nanos(span.startTime);
    for (const event of span.events) {
      expect(nanos(event.time)).toBeGreaterThanOrEqual(previous);
      expect(nanos(event.time)).toBeLessThanOrEqual(nanos(span.endTime));
      previous = nanos(event.time);
    }
    expect(f.connect).toHaveBeenCalledTimes(1);
    expect(f.close).toHaveBeenCalledExactlyOnceWith();
    expect(JSON.stringify({ attributes: span.attributes, events: span.events })).not.toContain(
      "PRIVATE",
    );
  });

  it("records readiness after connect, dispatch before invocation and parsing before awaited close", async () => {
    const f = fixture(method);
    const connected = Promise.withResolvers<McpConnection>();
    const entered = Promise.withResolvers<void>();
    const dispatched = Promise.withResolvers<void>();
    const closing = Promise.withResolvers<void>();
    const closeEntered = Promise.withResolvers<void>();
    let names = () => [] as string[];
    f.connect.mockImplementation(() => {
      const events = vi.spyOn(trace.getActiveSpan()!, "addEvent");
      names = () => events.mock.calls.map(([name]) => name);
      entered.resolve();
      return connected.promise;
    });
    const atDispatch = () => {
      expect(names()).toEqual(sequence.slice(0, 2));
      dispatched.resolve();
    };
    f.listTools.mockImplementation(() => {
      atDispatch();
      return Promise.resolve([]);
    });
    f.callTool.mockImplementation(() => {
      atDispatch();
      return Promise.resolve(f.reply);
    });
    f.close.mockImplementation(() => {
      closeEntered.resolve();
      return closing.promise;
    });
    const running = f.run();
    const outcome = running.then(
      () => undefined,
      () => undefined,
    );
    try {
      await bounded(entered.promise);
      expect(names()).toEqual([]);
      connected.resolve(f.connection);
      await bounded(dispatched.promise);
      await bounded(closeEntered.promise);
      expect(names()).toEqual(sequence.slice(0, 4));
      expect(exporter.getFinishedSpans()).toHaveLength(0);
      f.caller.abort();
    } finally {
      connected.resolve(f.connection);
      closing.resolve();
      await bounded(outcome);
    }
    await running;
    expect(f.span().attributes["antnest.mcp.caller_cancelled"]).toBe(true);
    expect(f.span().events[3]!.attributes).toEqual({ "antnest.mcp.caller_cancelled": false });
  });

  it("emits no connection receipts when connect fails", async () => {
    const f = fixture(method);
    f.connect.mockRejectedValue(new Error("PRIVATE-CONNECT-FAILURE"));
    await expect(f.run()).rejects.toThrow();
    expect(f.span().events.filter((event) => event.name.startsWith("antnest.mcp."))).toEqual([]);
    expect(f.span().attributes).toMatchObject({
      "antnest.mcp.tool_result.outcome": "not_received",
      "antnest.mcp.connection.close.outcome": "not_started",
    });
    expect(f.listTools).not.toHaveBeenCalled();
    expect(f.callTool).not.toHaveBeenCalled();
    expect(f.close).not.toHaveBeenCalled();
  });

  it.each([false, true])("preserves dispatch failure with close failure=%s", async (failClose) => {
    const f = fixture(method);
    const original = new Error("PRIVATE-DISPATCH-FAILURE");
    f.listTools.mockRejectedValue(original);
    f.callTool.mockRejectedValue(original);
    if (failClose) f.close.mockRejectedValue(new Error("PRIVATE-CLOSE-FAILURE"));
    const failure: unknown = await f.run().catch((error: unknown) => error);
    if (method === "list") expect(failure).toBe(original);
    else
      expect(failure).toMatchObject({
        effectState: "unknown",
        runtimeCallStopped: false,
        cause: original,
      });
    const span = f.span();
    expect(
      span.events
        .filter((event) => event.name.startsWith("antnest.mcp."))
        .map((event) => event.name),
    ).toEqual(sequence.filter((name) => name !== "antnest.mcp.tool.result.parsed"));
    expect(span.attributes["antnest.mcp.tool_result.outcome"]).toBe("not_received");
    expect(span.attributes["antnest.mcp.connection.close.outcome"]).toBe(
      failClose ? "failed" : "closed",
    );
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
  });

  it.each([false, true])(
    "retains a parsed result when close fails, reporter throws=%s",
    async (throws) => {
      const f = fixture(method);
      const original = new Error("PRIVATE-CLOSE-FAILURE");
      f.close.mockRejectedValue(original);
      if (throws)
        f.reportConnectionCloseFailure.mockImplementation(() => {
          throw new Error("PRIVATE-SINK-FAILURE");
        });
      await expect(f.run()).resolves.toBeDefined();
      expect(f.span().attributes["antnest.mcp.tool_result.outcome"]).toBe("success");
      expect(f.span().attributes["antnest.mcp.connection.close.outcome"]).toBe("failed");
      expect(f.span().events.at(-1)).toMatchObject({
        name: "antnest.mcp.connection.close.completed",
        attributes: { outcome: "failed" },
      });
      expect(f.span().status.code).toBe(SpanStatusCode.ERROR);
      expect(f.reportConnectionCloseFailure).toHaveBeenCalledExactlyOnceWith(
        "runtime",
        "runtime",
        original,
      );
      expect(JSON.stringify(f.span().events)).not.toContain("PRIVATE");
    },
  );

  it.each(["raw", "noop", "disabled"] as const)(
    "does not borrow an ancestor through %s telemetry",
    async (mode) => {
      const f = fixture(method);
      if (mode === "disabled") configureBoundaries({ captureRpcContent: false, disabled: true });
      await trace.getTracer("test").startActiveSpan(`mcp.tools.${method}`, async (span) => {
        try {
          await f.run(
            mode === "raw"
              ? f.raw
              : mode === "noop"
                ? new InstrumentedToolCatalog(f.raw, NOOP_TELEMETRY)
                : f.catalog,
          );
        } finally {
          span.end();
        }
      });
      expect(f.span().events).toEqual([]);
      expect(f.span().attributes["antnest.mcp.method"]).toBeUndefined();
      expect(f.close).toHaveBeenCalledTimes(1);
    },
  );
});

it("retains parsed tool-error and Runtime stopping/effect semantics", async () => {
  const f = fixture("call");
  f.callTool.mockResolvedValue({
    content: [],
    isError: true,
    structuredContent: { error_code: "runtime_busy", effect_state: "none", effect_source: null },
  });
  await expect(f.run()).resolves.toMatchObject({
    isError: true,
    toolEffectState: "none",
    runtimeCallStopped: true,
  });
  expect(f.span().attributes["antnest.mcp.tool_result.outcome"]).toBe("tool_error");
  expect(f.span().attributes["antnest.outcome"]).toBe("tool_error");
  expect(f.span().status.code).toBe(SpanStatusCode.ERROR);
  expect(f.span().events[2]!.attributes).toEqual({ outcome: "tool_error" });
});

it.each(["list", "call"] as const)(
  "retains %s cancellation after connect without claiming dispatch or unknown effects",
  async (method) => {
    const f = fixture(method);
    f.connect.mockImplementation(() => {
      f.caller.abort();
      return Promise.resolve(f.connection);
    });
    if (method === "call")
      await expect(f.run()).rejects.toMatchObject({
        effectState: "none",
        runtimeCallStopped: true,
      });
    else await expect(f.run()).rejects.toMatchObject({ name: "AbortError" });
    expect(f.listTools).not.toHaveBeenCalled();
    expect(f.callTool).not.toHaveBeenCalled();
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(
      f
        .span()
        .events.filter((event) => event.name.startsWith("antnest.mcp."))
        .map((event) => event.name),
    ).toEqual([sequence[0], sequence[3], sequence[4]]);
    expect(f.span().attributes["antnest.mcp.caller_cancelled"]).toBe(true);
  },
);

it("keeps concurrent list and call connections on their own execution and span", async () => {
  const list = fixture("list");
  const call = fixture("call");
  call.snapshot.runtime.executionId = "runtime-execution-2";
  const release = Promise.withResolvers<void>();
  const both = Promise.withResolvers<void>();
  const ids: string[] = [];
  for (const f of [list, call])
    f.connect.mockImplementation(async () => {
      ids.push(trace.getActiveSpan()!.spanContext().spanId);
      if (ids.length === 2) both.resolve();
      await release.promise;
      return f.connection;
    });
  const running = Promise.all([list.run(), call.run()]);
  const joined = running.then(
    () => undefined,
    () => undefined,
  );
  try {
    await bounded(both.promise);
    expect(new Set(ids).size).toBe(2);
  } finally {
    release.resolve();
    await bounded(joined);
  }
  await running;
  expect(list.span().attributes["antnest.runtime.execution.id"]).toBe("runtime-execution-1");
  expect(call.span().attributes["antnest.runtime.execution.id"]).toBe("runtime-execution-2");
  for (const f of [list, call])
    expect(f.span().events.map((event) => event.name)).toEqual(sequence);
});

it.each(["raw", "noop", "instrumented"] as const)(
  "isolates a nested %s catalog from the outer operation",
  async (kind) => {
    const outer = fixture("list");
    const inner = fixture("list");
    const delegate: ToolCatalogPort = {
      list: async (snapshot, signal) => {
        await inner.run(
          kind === "raw"
            ? inner.raw
            : new InstrumentedToolCatalog(
                inner.raw,
                kind === "noop" ? NOOP_TELEMETRY : new ServiceTelemetry("inner"),
              ),
        );
        return outer.raw.list(snapshot, signal);
      },
      call: (input) => outer.raw.call(input),
    };
    // A direct raw call is the first adapter invocation in this explicitly
    // decorated operation. It claims once; subsequent calls cannot borrow it.
    await outer.run(new InstrumentedToolCatalog(delegate, new ServiceTelemetry("outer")));
    const spans = exporter.getFinishedSpans().filter((span) => span.name === "mcp.tools.list");
    expect(spans).toHaveLength(kind === "instrumented" ? 2 : 1);
    for (const span of spans) expect(span.events.map((event) => event.name)).toEqual(sequence);
    if (kind === "instrumented") {
      expect(spans[0]!.parentSpanContext?.spanId).toBe(spans[1]!.spanContext().spanId);
      expect(spans[0]!.spanContext().spanId).not.toBe(spans[1]!.spanContext().spanId);
    }
    expect(inner.close).toHaveBeenCalledTimes(1);
    expect(outer.close).toHaveBeenCalledTimes(1);
  },
);

it("claims before dependency reentry and does not let a second same-execution call reuse it", async () => {
  const outer = fixture("list");
  const inner = fixture("list");
  const revisions = vi.fn(async () => {
    await inner.run(inner.raw);
    return [];
  });
  const adapter = new McpToolCatalog({
    runtimeDialer: { connect: outer.connect },
    revisions: { getClientMcpRevision: revisions },
  });
  let atInner: string[] = [];
  inner.connect.mockImplementation(() => {
    const events = vi.spyOn(trace.getActiveSpan()!, "addEvent");
    inner.close.mockImplementation(() => {
      atInner = events.mock.calls.map(([name]) => name);
      return Promise.resolve();
    });
    return Promise.resolve(inner.connection);
  });
  await outer.run(new InstrumentedToolCatalog(adapter, new ServiceTelemetry("outer")));
  expect(atInner).toEqual([]);
  expect(outer.span().events.map((event) => event.name)).toEqual(sequence);
});

it("does not attach delayed adapter work after its instrumented operation settled", async () => {
  const f = fixture("list");
  const release = Promise.withResolvers<void>();
  let late: Promise<unknown> = Promise.resolve();
  const wrapped = new InstrumentedToolCatalog(
    {
      list: () => {
        late = release.promise.then(async () => {
          await f.run(f.raw);
        });
        return Promise.resolve([]);
      },
      call: (input) => f.raw.call(input),
    },
    new ServiceTelemetry("late"),
  );
  try {
    await f.run(wrapped);
  } finally {
    release.resolve();
    await bounded(late);
  }
  expect(f.span().events).toEqual([]);
  expect(f.span().attributes["antnest.mcp.tool_result.outcome"]).toBe("not_received");
  expect(f.close).toHaveBeenCalledTimes(1);
});
