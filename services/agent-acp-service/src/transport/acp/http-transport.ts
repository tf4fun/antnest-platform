import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { createValidatedNodeHttpHandler } from "./validated-node-handler.js";
import type { AcpServer } from "@agentclientprotocol/sdk/experimental/server";
import { TracedAcpHttpServer, recordAcpAccessDenial } from "../../telemetry/acp-http.js";
import type { Span } from "@opentelemetry/api";

import type { ConnectionBinding } from "../../domain/types.js";
import { DomainError } from "../../domain/errors.js";
import { ConnectionCapacity } from "../../application/connection-capacity.js";
import { ConnectionTasks } from "./connection-tasks.js";
import type { AcpApplicationPort } from "../../ports/acp-application.js";
import type { SkillCommandsPort } from "../../ports/skill-commands.js";
import {
  isExecutionAccessRevoked,
  type ExecutionAccessSnapshot,
  type ExecutionIdentity,
} from "../../domain/execution-configuration.js";
import { trustedIdentity } from "../trusted-identity.js";
import { promptCapabilities } from "./capabilities.js";
import { NOOP_TELEMETRY, type TelemetryPort } from "../../ports/telemetry.js";
import type { SessionOutputStreams } from "./session-output.js";
import { createAcpV1Agent } from "./v1/agent.js";
import type { PermissionConnectionsPort } from "../../ports/tool-permissions.js";
import type { LearningNoticePublisher } from "../../application/learning-notice-publisher.js";
import { activeHttpSpan } from "../../telemetry/http.js";
import { recordBoundaryError } from "../../telemetry/diagnostics.js";
import { httpFailure } from "../public-error.js";
import type { AgentOwnershipFence } from "../../domain/agent-ownership.js";

export type HttpOwnerAdmission = {
  fence: AgentOwnershipFence;
  signal: AbortSignal;
  assertCurrent(): void;
  encodeConnectionId(sdkId: string): string;
  admitted?(): void;
};

type Options = {
  permissions?: PermissionConnectionsPort;
  notices?: Pick<LearningNoticePublisher, "subscribe">;
  skillCommands?: SkillCommandsPort;
  application: AcpApplicationPort;
  outputs: SessionOutputStreams;
  ready: () => Promise<boolean>;
  maxWebSocketPayloadBytes: number;
  telemetry?: TelemetryPort;
  capacity?: ConnectionCapacity;
  idleTimeoutMs?: number;
  closeReceiptTimeoutMs?: number;
};

// Each SDK server owns one authorized HTTP connection. The SDK remains the
// authority for its transport ID and queues. This index binds both live traffic
// and bounded cleanup acknowledgements to the original authorized identity.
export class AcpHttpTransport {
  private readonly entries = new Set<HttpConnection>();
  private readonly byId = new Map<string, HttpConnection>();
  private readonly capacityLeases = new Map<HttpConnection, { release(): void }>();
  private readonly capacity: ConnectionCapacity;
  private readonly closing = new Set<Promise<void>>();
  private readonly cleanupFailures = new Map<ConnectionBinding, unknown>();
  private readonly telemetry: TelemetryPort;
  private stopped = false;
  private draining = false;
  private drainPromise: Promise<void> | undefined;
  private readonly drained = Promise.withResolvers<void>();

  public constructor(private readonly options: Options) {
    this.telemetry = options.telemetry ?? NOOP_TELEMETRY;
    this.capacity = options.capacity ?? new ConnectionCapacity();
  }

  public async revokeAccess(snapshot: ExecutionAccessSnapshot): Promise<void> {
    const revoked = [...this.entries].filter((entry) =>
      isExecutionAccessRevoked(snapshot, entry.binding),
    );
    const results = await Promise.allSettled(revoked.map((entry) => this.retire(entry)));
    const errors = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    for (const [binding, error] of this.cleanupFailures)
      if (isExecutionAccessRevoked(snapshot, binding))
        errors.push({ status: "rejected", reason: error });
    if (errors.length)
      throw new AggregateError(
        errors.map((result) => result.reason as unknown),
        "Revoked HTTP connection cleanup failed",
      );
  }

  public async handle(
    request: IncomingMessage,
    response: ServerResponse,
    owner?: HttpOwnerAdmission,
  ): Promise<void> {
    try {
      if (this.stopped || !(await this.available(request.method))) return reply(response, 503);
      if (!["POST", "GET", "DELETE"].includes(request.method ?? "")) {
        response.setHeader("Allow", "POST, GET, DELETE");
        return reply(response, 405);
      }
      const identity = trustedIdentity(request.headers);
      if (identity === null) return reply(response, 401);
      if (this.isStopped() || (this.draining && request.method !== "DELETE") || response.destroyed)
        return reply(response, 503);
      const entry = this.admit(request, response, identity, owner);
      if (entry) await entry.handle(request, response);
    } catch (error) {
      const span = activeHttpSpan();
      if (span !== undefined) recordBoundaryError(span, error, "acp.http.admission");
      this.telemetry.log("error", "acp_http_failed", { protocol: "v1" }, error);
      if (error instanceof DomainError && error.code === "connection_quota_exceeded") {
        if (response.destroyed || response.writableEnded) return;
        const failure = httpFailure(error.code);
        response.writeHead(failure.status, {
          "content-type": "application/json",
          "cache-control": "no-store",
          "retry-after": "1",
        });
        response.end(JSON.stringify(failure.body));
        return;
      }
      reply(response, 503);
    }
  }

  public async close(): Promise<void> {
    this.stop();
    await Promise.allSettled(this.closing);
    if (this.cleanupFailures.size)
      throw new AggregateError(
        [...this.cleanupFailures.values()],
        "HTTP connection cleanup failed",
      );
  }

  /** Normal shutdown preserves existing cleanup receipts for one bounded window. */
  public drain(timeoutMs = 5_000): Promise<void> {
    if (this.drainPromise !== undefined) return this.drainPromise;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5_000)
      throw new RangeError("Invalid ACP HTTP drain timeout");
    this.draining = true;
    this.drainPromise = this.drainOnce(timeoutMs);
    return this.drainPromise;
  }

  private async drainOnce(timeoutMs: number): Promise<void> {
    const timer = setTimeout(() => this.stop(), timeoutMs);
    timer.unref();
    try {
      for (const entry of this.entries) void this.retire(entry).catch(() => undefined);
      if (this.entries.size === 0) this.drained.resolve();
      await this.drained.promise;
    } finally {
      clearTimeout(timer);
      await this.close();
    }
  }

  private stop(): void {
    this.stopped = true;
    for (const entry of this.entries) this.release(entry);
  }

  private async available(method: string | undefined): Promise<boolean> {
    if (this.isDraining()) return method === "DELETE";
    let ready: boolean;
    try {
      ready = await this.options.ready();
    } catch (error) {
      if (!this.isDraining()) throw error;
      ready = false;
    }
    // Shutdown can begin while the original dependency readiness read awaits.
    return this.isDraining() ? method === "DELETE" : ready;
  }

  private isDraining(): boolean {
    return this.draining;
  }

  private isStopped(): boolean {
    return this.stopped;
  }

  private admit(
    request: IncomingMessage,
    response: ServerResponse,
    identity: ExecutionIdentity,
    owner?: HttpOwnerAdmission,
  ): HttpConnection | undefined {
    const id = header(request, "acp-connection-id");
    if (id) {
      const entry = this.byId.get(id);
      if (entry?.receiptExpired()) this.release(entry);
      if (!entry || entry.released) {
        reply(response, 404);
        return;
      }
      const owner = entry.binding;
      if (
        owner.organizationId !== identity.organizationId ||
        owner.principalId !== identity.principalId ||
        owner.agentId !== identity.agentId
      ) {
        reply(response, 403);
        return;
      }
      if (entry.retired && request.method !== "DELETE") {
        reply(response, 404);
        return;
      }
      return entry;
    }
    if (request.method !== "POST") {
      reply(response, 400);
      return;
    }
    owner?.signal.throwIfAborted();
    owner?.assertCurrent();
    const lease = this.capacity.reserve(identity);
    let entry: HttpConnection;
    try {
      const binding: ConnectionBinding = {
        connectionId: randomUUID(),
        ...identity,
        ...(owner === undefined ? {} : { ownerFence: owner.fence }),
      };
      entry = new HttpConnection(binding, {
        application: this.options.application,
        outputs: this.options.outputs,
        ...(owner === undefined ? {} : { owner }),
        ...(this.options.permissions === undefined
          ? {}
          : { permissions: this.options.permissions }),
        ...(this.options.notices === undefined ? {} : { notices: this.options.notices }),
        ...(this.options.skillCommands === undefined
          ? {}
          : { skillCommands: this.options.skillCommands }),
        promptCapabilities,
        maxPayloadBytes: this.options.maxWebSocketPayloadBytes,
        idleTimeoutMs: this.options.idleTimeoutMs ?? 300_000,
        closeReceiptTimeoutMs: this.options.closeReceiptTimeoutMs ?? 300_000,
        register: (id) => this.byId.set(id, entry),
        retire: () => this.retire(entry),
        release: (acknowledged) => this.release(entry, acknowledged),
      });
    } catch (error) {
      lease.release();
      throw error;
    }
    this.entries.add(entry);
    this.capacityLeases.set(entry, lease);
    entry.activateOwner();
    this.telemetry.count("antnest.acp.connections", {
      result: "accepted",
      protocol: "v1",
      transport: "http",
    });
    return entry;
  }

  private retire(entry: HttpConnection): Promise<void> {
    if (entry.retired) return entry.retire();
    const closed = entry.retire();
    this.trackClose(closed, entry);
    if (entry.id === undefined || this.stopped) this.release(entry);
    return closed;
  }

  private release(entry: HttpConnection, acknowledged = false): void {
    if (!this.entries.has(entry)) return;
    if (entry.id) this.byId.delete(entry.id);
    const retired = entry.retired;
    const closed = entry.release(acknowledged);
    if (!retired) this.trackClose(closed, entry);
    this.closing.add(closed);
    // Removing the addressable ID cannot free capacity or shutdown ownership
    // while SDK cleanup or an already admitted response is still outstanding.
    const forget = () => {
      if (this.entries.delete(entry)) {
        this.capacityLeases.get(entry)?.release();
        this.capacityLeases.delete(entry);
      }
      this.closing.delete(closed);
      if (this.draining && this.entries.size === 0) this.drained.resolve();
    };
    void closed.then(forget, forget);
  }

  private trackClose(closed: Promise<void>, entry: HttpConnection): void {
    this.closing.add(closed);
    void closed.then(
      () => {
        this.closing.delete(closed);
      },
      (error: unknown) => {
        this.closing.delete(closed);
        this.cleanupFailures.set(entry.binding, error);
        this.telemetry.log("error", "acp_http_close_failed", {}, error);
      },
    );
    this.telemetry.count("antnest.acp.connections", {
      result: "closed",
      protocol: "v1",
      transport: "http",
    });
  }
}

type ConnectionOptions = {
  owner?: HttpOwnerAdmission;
  permissions?: PermissionConnectionsPort;
  notices?: Pick<LearningNoticePublisher, "subscribe">;
  skillCommands?: SkillCommandsPort;
  application: AcpApplicationPort;
  outputs: SessionOutputStreams;
  promptCapabilities: typeof promptCapabilities;
  maxPayloadBytes: number;
  idleTimeoutMs: number;
  closeReceiptTimeoutMs: number;
  register: (id: string) => void;
  retire: () => Promise<void>;
  release: (acknowledged?: boolean) => void;
};

class HttpConnection {
  public id: string | undefined;
  private sdkId: string | undefined;
  private externalId: string | undefined;
  private readonly ownerLost = () => {
    void this.options.retire().catch(() => undefined);
  };
  private readonly tasks = new ConnectionTasks();
  private readonly server: AcpServer;
  private readonly requests = new Set<ServerResponse>();
  private readonly handlers = new Map<Promise<void>, boolean>();
  private readonly deletes = new Set<ServerResponse>();
  private readonly getSpans = new Map<ServerResponse, Span>();
  private readonly handler: ReturnType<typeof createValidatedNodeHttpHandler>;
  private timer: ReturnType<typeof setTimeout> | undefined;
  public released = false;
  private acknowledged = false;
  private cleanup: Promise<void> | undefined;
  private completion: Promise<void> | undefined;
  private readonly drained = Promise.withResolvers<void>();
  private expiresAt: number | undefined;

  public constructor(
    public readonly binding: ConnectionBinding,
    private readonly options: ConnectionOptions,
  ) {
    this.server = new TracedAcpHttpServer({
      agent: createAcpV1Agent({
        binding,
        ...options,
        tasks: this.tasks,
        onConnectionFailure: (error, source) => {
          for (const [response, span] of this.getSpans) {
            if (
              !response.destroyed &&
              !response.writableEnded &&
              response.headersSent &&
              response.statusCode === 200
            )
              recordAcpAccessDenial(span, error, source, binding);
          }
        },
      }).onConnect((connection) => {
        void connection.closed.then(() => {
          // Remote closure can precede the SDK client's automatic DELETE.
          // Keep the original binding and cleanup result until acknowledgement.
          void options.retire().catch(() => undefined);
        });
      }),
    });
    this.handler = createValidatedNodeHttpHandler(
      { handleRequest: (request) => this.dispatch(request) },
      options.maxPayloadBytes,
    );
  }

  public get retired(): boolean {
    return this.cleanup !== undefined;
  }

  public activateOwner(): void {
    const signal = this.options.owner?.signal;
    signal?.addEventListener("abort", this.ownerLost, { once: true });
    if (signal?.aborted) this.ownerLost();
  }

  public receiptExpired(): boolean {
    return this.expiresAt !== undefined && performance.now() >= this.expiresAt;
  }

  private async dispatch(request: Request): Promise<Response> {
    if (this.released && !this.acknowledged) return new Response(null, { status: 503 });
    if (request.method === "DELETE") {
      // The Node adapter has already validated the complete empty body. Close
      // via the public SDK API while it still owns its connection registry;
      // SDK DELETE removes the entry before its asynchronous shutdown finishes.
      await this.options.retire();
      return new Response(null, {
        status: this.released && !this.acknowledged ? 503 : 202,
      });
    }
    if (this.retired) return new Response(null, { status: 404 });
    if (this.sdkId === undefined) {
      this.options.owner?.signal.throwIfAborted();
      this.options.owner?.assertCurrent();
      this.options.owner?.admitted?.();
    } else if (request.headers.has("acp-connection-id")) {
      // The validated adapter has already copied rawHeaders. Replace the final
      // Fetch Request field, so neither parsed nor raw external IDs reach SDK.
      const headers = new Headers(request.headers);
      headers.set("acp-connection-id", this.sdkId);
      request = new Request(request, { headers });
    }
    const result = await this.server.handleRequest(request);
    const sdkId = result.headers.get("acp-connection-id");
    if (sdkId === null) return result;
    try {
      if (this.sdkId === undefined) {
        this.sdkId = sdkId;
        this.externalId = this.options.owner?.encodeConnectionId(sdkId) ?? sdkId;
      } else if (this.sdkId !== sdkId) throw new Error("HTTP SDK connection identity changed");
      const headers = new Headers(result.headers);
      headers.set("acp-connection-id", this.externalId!);
      return new Response(result.body, {
        status: result.status,
        statusText: result.statusText,
        headers,
      });
    } catch (error) {
      await result.body?.cancel();
      throw error;
    }
  }

  public handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.retired) clearTimeout(this.timer);
    if (request.method === "DELETE") this.deletes.add(response);
    this.requests.add(response);
    const span = activeHttpSpan();
    if (request.method === "GET" && span !== undefined) this.getSpans.set(response, span);
    const responseClosed = new Promise<void>((resolve) => {
      response.once("finish", () => {
        if (this.released) return;
        if (this.id === undefined) {
          const id = response.getHeader("acp-connection-id");
          if (typeof id !== "string" || response.statusCode !== 200) {
            this.options.release();
            return;
          }
          this.id = id;
          this.options.register(id);
        }
        if (request.method === "DELETE" && response.statusCode === 202) this.options.release(true);
      });
      response.once("close", () => {
        this.requests.delete(response);
        this.deletes.delete(response);
        this.getSpans.delete(response);
        if (this.id === undefined) this.options.release();
        if (this.released && this.requests.size === 0) this.drained.resolve();
        if (!this.retired && this.requests.size === 0) {
          this.timer = setTimeout(this.options.release, this.options.idleTimeoutMs);
          this.timer.unref();
        }
        resolve();
      });
    });
    const original = this.handler(request, response);
    this.handlers.set(original, request.method === "DELETE");
    const forget = () => this.handlers.delete(original);
    void original.then(forget, forget);
    return Promise.all([responseClosed, original]).then(() => undefined);
  }

  public retire(): Promise<void> {
    if (this.cleanup !== undefined) return this.cleanup;
    clearTimeout(this.timer);
    this.options.owner?.signal.removeEventListener("abort", this.ownerLost);
    this.closeResponses(true);
    const tasks = this.tasks.close();
    // DELETE calls retire itself; joining that handler here would self-join.
    const originals = [...this.handlers]
      .filter(([, deleting]) => !deleting)
      .map(([original]) => original);
    this.cleanup = Promise.allSettled([this.server.close(), tasks, ...originals]).then(
      ([closed]) => {
        if (closed.status === "rejected") throw closed.reason;
      },
    );
    if (!this.released && this.id !== undefined) {
      this.expiresAt = performance.now() + this.options.closeReceiptTimeoutMs;
      this.timer = setTimeout(this.options.release, this.options.closeReceiptTimeoutMs);
      this.timer.unref();
    }
    return this.cleanup;
  }

  public release(acknowledged: boolean): Promise<void> {
    // Shutdown/expiry can strengthen a previous successful acknowledgement;
    // an admitted peer body must remain abortable until its response closes.
    this.acknowledged = acknowledged && (!this.released || this.acknowledged);
    this.released = true;
    if (!this.acknowledged) clearTimeout(this.timer);
    this.closeResponses(this.acknowledged);
    const cleanup = this.retire();
    if (this.requests.size === 0) this.drained.resolve();
    this.completion ??= (async () => {
      const [result] = await Promise.allSettled([
        cleanup,
        this.drained.promise,
        ...this.handlers.keys(),
      ]);
      clearTimeout(this.timer);
      if (result.status === "rejected") throw result.reason;
    })();
    return this.completion;
  }

  private closeResponses(keepDeletes: boolean): void {
    for (const response of this.requests) {
      if (!response.writableEnded && !(keepDeletes && this.deletes.has(response)))
        response.destroy();
    }
  }
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function reply(response: ServerResponse, status: number): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ status }));
}
