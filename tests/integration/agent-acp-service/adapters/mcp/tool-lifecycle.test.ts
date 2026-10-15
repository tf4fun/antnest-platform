import { createServer, type ServerResponse } from "node:http";
import {
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { node, tracing } from "@opentelemetry/sdk-node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { z } from "zod";
import { OfficialMcpDialer } from "../../../../../services/agent-acp-service/src/adapters/mcp/official-client.js";
import { McpToolCatalog } from "../../../../../services/agent-acp-service/src/adapters/mcp/tool-catalog.js";
import { configureBoundaries } from "../../../../../services/agent-acp-service/src/telemetry/diagnostics.js";
import { InstrumentedToolCatalog } from "../../../../../services/agent-acp-service/src/telemetry/instrumented-ports.js";
import { ServiceTelemetry } from "../../../../../services/agent-acp-service/src/telemetry/telemetry.js";
import { runtimeSnapshot } from "../../../../../services/agent-acp-service/test/fixtures/runtime-information.js";
import { runtimeAuthority } from "../../support/runtime-authority.js";

const exporter = new tracing.InMemorySpanExporter();
const provider = new node.NodeTracerProvider({
  spanProcessors: [new tracing.SimpleSpanProcessor(exporter)],
});
beforeAll(() => provider.register());
beforeEach(() => {
  exporter.reset();
  configureBoundaries({ captureRpcContent: false, disabled: false });
});
afterAll(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
  propagation.disable();
});

type Method = "list" | "call";
type Mode = "success" | "http-error" | "caller-abort" | "tool-error";
const nanos = ([seconds, fraction]: readonly [number, number]) =>
  BigInt(seconds) * 1_000_000_000n + BigInt(fraction);

async function bounded<T>(
  promise: Promise<T>,
  milliseconds = 4000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("MCP tool peer barrier deadline")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function peer(method: Method, mode: Mode) {
  const arrived = Promise.withResolvers<void>();
  const discoveryFinished = Promise.withResolvers<void>();
  const releaseTool = Promise.withResolvers<void>();
  const answered = Promise.withResolvers<void>();
  const disconnected = Promise.withResolvers<void>();
  const requests: { method: string; traceId: string; spanId: string }[] = [];
  const failures: unknown[] = [];
  const handlers = new Set<Promise<void>>();
  let discovery: ServerResponse | undefined;
  let held: ServerResponse | undefined;
  const handler = createMcpHandler(
    () => {
      const server = new McpServer({
        name: "tool-lifecycle-peer",
        version: "1",
      });
      server.registerTool(
        "bash",
        {
          description: "PRIVATE-TOOL-DESCRIPTION",
          inputSchema: z.object({ command: z.string() }),
        },
        () =>
          Promise.resolve({
            content: [{ type: "text" as const, text: "PRIVATE-TOOL-CONTENT" }],
            isError: mode === "tool-error",
            structuredContent: {
              effect_state: mode === "tool-error" ? "none" : "settled",
              effect_source: null,
              ...(mode === "tool-error" ? { error_code: "runtime_busy" } : {}),
            },
          }),
      );
      return server;
    },
    { legacy: "reject" },
  );
  const server = createServer((request, response) => {
    const running = (async () => {
      expect(authority.admit(request, response)).toBe(true);
      const chunks: Buffer[] = [];
      for await (const chunk of request)
        chunks.push(Buffer.from(chunk as Uint8Array));
      const body = Buffer.concat(chunks);
      const message = JSON.parse(body.toString()) as { method: string };
      const parent = String(request.headers.traceparent ?? "");
      expect(parent).toMatch(/^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/u);
      requests.push({
        method: message.method,
        traceId: parent.split("-")[1]!,
        spanId: parent.split("-")[2]!,
      });
      const isDiscovery = message.method === "server/discover";
      expect(message.method).toBe(
        isDiscovery ? "server/discover" : `tools/${method}`,
      );
      if (isDiscovery) {
        discovery = response;
        response.once("finish", () => discoveryFinished.resolve());
      } else {
        held = response;
        response.once("close", () => disconnected.resolve());
        expect(
          discovery && !discovery.writableEnded && !discovery.destroyed,
        ).toBe(true);
        arrived.resolve();
        await releaseTool.promise;
        if (mode === "http-error") {
          response
            .writeHead(503, { "content-type": "application/json" })
            .end("{}");
          answered.resolve();
          return;
        }
        if (mode === "caller-abort") {
          response
            .writeHead(200, { "content-type": "text/event-stream" })
            .write("event: message\ndata: ");
          answered.resolve();
          return;
        }
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (Array.isArray(value))
          for (const part of value) headers.append(name, part);
        else if (value !== undefined) headers.set(name, value);
      }
      const result = await handler.fetch(
        new Request(`http://${request.headers.host}${request.url}`, {
          method: request.method ?? "POST",
          headers,
          body: new Uint8Array(body),
        }),
      );
      expect(result.status).toBe(200);
      const content = await result.text();
      const payload = result.headers
        .get("content-type")
        ?.includes("application/json")
        ? `event: message\ndata: ${content}\n\n`
        : content;
      response
        .writeHead(200, { "content-type": "text/event-stream" })
        .write(payload);
      if (!isDiscovery) answered.resolve();
    })().catch((error: unknown) => {
      failures.push(error);
      arrived.resolve();
      answered.resolve();
      response.destroy();
    });
    handlers.add(running);
    void running.finally(() => handlers.delete(running));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("missing peer address");
  const authority = runtimeAuthority(
    new URL(`http://127.0.0.1:${address.port}/mcp`),
  );
  const raw = new McpToolCatalog({
    runtimeDialer: new OfficialMcpDialer({
      trust: "runtime",
      connections: authority.connections,
    }),
    revisions: { getClientMcpRevision: () => Promise.resolve([]) },
  });
  return {
    catalog: new InstrumentedToolCatalog(
      raw,
      new ServiceTelemetry("tool-component"),
    ),
    binding: authority.binding,
    requests,
    failures,
    arrived: arrived.promise,
    discoveryFinished: discoveryFinished.promise,
    answered: answered.promise,
    disconnected: disconnected.promise,
    discoveryEnded: () => discovery?.writableEnded ?? false,
    releaseDiscovery: () => discovery?.end(),
    releaseTool: () => releaseTool.resolve(),
    async close() {
      releaseTool.resolve();
      discovery?.destroy();
      held?.destroy();
      const settled = await Promise.allSettled([
        handler.close(),
        authority.connections.close(),
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        }),
        Promise.all([...handlers]),
      ]);
      expect(settled.filter((result) => result.status === "rejected")).toEqual(
        [],
      );
      expect(failures).toEqual([]);
    },
  };
}

it.each([
  ["list", "success"],
  ["call", "success"],
  ["call", "tool-error"],
  ["list", "http-error"],
  ["call", "http-error"],
  ["list", "caller-abort"],
  ["call", "caller-abort"],
] as const)(
  "binds real tools/%s %s before discovery EOF to its own original receipts",
  async (method, mode) => {
    const f = await peer(method, mode);
    const caller = new AbortController();
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), 6000);
    const signal = AbortSignal.any([caller.signal, deadline.signal]);
    const snapshot = { ...runtimeSnapshot(), runtime: f.binding };
    const running =
      method === "list"
        ? f.catalog.list(snapshot, signal)
        : f.catalog.call({
            runId: "run-1",
            snapshot,
            signal,
            tool: {
              source: "runtime",
              sourceId: "runtime",
              name: "bash",
              modelName: "bash",
              description: "PRIVATE-TOOL-DESCRIPTION",
            },
            arguments: { command: "PRIVATE-TOOL-ARGUMENT" },
          });
    const outcome = running.then(
      (value) => ({ status: "resolved" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    try {
      await bounded(f.arrived);
      expect(f.failures).toEqual([]);
      expect(f.requests.map((request) => request.method)).toEqual([
        "server/discover",
        `tools/${method}`,
      ]);
      expect(f.discoveryEnded()).toBe(false);
      expect(exporter.getFinishedSpans()).toHaveLength(0);
      f.releaseDiscovery();
      await bounded(f.discoveryFinished);
      f.releaseTool();
      await bounded(f.answered);
      if (mode === "caller-abort") caller.abort();
      const actual = await bounded(outcome);
      expect(actual.status).toBe(
        mode === "success" || mode === "tool-error" ? "resolved" : "rejected",
      );
      if (method === "call" && actual.status === "resolved")
        expect(actual.value).toMatchObject({
          isError: mode === "tool-error",
          toolEffectState: mode === "tool-error" ? "none" : "settled",
          runtimeCallStopped: true,
        });
      if (method === "call" && actual.status === "rejected")
        expect(actual.error).toMatchObject({
          effectState: "unknown",
          runtimeCallStopped: false,
        });
      await bounded(f.disconnected);
      const spans = exporter.getFinishedSpans();
      const owners = spans.filter(
        (span) => span.name === `mcp.tools.${method}`,
      );
      expect(owners).toHaveLength(1);
      const owner = owners[0]!;
      const clients = spans.filter((span) => span.kind === SpanKind.CLIENT);
      expect(clients).toHaveLength(2);
      for (const request of f.requests) {
        const client = clients.find(
          (span) => span.spanContext().spanId === request.spanId,
        )!;
        expect(client.spanContext().traceId).toBe(request.traceId);
        expect(client.parentSpanContext?.spanId).toBe(
          owner.spanContext().spanId,
        );
        for (const event of client.events) {
          expect(nanos(event.time)).toBeGreaterThanOrEqual(
            nanos(client.startTime),
          );
          expect(nanos(event.time)).toBeLessThanOrEqual(nanos(client.endTime));
        }
      }
      expect(spans).toHaveLength(3);
      expect(owner.attributes).toMatchObject({
        "antnest.runtime.execution.id": f.binding.executionId,
        "antnest.mcp.method": `tools/${method}`,
        "antnest.mcp.connection.close.outcome": "closed",
        "antnest.mcp.caller_cancelled": mode === "caller-abort",
        "antnest.mcp.tool_result.outcome":
          mode === "success"
            ? "success"
            : mode === "tool-error"
              ? "tool_error"
              : "not_received",
      });
      expect(
        owner.events
          .filter((event) => event.name.startsWith("antnest.mcp."))
          .map((event) => event.name),
      ).toEqual([
        "antnest.mcp.discovery.ready",
        "antnest.mcp.tool.dispatch.started",
        ...(actual.status === "resolved"
          ? ["antnest.mcp.tool.result.parsed"]
          : []),
        "antnest.mcp.connection.close.started",
        "antnest.mcp.connection.close.completed",
      ]);
      if (mode === "tool-error")
        expect(owner.status.code).toBe(SpanStatusCode.ERROR);
      let previous = nanos(owner.startTime);
      for (const event of owner.events) {
        expect(nanos(event.time)).toBeGreaterThanOrEqual(previous);
        expect(nanos(event.time)).toBeLessThanOrEqual(nanos(owner.endTime));
        previous = nanos(event.time);
      }
      expect(
        JSON.stringify(
          spans.map((span) => ({
            attributes: span.attributes,
            events: span.events,
          })),
        ),
      ).not.toContain("PRIVATE");
    } finally {
      clearTimeout(timer);
      caller.abort();
      const settled = await Promise.allSettled([
        bounded(f.close()),
        bounded(outcome),
      ]);
      expect(settled.filter((result) => result.status === "rejected")).toEqual(
        [],
      );
    }
  },
);
