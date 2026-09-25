import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { BridgeTelemetry } from "../telemetry.ts";

type WorkspaceHandler = { handle(request: Request): Promise<Response | null> };
type WorkspaceRoute = { agentId: string; sessionId: string | null };
type DocumentOptions = {
  assetRoot?: string;
  requestDeadlineMs?: number;
  isDraining?: () => boolean;
  telemetry?: Pick<BridgeTelemetry, "observeHttp">;
  renderDocument?(output: ServerResponse, input: {
    bootstrap?: unknown;
    route: WorkspaceRoute;
    nonce: string;
  }): Promise<void>;
};

export function createWorkspaceHttpServer(runtime: WorkspaceHandler, options: DocumentOptions = {}): Server {
  const deadlineMs = options.requestDeadlineMs ?? 60_000;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1)
    throw new RangeError("Invalid ordinary HTTP deadline");
  const server = createServer((incoming, outgoing) => {
    const work = async () => {
      await serve(runtime, options, incoming, outgoing);
      return outgoing.statusCode;
    };
    const observed = options.telemetry
      ? options.telemetry.observeHttp(incoming.method ?? "GET", metricRoute(incoming.url), work, {
        traceparent: incoming.headers.traceparent,
        tracestate: incoming.headers.tracestate,
      })
      : work();
    void observed.catch(() => {
      if (outgoing.headersSent) outgoing.destroy();
      else outgoing.writeHead(503).end();
    });
  });
  server.requestTimeout = 60_000;
  server.headersTimeout = 65_000;
  return server;
}

function metricRoute(url: string | undefined): string {
  if (url === undefined) return "other";
  let path: string;
  try { path = new URL(url, "http://workspace.internal").pathname; }
  catch { return "other"; }
  if (path === "/status" || path === "/live" || path === "/workspace/") return path;
  if (path.startsWith("/workspace/assets/")) return "/workspace/assets/*";
  if (path.startsWith("/api/app/workspace/v1/")) return "/api/app/workspace/v1/*";
  return "other";
}

async function serve(
  runtime: WorkspaceHandler,
  options: DocumentOptions,
  incoming: IncomingMessage,
  outgoing: ServerResponse,
): Promise<void> {
  try {
    const url = incoming.url;
    if (url === undefined || !url.startsWith("/") || url.startsWith("//")) {
      outgoing.writeHead(400).end();
      return;
    }
    if (url === "/status" && incoming.method === "GET") {
      const draining = options.isDraining?.() ?? false;
      outgoing.writeHead(draining ? 503 : 200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      outgoing.end(
        JSON.stringify({ status: draining ? "draining" : "ready", service: "agent-ui-bridge" }),
      );
      return;
    }
    if (url === "/live" && incoming.method === "GET") {
      outgoing.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      outgoing.end(JSON.stringify({ status: "alive", service: "agent-ui-bridge" }));
      return;
    }
    if (options.isDraining?.()) {
      outgoing.writeHead(503, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "retry-after": "1",
      });
      outgoing.end(JSON.stringify({
        code: "workspace_unavailable",
        message: "Workspace is draining",
        requestId: randomUUID(),
        retryable: true,
        recovery: "retry_read",
      }));
      return;
    }
    const assetName = new URL(url, "http://workspace.internal").pathname.match(/^\/workspace\/assets\/([A-Za-z0-9_.-]+)$/)?.[1];
    if (assetName && options.assetRoot && (incoming.method === "GET" || incoming.method === "HEAD")) {
      try {
        const bytes = await readFile(join(options.assetRoot, assetName));
        const contentType = assetName.endsWith(".css") ? "text/css; charset=utf-8" :
          assetName.endsWith(".js") ? "text/javascript; charset=utf-8" :
          assetName.endsWith(".svg") ? "image/svg+xml" : "application/octet-stream";
        outgoing.writeHead(200, {
          "content-type": contentType,
          "cache-control": "public, max-age=31536000, immutable",
          "x-content-type-options": "nosniff",
        });
        outgoing.end(incoming.method === "HEAD" ? undefined : bytes);
      } catch {
        outgoing.writeHead(404).end();
      }
      return;
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (name === "cookie" || value === undefined) continue;
      if (Array.isArray(value))
        for (const item of value) headers.append(name, item);
      else headers.set(name, value);
    }
    const method = incoming.method ?? "GET";
    const disconnect = new AbortController();
    outgoing.once("close", () => disconnect.abort());
    const request = new Request(new URL(url, "http://workspace.internal"), {
      method,
      headers,
      signal: disconnect.signal,
      ...(["GET", "HEAD"].includes(method)
        ? {}
        : {
            body: Readable.toWeb(incoming) as ReadableStream<Uint8Array>,
            duplex: "half",
          }),
    } as RequestInit & { duplex?: "half" });
    if (new URL(request.url).pathname === "/workspace/" &&
      (method === "GET" || method === "HEAD") && options.renderDocument) {
      await serveDocument(runtime, options.renderDocument, request, outgoing);
      return;
    }
    const eventStream = method === "GET" &&
      /^\/api\/app\/workspace\/v1\/agents\/[^/]+\/events$/u.test(new URL(request.url).pathname);
    if (!eventStream) {
      await serveOrdinary(runtime, request, outgoing, disconnect, options.requestDeadlineMs ?? 60_000);
      return;
    }
    const result = await runtime.handle(request);
    const response =
      result ??
      Response.json(
        {
          code: "route_not_found",
          message: "Workspace route was not found",
          requestId: randomUUID(),
          retryable: false,
          recovery: "none",
        },
        { status: 404 },
      );
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.headers.get("content-type")?.startsWith("text/event-stream"))
      outgoing.flushHeaders();
    if (response.body === null) {
      outgoing.end();
      return;
    }
    for await (const part of response.body) {
      if (outgoing.destroyed) break;
      if (!outgoing.write(part)) await waitForDrainOrClose(outgoing);
    }
    if (!outgoing.destroyed) outgoing.end();
  } catch {
    if (outgoing.destroyed) return;
    if (outgoing.headersSent) {
      outgoing.destroy();
      return;
    }
    outgoing.writeHead(503, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    outgoing.end(
      JSON.stringify({
        code: "workspace_unavailable",
        message: "Workspace is unavailable",
        requestId: randomUUID(),
        retryable: true,
        recovery: "retry_read",
      }),
    );
  }
}

class HttpDeadlineError extends Error {}

async function serveOrdinary(
  runtime: WorkspaceHandler,
  request: Request,
  output: ServerResponse,
  disconnect: AbortController,
  deadlineMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let abort!: () => void;
  const interrupted = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new HttpDeadlineError()), deadlineMs);
    abort = () => reject(request.signal.reason);
    request.signal.addEventListener("abort", abort, { once: true });
  });
  const read = async () => {
    const response = await runtime.handle(request) ?? Response.json({
      code: "route_not_found", message: "Workspace route was not found",
      requestId: randomUUID(), retryable: false, recovery: "none",
    }, { status: 404 });
    if (request.signal.aborted) {
      await response.body?.cancel();
      request.signal.throwIfAborted();
    }
    const chunks: Uint8Array[] = [];
    if (response.body !== null && request.method !== "HEAD") {
      reader = response.body.getReader();
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          chunks.push(part.value);
        }
      } finally { reader.releaseLock(); reader = undefined; }
    } else await response.body?.cancel();
    return { response, bytes: Buffer.concat(chunks) };
  };
  try {
    const { response, bytes } = await Promise.race([read(), interrupted]);
    if (output.destroyed) return;
    output.writeHead(response.status, Object.fromEntries(response.headers));
    output.end(bytes);
  } catch (cause) {
    if (cause instanceof HttpDeadlineError && !output.destroyed) {
      const prompt = /\/prompts$|\/operations\/[^/]+\/cancel$/u.test(new URL(request.url).pathname);
      output.writeHead(504, { "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store", connection: "close" });
      output.end(JSON.stringify({ code: "workspace_deadline_exceeded",
        message: "Workspace request timed out", requestId: randomUUID(), retryable: true,
        recovery: prompt ? "query_operation" : request.method === "GET" ? "retry_read" : "refresh" }));
      // Only this HTTP wait expires. Accepted ACP work has its own lifetime.
      disconnect.abort(cause);
    } else if (!output.destroyed) throw cause;
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", abort);
    if (reader !== undefined) void reader.cancel().catch(() => {});
  }
}

async function serveDocument(
  runtime: WorkspaceHandler,
  renderDocument: NonNullable<DocumentOptions["renderDocument"]>,
  request: Request,
  output: ServerResponse,
): Promise<void> {
  const organizationId = request.headers.get("x-antnest-organization-id");
  const principalId = request.headers.get("x-antnest-principal-id");
  const administrator = request.headers.get("x-antnest-administrator");
  const validId = (value: string | null) =>
    value !== null && value.length > 0 && value.length <= 256 &&
    !/[\u0000-\u001f\u007f]/.test(value);
  if (!validId(organizationId) || !validId(principalId) ||
    (administrator !== "true" && administrator !== "false")) {
    output.writeHead(401, { "cache-control": "private, no-store" }).end();
    return;
  }
  const url = new URL(request.url);
  const route: WorkspaceRoute = {
    agentId: url.searchParams.get("agent") ?? "",
    sessionId: url.searchParams.get("session"),
  };
  let bootstrap: unknown;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 150);
  try {
    const bootstrapRequest = new Request("http://workspace.internal/api/app/workspace/v1/bootstrap", {
      method: "GET",
      headers: request.headers,
      signal: AbortSignal.any([request.signal, controller.signal]),
    });
    const result = await Promise.race([
      runtime.handle(bootstrapRequest).then(async (response) => ({
        status: response?.status,
        bootstrap: response?.ok ? await response.json() as unknown : undefined,
      })),
      new Promise<null>((resolve) => controller.signal.addEventListener("abort", () => resolve(null), { once: true })),
    ]);
    if (result?.status === 401 || result?.status === 403) {
      output.writeHead(result.status, { "cache-control": "private, no-store" }).end();
      return;
    }
    bootstrap = result?.bootstrap;
  } catch {
    // The authenticated shell remains usable when discovery is temporarily unavailable.
  } finally {
    clearTimeout(timeout);
  }
  const nonce = randomUUID().replaceAll("-", "");
  output.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`,
  });
  if (request.method === "HEAD") { output.end(); return; }
  await renderDocument(output, { bootstrap, route, nonce });
}

function waitForDrainOrClose(response: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      response.off("drain", done);
      response.off("close", done);
      resolve();
    };
    response.once("drain", done);
    response.once("close", done);
  });
}
