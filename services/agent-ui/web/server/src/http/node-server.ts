import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { capturePromptInput, recordStreamDelegation, type BridgeTelemetry } from "../telemetry.ts";
import { parseWorkspaceDocumentPath, type WorkspaceRoute } from "../protocol/workspace-route.ts";
import { readWorkspacePrincipal } from "./workspace-principal.ts";
import type { RequestAuthentication } from "./request-authentication.ts";
import { bindAuthenticatedRequest, copyAuthenticatedRequest } from "./trusted-identity.ts";
import { HttpInputError, requireJsonMedia, validateJsonRequest } from "./json-request.ts";
import { recordEventStreamCompletion } from "./event-routes.ts";
import { UploadAdmission, maximumControlRequestBytes, maximumJsonRequestBytes } from "./upload-admission.ts";

type WorkspaceHandler = { handle(request: Request): Promise<Response | null> };
type DocumentOptions = {
  authentication: RequestAuthentication;
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

export function createWorkspaceHttpServer(runtime: WorkspaceHandler, options: DocumentOptions): Server {
  if (!options?.authentication) throw new Error("Workspace authentication is required");
  const deadlineMs = options.requestDeadlineMs ?? 60_000;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1)
    throw new RangeError("Invalid ordinary HTTP deadline");
  const uploads = new UploadAdmission();
  const listener = (incoming: IncomingMessage, outgoing: ServerResponse) => {
    const work = async () => {
      await serve(runtime, options, incoming, outgoing, uploads);
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
  };
  const server = options.authentication.workload.serverTLS
    ? createHttpsServer(options.authentication.workload.serverTLS, listener)
    : createServer(listener);
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
  const route = parseWorkspaceDocumentPath(path);
  if (route?.agentId) return route.sessionId === null ? "/workspace/:agentId/" : "/workspace/:agentId/sessions/:sessionId";
  if (path.startsWith("/api/app/workspace/v1/")) return "/api/app/workspace/v1/*";
  return "other";
}

async function serve(
  runtime: WorkspaceHandler,
  options: DocumentOptions,
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  uploads: UploadAdmission,
): Promise<void> {
  let releaseUpload: (() => void) | undefined;
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
    const admitted = await options.authentication.admit(incoming);
    if ("status" in admitted) {
      const failure = workspaceFailure(admitted.status, admitted.code);
      if (admitted.challenge) failure.headers.set("www-authenticate", admitted.challenge);
      outgoing.writeHead(failure.status, Object.fromEntries(failure.headers));
      outgoing.end(await failure.text());
      return;
    }
    if (!admitted.policy.known) {
      const failure = workspaceFailure(404, "route_not_found");
      outgoing.writeHead(failure.status, Object.fromEntries(failure.headers));
      outgoing.end(await failure.text()); return;
    }
    if (admitted.policy.json) requireJsonMedia(incoming);
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
    if (assetName) { outgoing.writeHead(404, { "cache-control": "no-store" }).end(); return; }
    const promptUpload = admitted.policy.json && /\/prompts$/u.test(new URL(url, "http://workspace.internal").pathname);
    if (promptUpload)
      releaseUpload = uploads.acquire(admitted.context!.claims.org, admitted.context!.claims.sub,
        incoming.headers["content-length"]);
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (name === "cookie" || name === "authorization" || value === undefined ||
        (name.startsWith("x-antnest-") && name !== "x-antnest-organization-slug" && name !== "x-antnest-organization-name") ||
        name === "antnest-service-authorization" || name === "antnest-caller-context") continue;
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
    if (admitted.context) bindAuthenticatedRequest(request, admitted.context);
    if (url.startsWith("/workspace/") &&
      (method === "GET" || method === "HEAD") && options.renderDocument) {
      const route = parseWorkspaceDocumentPath(url);
      if (!route) {
        outgoing.writeHead(404, { "cache-control": "private, no-store" }).end();
        return;
      }
      await serveDocument(runtime, options.renderDocument, request, outgoing, route);
      return;
    }
    const eventStream = method === "GET" &&
      /^\/api\/app\/workspace\/v1\/agents\/[^/]+\/events$/u.test(new URL(request.url).pathname);
    if (!eventStream) {
      const dispatch = admitted.policy.json ? {
        handle: async (request: Request) => {
          // A client deadline may finish the HTTP response while authorization is
          // still unwinding. The dispatch, not that response, owns the reservation.
          const release = releaseUpload;
          releaseUpload = undefined;
          try {
            return await runtime.handle(await validateJsonRequest(request,
              promptUpload ? maximumJsonRequestBytes : maximumControlRequestBytes,
              promptUpload ? capturePromptInput() : undefined));
          } finally { release?.(); }
        },
      } : runtime;
      await serveOrdinary(dispatch, request, outgoing, disconnect, options.requestDeadlineMs ?? 60_000);
      return;
    }
    // The original verified delegation caps this subscription. Gateway's live
    // session revalidation does not replace the CCT already delivered to Node.
    const delegationExpiresAt = admitted.context!.claims.exp * 1000;
    recordStreamDelegation(delegationExpiresAt);
    await serveEventStream(runtime, request, outgoing, disconnect, delegationExpiresAt);
  } catch (cause) {
    if (outgoing.destroyed) return;
    if (outgoing.headersSent) {
      outgoing.destroy();
      return;
    }
    if (cause instanceof HttpInputError) {
      const failure = workspaceFailure(cause.status, cause.code);
      if (cause.status === 413 || cause.status === 429) failure.headers.set("connection", "close");
      if (cause.status === 429) failure.headers.set("retry-after", "1");
      outgoing.writeHead(failure.status, Object.fromEntries(failure.headers));
      outgoing.end(await failure.text()); return;
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
  } finally { releaseUpload?.(); }
}

async function serveEventStream(
  runtime: WorkspaceHandler,
  request: Request,
  output: ServerResponse,
  disconnect: AbortController,
  expiresAt: number,
): Promise<void> {
  const retire = () => {
    disconnect.abort(new Error("Workspace stream delegation expired"));
    // Also wake a native writer blocked on drain. Expiry requests a fresh
    // authenticated observation; it is not browser logout or ACP cancellation.
    output.destroy();
  };
  const assertOpen = () => {
    if (Date.now() >= expiresAt) retire();
    request.signal.throwIfAborted();
  };
  if (request.signal.aborted || output.destroyed) return;
  if (Date.now() >= expiresAt) { retire(); return; }
  let abort!: () => void;
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => reject(request.signal.reason);
    request.signal.addEventListener("abort", abort, { once: true });
  });
  const timer = setTimeout(retire, expiresAt - Date.now());
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let finished = false;
  const responseTask = async () => {
    const response = await runtime.handle(request) ?? workspaceFailure(404, "route_not_found");
    if (request.signal.aborted || Date.now() >= expiresAt) {
      await response.body?.cancel();
      assertOpen();
    }
    return response;
  };
  try {
    const response = await Promise.race([responseTask(), interrupted]);
    // Own the body before the final delivery check so an expiry in the async
    // handoff cannot leave an acquired subscription without cancellation.
    reader = response.body?.getReader();
    assertOpen();
    output.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.headers.get("content-type")?.startsWith("text/event-stream")) output.flushHeaders();
    if (reader) {
      for (;;) {
        const part = await Promise.race([reader.read(), interrupted]);
        assertOpen();
        if (part.done) {
          finished = true;
          if (!output.destroyed && output.headersSent && response.status === 200 &&
            response.headers.get("content-type")?.startsWith("text/event-stream"))
            recordEventStreamCompletion(response);
          break;
        }
        if (!output.write(part.value)) await Promise.race([waitForDrainOrClose(output), interrupted]);
      }
    }
    if (!output.destroyed) output.end();
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", abort);
    if (reader) {
      try { if (!finished) await reader.cancel(); }
      finally { reader.releaseLock(); }
    }
  }
}

function workspaceFailure(status: number, code: string): Response {
  return Response.json({ code, message: "Workspace request was rejected", requestId: randomUUID(),
    retryable: status >= 500 || status === 429,
    recovery: status === 401 ? "login" : status === 429 ? "refresh" : status >= 500 ? "retry_read" : "none" },
    { status, headers: { "cache-control": "no-store" } });
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
  route: WorkspaceRoute,
): Promise<void> {
  if (readWorkspacePrincipal(request.headers) === null) {
    output.writeHead(401, { "cache-control": "private, no-store" }).end();
    return;
  }
  let bootstrap: unknown;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 150);
  try {
    const bootstrapRequest = new Request("http://workspace.internal/api/app/workspace/v1/bootstrap", {
      method: "GET",
      headers: request.headers,
      signal: AbortSignal.any([request.signal, controller.signal]),
    });
    copyAuthenticatedRequest(request, bootstrapRequest);
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
