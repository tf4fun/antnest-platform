import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import { context } from "@opentelemetry/api";
import { observeHttpRequest, startHttpBoundary, activeHttpSpan } from "../telemetry/http.js";
import { recordBoundaryError } from "../telemetry/diagnostics.js";
import { WebSocketServer, type WebSocket } from "ws";

import type { AcpApplicationPort } from "../ports/acp-application.js";
import { AgentControllerError, type AgentControllerPort } from "../ports/agent-controller.js";
import { NOOP_TELEMETRY, type TelemetryPort } from "../ports/telemetry.js";
import {
  createAcpV1WebSocketStream,
  createAcpV2WebSocketWireStream,
} from "./acp/websocket-stream.js";
import { createAcpV1Agent } from "./acp/v1/agent.js";
import { createAcpV2Agent } from "./acp/v2/agent.js";
import { SessionOutputStreams } from "./acp/session-output.js";
import { AcpHttpTransport } from "./acp/http-transport.js";
import type { PermissionConnectionsPort } from "../ports/tool-permissions.js";

export type AgentAcpHttpServerOptions = {
  permissions?: PermissionConnectionsPort;
  agentController: AgentControllerPort;
  application: AcpApplicationPort;
  ready: () => Promise<boolean>;
  id?: () => string;
  maxWebSocketPayloadBytes: number;
  telemetry?: TelemetryPort;
  reportError?: (error: unknown, operation: string) => void;
};

export class AgentAcpHttpServer {
  private readonly outputs = new SessionOutputStreams();
  private readonly server: Server;
  private readonly webSockets: WebSocketServer;
  private readonly connections = new Set<WebSocket>();
  private readonly id: () => string;
  private readonly telemetry: TelemetryPort;
  private readonly httpTransport: AcpHttpTransport;
  private closePromise: Promise<void> | undefined;

  public constructor(private readonly options: AgentAcpHttpServerOptions) {
    this.id = options.id ?? randomUUID;
    this.telemetry = options.telemetry ?? NOOP_TELEMETRY;
    this.httpTransport = new AcpHttpTransport({ ...options, outputs: this.outputs });
    this.server = createServer((request, response) => {
      void observeHttpRequest(request, response, () => this.handleHttp(request, response));
    });
    this.webSockets = new WebSocketServer({
      noServer: true,
      maxPayload: options.maxWebSocketPayloadBytes,
    });
    this.server.on("upgrade", (request, socket, head) => {
      const boundary = startHttpBoundary(request);
      const onClose = () => boundary.finish();
      const onError = (error: Error) => boundary.finish(undefined, error);
      socket.once("close", onClose);
      socket.once("error", onError);
      void context
        .with(boundary.context, () => this.handleUpgrade(request, socket, head))
        .then(
          (status) => boundary.finish(status),
          (error: unknown) => {
            boundary.finish(undefined, error);
            socket.destroy();
          },
        )
        .finally(() => {
          socket.off("close", onClose);
          socket.off("error", onError);
        });
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
    await this.httpTransport.close();
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
    if (request.url === "/v1/acp") {
      await this.httpTransport.handle(request, response);
      return;
    }
    if (request.method !== "GET" || request.url !== "/status") {
      json(response, 404, { status: "not_found" });
      return;
    }
    try {
      const ready = await this.options.ready();
      json(response, ready ? 200 : 503, { status: ready ? "ready" : "not_ready" });
    } catch (error) {
      const span = activeHttpSpan();
      if (span !== undefined) recordBoundaryError(span, error, "readiness");
      json(response, 503, { status: "not_ready" });
    }
  }

  private async handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<number> {
    const protocol = acpProtocol(request.url);
    if (protocol === null) {
      this.telemetry.count("antnest.acp.connections", { result: "rejected", reason: "not_found" });
      return rejectUpgrade(socket, 404, "Not Found");
    }
    try {
      if (!(await this.options.ready())) {
        this.telemetry.count("antnest.acp.connections", {
          result: "rejected",
          reason: "not_ready",
        });
        return rejectUpgrade(socket, 503, "Service Unavailable");
      }
    } catch (error) {
      const span = activeHttpSpan();
      if (span !== undefined) recordBoundaryError(span, error, "readiness");
      return rejectUpgrade(socket, 503, "Service Unavailable");
    }
    const subject = oneHeader(request, "x-antnest-agent-access-subject");
    if (subject === null) {
      this.telemetry.count("antnest.acp.connections", {
        result: "rejected",
        reason: "unauthorized",
      });
      return rejectUpgrade(socket, 401, "Unauthorized");
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
        this.telemetry.count("antnest.acp.connections", { result: "accepted", protocol });
        this.connections.add(webSocket);
        webSocket.once("close", () => {
          this.connections.delete(webSocket);
          this.telemetry.count("antnest.acp.connections", { result: "closed" });
        });
        webSocket.once("error", (error) => this.report(error, "websocket"));
        try {
          if (protocol === "v1") {
            const connection = createAcpV1Agent({
              binding,
              promptCapabilities: access.promptCapabilities,
              application: this.options.application,
              outputs: this.outputs,
              ...(this.options.permissions === undefined
                ? {}
                : { permissions: this.options.permissions }),
            }).connect(createAcpV1WebSocketStream(webSocket));
            this.observeConnection(connection, protocol);
          } else {
            const connection = createAcpV2Agent({
              binding,
              promptCapabilities: access.promptCapabilities,
              application: this.options.application,
              outputs: this.outputs,
              ...(this.options.permissions === undefined
                ? {}
                : { permissions: this.options.permissions }),
            }).connect(createAcpV2WebSocketWireStream(webSocket));
            this.observeConnection(connection, protocol);
          }
        } catch (error) {
          this.report(error, "acp_connect");
          webSocket.close(1011, "ACP connection setup failed");
        }
      });
      socket.resume();
      return 101;
    } catch (error) {
      const rejection = accessRejection(error);
      this.telemetry.count("antnest.acp.connections", {
        result: "rejected",
        reason: rejection.metricReason,
      });
      this.report(error, "upgrade_authentication");
      const span = activeHttpSpan();
      if (span !== undefined) recordBoundaryError(span, error, "upgrade_authentication");
      return rejectUpgrade(socket, rejection.status, rejection.reason);
    }
  }

  private observeConnection(
    connection: {
      initialized?: Promise<unknown>;
      closed: Promise<void>;
      signal: AbortSignal;
    },
    protocol: "v1" | "v2",
  ): void {
    void connection.initialized?.catch((error) => this.report(error, `${protocol}_initialize`));
    void connection.closed.then(() => {
      const reason = connection.signal.reason as unknown;
      if (reason !== undefined) {
        this.report(reason, `${protocol}_connection`);
      }
    });
  }

  private report(error: unknown, operation: string): void {
    this.telemetry.log("error", operation, {}, error);
    this.options.reportError?.(error, operation);
  }
}

function acpProtocol(url: string | undefined): "v1" | "v2" | null {
  switch (url) {
    case "/v1/acp":
      return "v1";
    case "/v2/acp":
      return "v2";
    case undefined:
      return null;
    default:
      return null;
  }
}

function oneHeader(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name];
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length === 0 ? null : normalized;
}

function accessRejection(error: unknown): {
  status: number;
  reason: string;
  metricReason: string;
} {
  if (error instanceof AgentControllerError && error.code === "access_denied" && !error.retryable) {
    return { status: 403, reason: "Forbidden", metricReason: "forbidden" };
  }
  if (
    error instanceof AgentControllerError &&
    error.code === "invalid_request" &&
    !error.retryable
  ) {
    return { status: 400, reason: "Bad Request", metricReason: "invalid_request" };
  }
  return { status: 503, reason: "Service Unavailable", metricReason: "dependency_unavailable" };
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): number {
  if (!socket.destroyed) {
    socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
  }
  return status;
}
