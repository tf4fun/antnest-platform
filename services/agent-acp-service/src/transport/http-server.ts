import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import { context, propagation, type TextMapGetter } from "@opentelemetry/api";
import { WebSocketServer, type WebSocket } from "ws";

import type { AcpApplicationPort } from "../ports/acp-application.js";
import type { AgentControllerPort } from "../ports/agent-controller.js";
import { NOOP_TELEMETRY, type TelemetryPort } from "../ports/telemetry.js";
import { createAcpV2Agent } from "./acp/v2/agent.js";
import { createAcpV2WebSocketWireStream } from "./acp/v2/websocket-stream.js";

export type AgentAcpHttpServerOptions = {
  agentController: AgentControllerPort;
  application: AcpApplicationPort;
  ready: () => Promise<boolean>;
  id?: () => string;
  maxWebSocketPayloadBytes: number;
  telemetry?: TelemetryPort;
  reportError?: (error: unknown, operation: string) => void;
};

export class AgentAcpHttpServer {
  private readonly server: Server;
  private readonly webSockets: WebSocketServer;
  private readonly connections = new Set<WebSocket>();
  private readonly id: () => string;
  private readonly telemetry: TelemetryPort;
  private closePromise: Promise<void> | undefined;

  public constructor(private readonly options: AgentAcpHttpServerOptions) {
    this.id = options.id ?? randomUUID;
    this.telemetry = options.telemetry ?? NOOP_TELEMETRY;
    this.server = createServer((request, response) => {
      void this.handleHttp(request, response);
    });
    this.webSockets = new WebSocketServer({
      noServer: true,
      maxPayload: options.maxWebSocketPayloadBytes,
    });
    this.server.on("upgrade", (request, socket, head) => {
      const requestContext = propagation.extract(context.active(), request.headers, HEADER_GETTER);
      void context.with(requestContext, () => this.handleUpgrade(request, socket, head));
    });
  }

  public listen(host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
  }

  public address(): ReturnType<Server["address"]> {
    return this.server.address();
  }

  public close(): Promise<void> {
    this.closePromise ??= this.closeOnce();
    return this.closePromise;
  }

  private async closeOnce(): Promise<void> {
    for (const socket of this.connections) {
      socket.terminate();
    }
    await new Promise<void>((resolve) => {
      this.webSockets.close(() => resolve());
    });
    if (!this.server.listening) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error === undefined ? resolve() : reject(error)));
      this.server.closeAllConnections();
    });
  }

  private async handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "GET" || request.url !== "/status") {
      json(response, 404, { status: "not_found" });
      return;
    }
    try {
      const ready = await this.options.ready();
      json(response, ready ? 200 : 503, { status: ready ? "ready" : "not_ready" });
    } catch {
      json(response, 503, { status: "not_ready" });
    }
  }

  private async handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    if (request.url !== "/v2/acp") {
      this.telemetry.count("antnest.acp.connections", { result: "rejected", reason: "not_found" });
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }
    try {
      if (!(await this.options.ready())) {
        this.telemetry.count("antnest.acp.connections", {
          result: "rejected",
          reason: "not_ready",
        });
        rejectUpgrade(socket, 503, "Service Unavailable");
        return;
      }
    } catch {
      rejectUpgrade(socket, 503, "Service Unavailable");
      return;
    }
    const subject = oneHeader(request, "x-antnest-agent-access-subject");
    if (subject === null) {
      this.telemetry.count("antnest.acp.connections", {
        result: "rejected",
        reason: "unauthorized",
      });
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }
    socket.pause();
    try {
      const access = await this.options.agentController.resolveAgentAccess({
        requestId: this.id(),
        agentAccessSubject: subject,
      });
      const binding = {
        connectionId: this.id(),
        agentAccessSubject: subject,
        principalId: access.principalId,
        agentId: access.agentId,
        accessRevision: access.accessRevision,
      };
      this.webSockets.handleUpgrade(request, socket, head, (webSocket) => {
        this.telemetry.count("antnest.acp.connections", { result: "accepted" });
        this.connections.add(webSocket);
        webSocket.once("close", () => {
          this.connections.delete(webSocket);
          this.telemetry.count("antnest.acp.connections", { result: "closed" });
        });
        webSocket.once("error", (error) => this.report(error, "websocket"));
        try {
          const connection = createAcpV2Agent({
            binding,
            promptCapabilities: access.promptCapabilities,
            application: this.options.application,
          }).connect(createAcpV2WebSocketWireStream(webSocket));
          void connection.initialized.catch((error) => this.report(error, "acp_initialize"));
          void connection.closed.then(() => {
            const reason = connection.signal.reason as unknown;
            if (reason !== undefined) {
              this.report(reason, "acp_connection");
            }
          });
        } catch (error) {
          this.report(error, "acp_connect");
          webSocket.close(1011, "ACP connection setup failed");
        }
      });
      socket.resume();
    } catch (error) {
      this.telemetry.count("antnest.acp.connections", { result: "rejected", reason: "forbidden" });
      this.report(error, "upgrade_authentication");
      rejectUpgrade(socket, 403, "Forbidden");
    }
  }

  private report(error: unknown, operation: string): void {
    this.telemetry.log("error", operation, {}, error);
    this.options.reportError?.(error, operation);
  }
}

const HEADER_GETTER: TextMapGetter<IncomingMessage["headers"]> = {
  keys: (headers) => Object.keys(headers),
  get: (headers, key) => headers[key.toLowerCase()],
};

function oneHeader(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name];
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length === 0 ? null : normalized;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  if (!socket.destroyed) {
    socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
  }
}
