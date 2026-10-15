import { createServer, type ServerResponse } from "node:http";
import { context, propagation, SpanKind, trace } from "@opentelemetry/api";
import { node, tracing } from "@opentelemetry/sdk-node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { OfficialMcpDialer } from "../../../../../services/agent-acp-service/src/adapters/mcp/official-client.js";
import { McpToolCatalog } from "../../../../../services/agent-acp-service/src/adapters/mcp/tool-catalog.js";
import { configureBoundaries } from "../../../../../services/agent-acp-service/src/telemetry/diagnostics.js";
import { runtimeInformation } from "../../../../../services/agent-acp-service/test/fixtures/runtime-information.js";
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

type Mode =
  | "server-held"
  | "server-finished"
  | "invalid-resource"
  | "caller-abort"
  | "http-error";
const micros = ([seconds, nanos]: readonly [number, number]) =>
  seconds * 1_000_000 + nanos / 1000;

async function peer(mode: Mode) {
  const received = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  const disconnected = Promise.withResolvers<void>();
  const releaseEOF = Promise.withResolvers<void>();
  const consumedEOF = Promise.withResolvers<void>();
  const failures: unknown[] = [];
  const requests: { spanId: string; resource: boolean }[] = [];
  let bytes = 0;
  let held: ServerResponse | undefined;
  const handler = createMcpHandler(
    () => {
      const server = new McpServer({
        name: "runtime-read-close",
        version: "1.0.0",
      });
      server.registerResource(
        "info",
        "antnest://runtime/info",
        { mimeType: "application/json" },
        (uri) => {
          const { executionId, ...information } = {
            ...runtimeInformation(),
            executionId: "execution-1",
          };
          information.instructions!.content = "PRIVATE-RESOURCE-CONTENT";
          return {
            contents: [
              {
                uri: uri.toString(),
                mimeType: "application/json",
                text:
                  mode === "invalid-resource"
                    ? "{}"
                    : JSON.stringify({
                        execution_id: executionId,
                        ...information,
                      }),
              },
            ],
          };
        },
      );
      return server;
    },
    { legacy: "reject" },
  );
  const server = createServer((request, response) => {
    void (async () => {
      if (!authority.admit(request, response)) return;
      const chunks: Buffer[] = [];
      for await (const chunk of request)
        chunks.push(Buffer.from(chunk as Uint8Array));
      const body = Buffer.concat(chunks);
      const message = body.length
        ? (JSON.parse(body.toString()) as { method?: string })
        : {};
      const resource = message.method === "resources/read";
      const parent = String(request.headers.traceparent ?? "");
      expect(parent).toMatch(/^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/u);
      requests.push({ spanId: parent.split("-")[2]!, resource });
      if (resource) {
        held = response;
        response.once("finish", () => finished.resolve());
        response.once("close", () => disconnected.resolve());
      }
      if (resource && mode === "http-error") {
        response
          .writeHead(503, { "content-type": "application/json" })
          .end('{"error":"unavailable"}');
        received.resolve();
        return;
      }
      if (resource && mode === "caller-abort") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write("event: message\ndata: ");
        received.resolve();
        return;
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (Array.isArray(value))
          for (const part of value) headers.append(name, part);
        else if (value !== undefined) headers.set(name, value);
      }
      const result = await handler.fetch(
        new Request(`http://${request.headers.host}${request.url}`, {
          method: request.method ?? "GET",
          headers,
          ...(body.length ? { body: new Uint8Array(body) } : {}),
        }),
      );
      const content = Buffer.from(await result.arrayBuffer());
      result.headers.forEach((value, name) => response.setHeader(name, value));
      response.statusCode = result.status;
      if (!resource) {
        response.end(content);
        return;
      }
      expect(result.status).toBe(200);
      const payload = result.headers
        .get("content-type")
        ?.includes("application/json")
        ? Buffer.from(`event: message\ndata: ${content.toString()}\n\n`)
        : content;
      response.removeHeader("content-length");
      response.setHeader("content-type", "text/event-stream");
      bytes = payload.byteLength;
      if (mode === "server-finished") response.end(payload);
      else response.write(payload);
      received.resolve();
    })().catch((error: unknown) => {
      failures.push(error);
      received.resolve();
      response.destroy();
    });
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
  const endpoint = new URL(`http://127.0.0.1:${address.port}/mcp`);
  const authority = runtimeAuthority(endpoint);
  const connections = {
    fetchFor(binding: typeof authority.binding): typeof fetch {
      const send = authority.connections.fetchFor(binding);
      return async (input, init) => {
        const response = await send(input, init);
        if (
          mode !== "server-finished" ||
          !response.headers.get("content-type")?.includes("text/event-stream")
        )
          return response;
        // The real TCP response has finished; hold only consumer-visible EOF.
        // This deterministically distinguishes server completion from SDK receipt.
        const complete = new Uint8Array(await response.arrayBuffer());
        await finished.promise;
        const signal = init?.signal;
        const release = () => releaseEOF.resolve();
        signal?.addEventListener("abort", release, { once: true });
        if (signal?.aborted) release();
        const body = new ReadableStream<Uint8Array>(
          {
            start(controller) {
              controller.enqueue(complete);
            },
            async pull(controller) {
              await releaseEOF.promise;
              controller.close();
              signal?.removeEventListener("abort", release);
              consumedEOF.resolve();
            },
            cancel() {
              release();
              signal?.removeEventListener("abort", release);
              consumedEOF.resolve();
            },
          },
          { highWaterMark: 0 },
        );
        return new Response(body, {
          status: response.status,
          headers: response.headers,
        });
      };
    },
  };
  const catalog = new McpToolCatalog({
    runtimeDialer: new OfficialMcpDialer({ trust: "runtime", connections }),
    revisions: { getClientMcpRevision: () => Promise.resolve([]) },
  });
  return {
    catalog,
    binding: authority.binding,
    received: received.promise,
    disconnected: disconnected.promise,
    finished: finished.promise,
    bytes: () => bytes,
    requests,
    async close() {
      releaseEOF.resolve();
      held?.destroy();
      const cleanup = await Promise.allSettled([
        handler.close(),
        authority.connections.close(),
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        }),
      ]);
      for (const result of cleanup)
        if (result.status === "rejected") failures.push(result.reason);
      expect(failures).toEqual([]);
    },
    consumedEOF: consumedEOF.promise,
  };
}

function observed(fixture: Awaited<ReturnType<typeof peer>>) {
  const spans = exporter.getFinishedSpans();
  const reads = spans.filter((span) => span.name === "mcp.runtime.info.read");
  expect(reads).toHaveLength(1);
  const read = reads[0]!;
  const clients = spans.filter(
    (span) =>
      span.kind === SpanKind.CLIENT &&
      span.parentSpanContext?.spanId === read.spanContext().spanId,
  );
  expect(clients.map((span) => span.spanContext().spanId).sort()).toEqual(
    fixture.requests.map((request) => request.spanId).sort(),
  );
  const resource = fixture.requests.filter((request) => request.resource);
  expect(resource).toHaveLength(1);
  const client = clients.find(
    (span) => span.spanContext().spanId === resource[0]!.spanId,
  )!;
  expect(client.attributes["http.request.method"]).toBe("POST");
  return { read, client };
}

function bounded<Result>(
  promise: Promise<Result>,
  signal: AbortSignal,
): Promise<Result> {
  let abort = () => {};
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => {
      const reason: unknown = signal.reason;
      reject(
        reason instanceof Error
          ? reason
          : new Error("MCP operation interrupted", { cause: reason }),
      );
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  return Promise.race([promise, interrupted]).finally(() =>
    signal.removeEventListener("abort", abort),
  );
}

function operation(fixture: Awaited<ReturnType<typeof peer>>) {
  const caller = new AbortController();
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(new Error("MCP operation deadline")),
    5000,
  );
  const result = fixture.catalog.readBinding(
    fixture.binding,
    AbortSignal.any([caller.signal, deadline.signal]),
  );
  const outcome = result.then(
    (value) => ({ status: "resolved" as const, value }),
    () => ({ status: "rejected" as const }),
  );
  return {
    caller,
    outcome,
    wait: <Result>(promise: Promise<Result>) =>
      bounded(promise, deadline.signal),
    async close() {
      clearTimeout(timer);
      caller.abort();
      const cleanupDeadline = new AbortController();
      const cleanupTimer = setTimeout(
        () => cleanupDeadline.abort(new Error("MCP cleanup deadline")),
        3000,
      );
      try {
        const cleanup = await Promise.allSettled([
          bounded(fixture.close(), cleanupDeadline.signal),
          bounded(outcome, cleanupDeadline.signal),
        ]);
        const failed = cleanup.filter((item) => item.status === "rejected");
        expect(failed).toEqual([]);
      } finally {
        clearTimeout(cleanupTimer);
      }
    },
  };
}

describe("official MCP information read cleanup", () => {
  it.each(["server-held", "server-finished"] as const)(
    "binds actual SDK cancellation after parsed read with %s EOF",
    async (mode) => {
      const fixture = await peer(mode);
      const running = operation(fixture);
      try {
        expect(await running.wait(running.outcome)).toMatchObject({
          status: "resolved",
          value: { executionId: "execution-1" },
        });
        await running.wait(fixture.disconnected);
        if (mode === "server-finished") {
          await running.wait(fixture.finished);
          await running.wait(fixture.consumedEOF);
        }
        const { read, client } = observed(fixture);
        expect(read.attributes["antnest.mcp.resource_read.outcome"]).toBe(
          "success",
        );
        expect(read.attributes["antnest.mcp.connection.close.outcome"]).toBe(
          "closed",
        );
        expect(read.attributes["antnest.mcp.caller_cancelled"]).toBe(false);
        expect(client.attributes).toMatchObject({
          "http.response.status_code": 200,
          "http.response.body.size": fixture.bytes(),
          "antnest.outcome": "cancelled",
          "antnest.cancellation.type": "AbortError",
        });
        expect(client.events).toHaveLength(1);
        expect(client.events[0]!.name).toBe("antnest.cancelled");
        const times = Object.fromEntries(
          read.events.map((event) => [event.name, micros(event.time)]),
        );
        const cancelledAt = micros(client.events[0]!.time);
        expect(times["antnest.mcp.resource.validated"]!).toBeLessThanOrEqual(
          times["antnest.mcp.connection.close.started"]!,
        );
        expect(cancelledAt).toBeGreaterThanOrEqual(
          times["antnest.mcp.connection.close.started"]!,
        );
        expect(cancelledAt).toBeLessThanOrEqual(
          times["antnest.mcp.connection.close.completed"]!,
        );
        expect(JSON.stringify(spansForPrivacy())).not.toContain("PRIVATE");
      } finally {
        await running.close();
      }
    },
  );

  it.each(["invalid-resource", "caller-abort", "http-error"] as const)(
    "does not attribute %s to a successful read cleanup",
    async (mode) => {
      const fixture = await peer(mode);
      const running = operation(fixture);
      try {
        await running.wait(fixture.received);
        if (mode === "caller-abort") running.caller.abort();
        expect((await running.wait(running.outcome)).status).toBe("rejected");
        const { read } = observed(fixture);
        expect(read.attributes["antnest.mcp.resource_read.outcome"]).toBe(
          "failed",
        );
        expect(read.attributes["antnest.mcp.caller_cancelled"]).toBe(
          mode === "caller-abort",
        );
        expect(read.events.map((event) => event.name)).not.toContain(
          "antnest.mcp.resource.validated",
        );
      } finally {
        await running.close();
      }
    },
  );
});

function spansForPrivacy() {
  return exporter
    .getFinishedSpans()
    .map((span) => ({ attributes: span.attributes, events: span.events }));
}
