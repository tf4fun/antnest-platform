import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { createValidatedNodeHttpHandler } from "./validated-node-handler.js";
import type { AcpServer } from "@agentclientprotocol/sdk/experimental/server";
import { TracedAcpHttpServer } from "../../telemetry/acp-http.js";

import type { ConnectionBinding } from "../../domain/types.js";
import type { AcpApplicationPort } from "../../ports/acp-application.js";
import type { SkillCommandsPort } from "../../ports/skill-commands.js";
import type { ExecutionIdentity } from "../../domain/execution-configuration.js";
import { trustedIdentity } from "../trusted-identity.js";
import { promptCapabilities } from "./capabilities.js";
import { NOOP_TELEMETRY, type TelemetryPort } from "../../ports/telemetry.js";
import type { SessionOutputStreams } from "./session-output.js";
import { createAcpV1Agent } from "./v1/agent.js";
import type { PermissionConnectionsPort } from "../../ports/tool-permissions.js";
import type { LearningNoticePublisher } from "../../application/learning-notice-publisher.js";
import { activeHttpSpan } from "../../telemetry/http.js";
import { recordBoundaryError } from "../../telemetry/diagnostics.js";

type Options = {
  permissions?: PermissionConnectionsPort;
  notices?: Pick<LearningNoticePublisher, "subscribe">;
  skillCommands?: SkillCommandsPort;
  application: AcpApplicationPort;
  outputs: SessionOutputStreams;
  ready: () => Promise<boolean>;
  maxWebSocketPayloadBytes: number;
  telemetry?: TelemetryPort;
  maxConnections?: number;
  idleTimeoutMs?: number;
};

// Each SDK server owns one authorized HTTP connection. The SDK remains the
// authority for its transport ID and queues; this index only enforces ownership.
export class AcpHttpTransport {
  private readonly entries = new Set<HttpConnection>();
  private readonly byId = new Map<string, HttpConnection>();
  private readonly closing = new Set<Promise<void>>();
  private readonly telemetry: TelemetryPort;
  private stopped = false;

  public constructor(private readonly options: Options) {
    this.telemetry = options.telemetry ?? NOOP_TELEMETRY;
  }

  public async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (this.stopped || !(await this.options.ready())) return reply(response, 503);
      if (!["POST", "GET", "DELETE"].includes(request.method ?? "")) {
        response.setHeader("Allow", "POST, GET, DELETE");
        return reply(response, 405);
      }
      const identity = trustedIdentity(request.headers);
      if (identity === null) return reply(response, 401);
      if (this.isStopped() || response.destroyed) return reply(response, 503);
      const entry = this.admit(request, response, identity);
      if (entry) await entry.handle(request, response);
    } catch (error) {
      const span = activeHttpSpan();
      if (span !== undefined) recordBoundaryError(span, error, "acp.http.admission");
      this.telemetry.log("error", "acp_http_failed", { protocol: "v1" }, error);
      reply(response, 503);
    }
  }

  public async close(): Promise<void> {
    this.stopped = true;
    for (const entry of this.entries) this.release(entry);
    await Promise.all(this.closing);
  }

  private isStopped(): boolean {
    return this.stopped;
  }

  private admit(
    request: IncomingMessage,
    response: ServerResponse,
    identity: ExecutionIdentity,
  ): HttpConnection | undefined {
    const id = header(request, "acp-connection-id");
    if (id) {
      const entry = this.byId.get(id);
      if (!entry) {
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
      return entry;
    }
    if (request.method !== "POST") {
      reply(response, 400);
      return;
    }
    if (this.entries.size >= (this.options.maxConnections ?? 1024)) {
      reply(response, 503);
      return;
    }
    const binding: ConnectionBinding = {
      connectionId: randomUUID(),
      ...identity,
    };
    const entry = new HttpConnection(binding, {
      application: this.options.application,
      outputs: this.options.outputs,
      ...(this.options.permissions === undefined ? {} : { permissions: this.options.permissions }),
      ...(this.options.notices === undefined ? {} : { notices: this.options.notices }),
      ...(this.options.skillCommands === undefined
        ? {}
        : { skillCommands: this.options.skillCommands }),
      promptCapabilities,
      maxPayloadBytes: this.options.maxWebSocketPayloadBytes,
      idleTimeoutMs: this.options.idleTimeoutMs ?? 300_000,
      register: (id) => this.byId.set(id, entry),
      release: () => this.release(entry),
    });
    this.entries.add(entry);
    this.telemetry.count("antnest.acp.connections", {
      result: "accepted",
      protocol: "v1",
      transport: "http",
    });
    return entry;
  }

  private release(entry: HttpConnection): void {
    if (!this.entries.delete(entry)) return;
    if (entry.id) this.byId.delete(entry.id);
    const closed = entry.close().catch((error: unknown) => {
      this.telemetry.log("error", "acp_http_close_failed", {}, error);
    });
    this.closing.add(closed);
    void closed.then(() => this.closing.delete(closed));
    this.telemetry.count("antnest.acp.connections", {
      result: "closed",
      protocol: "v1",
      transport: "http",
    });
  }
}

type ConnectionOptions = {
  permissions?: PermissionConnectionsPort;
  notices?: Pick<LearningNoticePublisher, "subscribe">;
  skillCommands?: SkillCommandsPort;
  application: AcpApplicationPort;
  outputs: SessionOutputStreams;
  promptCapabilities: typeof promptCapabilities;
  maxPayloadBytes: number;
  idleTimeoutMs: number;
  register: (id: string) => void;
  release: () => void;
};

class HttpConnection {
  public id: string | undefined;
  private readonly server: AcpServer;
  private readonly requests = new Set<ServerResponse>();
  private readonly handler: ReturnType<typeof createValidatedNodeHttpHandler>;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private pendingDeletes = 0;
  private sdkClosed = false;

  public constructor(
    public readonly binding: ConnectionBinding,
    private readonly options: ConnectionOptions,
  ) {
    this.server = new TracedAcpHttpServer({
      agent: createAcpV1Agent({ binding, ...options }).onConnect((connection) => {
        void connection.closed.then(() => {
          // DELETE closes the SDK first; its HTTP acknowledgement still owns
          // the response until finish/close releases the outer connection.
          this.sdkClosed = true;
          if (this.pendingDeletes === 0) options.release();
        });
      }),
    });
    this.handler = createValidatedNodeHttpHandler(this.server, options.maxPayloadBytes);
  }

  public handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    clearTimeout(this.timer);
    if (request.method === "DELETE") this.pendingDeletes++;
    this.requests.add(response);
    return new Promise((resolve) => {
      response.once("finish", () => {
        if (this.stopped) return;
        if (this.id === undefined) {
          const id = response.getHeader("acp-connection-id");
          if (typeof id !== "string" || response.statusCode !== 200) {
            this.options.release();
            return;
          }
          this.id = id;
          this.options.register(id);
        }
        if (request.method === "DELETE" && response.statusCode === 202) this.options.release();
      });
      response.once("close", () => {
        this.requests.delete(response);
        if (request.method === "DELETE") this.pendingDeletes--;
        if (this.id === undefined || (this.sdkClosed && this.pendingDeletes === 0))
          this.options.release();
        if (!this.stopped && this.requests.size === 0) {
          this.timer = setTimeout(this.options.release, this.options.idleTimeoutMs);
          this.timer.unref();
        }
        resolve();
      });
      this.handler(request, response);
    });
  }

  public async close(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    for (const response of this.requests) {
      if (!response.writableEnded) response.destroy();
    }
    await this.server.close();
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
