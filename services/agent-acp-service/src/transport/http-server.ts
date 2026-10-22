import type { LearningStatusReader } from "../application/learning-status-reader.js";
import { learningStatusRoute, serveLearningStatus } from "./learning-status.js";
import { randomUUID } from "node:crypto";
import { skillSourceRoute, serveSkillSource } from "./skill-sources.js";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createSecureServer } from "node:https";
import type { RequestAuthentication, AuthenticationFailure } from "./request-authentication.js";
import type { Duplex } from "node:stream";

import { context } from "@opentelemetry/api";
import { observeHttpRequest, startHttpBoundary, activeHttpSpan } from "../telemetry/http.js";
import { recordBoundaryError } from "../telemetry/diagnostics.js";
import { httpFailure } from "./public-error.js";
import { WebSocketServer, type WebSocket } from "ws";

import type { AcpApplicationPort } from "../ports/acp-application.js";
import type { SkillCommandsPort } from "../ports/skill-commands.js";
import { trustedIdentity } from "./trusted-identity.js";
import { promptCapabilities } from "./acp/capabilities.js";
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
import type { ExecutionConfigurationPort } from "../ports/execution-configuration.js";
import type { AgentSettlementPort } from "../ports/agent-settlement.js";
import type { AgentExecutionStatePort } from "../ports/agent-execution-state.js";
import type { ExecutionAuditPort } from "../ports/execution-audit.js";
import type { RuntimeBarrierReader } from "../ports/runtime-barrier.js";
import type { BridgeObservationService } from "../application/bridge-observation.js";
import type { LearningChangeReader } from "../application/learning-change-reader.js";
import type { LearningNoticePublisher } from "../application/learning-notice-publisher.js";
import { bridgeObservationRoute, serveBridgeObservation } from "./bridge-observation.js";
import { learningChangeRoute, serveLearningChanges } from "./learning-changes.js";
import { executionAuditRoute, serveExecutionAudit } from "./execution-audit.js";
import {
  AGENT_EXECUTION_STATE_PATH,
  AGENT_EXECUTION_WATCH_PATH,
  serveAgentExecutionState,
} from "./agent-execution-state.js";
import { AGENT_SETTLEMENT_PATH, settleAgent } from "./agent-settlement.js";
import { RUNTIME_BARRIER_QUERY_PATH, serveRuntimeBarrierQuery } from "./runtime-barrier-query.js";
import {
  applyExecutionConfiguration,
  EXECUTION_CONFIGURATION_PATH,
} from "./execution-configuration.js";

export type AgentAcpHttpServerOptions = {
  authentication: RequestAuthentication;
  skillSources?: Parameters<typeof serveSkillSource>[3];
  outputs?: SessionOutputStreams;
  executionConfiguration?: ExecutionConfigurationPort;
  settlement?: AgentSettlementPort;
  executionState?: AgentExecutionStatePort;
  executionAudits?: ExecutionAuditPort;
  runtimeBarriers?: RuntimeBarrierReader;
  bridgeObservation?: Pick<BridgeObservationService, "readIntent" | "readSession">;
  learningStatus?: Pick<LearningStatusReader, "read">;
  learningChanges?: Pick<LearningChangeReader, "list">;
  notices?: Pick<LearningNoticePublisher, "subscribe">;
  skillCommands?: SkillCommandsPort;
  stateDeliveryTimeoutMs?: number;
  maxConfigurationBytes?: number;
  permissions?: PermissionConnectionsPort;
  application: AcpApplicationPort;
  ready: () => Promise<boolean>;
  id?: () => string;
  maxWebSocketPayloadBytes: number;
  telemetry?: TelemetryPort;
  reportError?: (error: unknown, operation: string) => void;
};

export class AgentAcpHttpServer {
  private readonly outputs: SessionOutputStreams;
  private readonly server: Server;
  private readonly controlServer: Server;
  private readonly webSockets: WebSocketServer;
  private readonly connections = new Set<WebSocket>();
  private readonly id: () => string;
  private readonly telemetry: TelemetryPort;
  private readonly httpTransport: AcpHttpTransport;
  private closePromise: Promise<void> | undefined;

  public constructor(private readonly options: AgentAcpHttpServerOptions) {
    // JavaScript callers must also fail closed before any listener is opened.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!options.authentication) throw new Error("Request authentication is required");
    this.outputs = options.outputs ?? new SessionOutputStreams();
    this.id = options.id ?? randomUUID;
    this.telemetry = options.telemetry ?? NOOP_TELEMETRY;
    this.httpTransport = new AcpHttpTransport({ ...options, outputs: this.outputs });
    const handler = (request: IncomingMessage, response: ServerResponse) => {
      void observeHttpRequest(request, response, () =>
        this.handleHttp(request, response, "workspace"),
      );
    };
    this.server =
      options.authentication.workload.serverTLS === undefined
        ? createServer(handler)
        : createSecureServer(options.authentication.workload.serverTLS, handler);
    const control = (request: IncomingMessage, response: ServerResponse) => {
      void observeHttpRequest(
        request,
        response,
        () => this.handleHttp(request, response, "control"),
        "control",
      );
    };
    this.controlServer =
      options.authentication.workload.serverTLS === undefined
        ? createServer(control)
        : createSecureServer(options.authentication.workload.serverTLS, control);
    this.controlServer.on("upgrade", (request, socket) => {
      const boundary = startHttpBoundary(request, "control");
      boundary.finish(rejectUpgrade(socket, 404, "Not Found"));
    });
    this.webSockets = new WebSocketServer({
      noServer: true,
      maxPayload: options.maxWebSocketPayloadBytes,
    });
    this.webSockets.on("headers", () => {
      activeHttpSpan()?.addEvent("antnest.http.upgrade.response.prepared");
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

  public listenControl(host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.controlServer.once("error", reject);
      this.controlServer.listen(port, host, () => {
        this.controlServer.off("error", reject);
        resolve();
      });
    });
  }

  public controlAddress(): ReturnType<Server["address"]> {
    return this.controlServer.address();
  }

  public close(): Promise<void> {
    this.closePromise ??= this.closeOnce();
    return this.closePromise;
  }

  private isClosing(): boolean {
    return this.closePromise !== undefined;
  }

  private async closeOnce(): Promise<void> {
    // Both transports receive the same five-second shutdown window. Keep HTTP
    // listening for existing connections' authenticated cleanup acknowledgements.
    const results = await Promise.allSettled([this.httpTransport.drain(), this.closeWebSockets()]);
    results.push(
      ...(await Promise.allSettled(
        [this.server, this.controlServer].map(async (server) => {
          if (!server.listening) return;
          await new Promise<void>((resolve, reject) => {
            server.close((error) => (error === undefined ? resolve() : reject(error)));
            server.closeAllConnections();
          });
        }),
      )),
    );
    const errors = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (errors.length)
      throw new AggregateError(
        errors.map((result) => result.reason as unknown),
        "Listener shutdown failed",
      );
  }

  private async closeWebSockets(): Promise<void> {
    await Promise.all(
      [...this.connections].map(
        (socket) =>
          new Promise<void>((resolve) => {
            // Give responsive peers the normal going-away frame. A stalled
            // peer cannot consume the process's entire shutdown deadline.
            const timer = setTimeout(() => socket.terminate(), 5_000);
            timer.unref();
            socket.once("close", () => {
              clearTimeout(timer);
              resolve();
            });
            socket.close(1001, "Service shutting down");
          }),
      ),
    );
    await new Promise<void>((resolve) => {
      this.webSockets.close(() => resolve());
    });
  }

  private async handleHttp(
    request: IncomingMessage,
    response: ServerResponse,
    listener: "workspace" | "control",
  ): Promise<void> {
    const path = (request.url ?? "").split("?", 1)[0];
    const control =
      path === AGENT_SETTLEMENT_PATH ||
      path === EXECUTION_CONFIGURATION_PATH ||
      path === RUNTIME_BARRIER_QUERY_PATH;
    if (
      (listener === "workspace" && control) ||
      (listener === "control" &&
        !control &&
        !(request.method === "GET" && request.url === "/status"))
    ) {
      response.setHeader("Connection", "close");
      json(response, 404, { status: "not_found" });
      return;
    }
    const admission = await this.options.authentication.admit(request);
    if ("status" in admission) {
      const failure = httpFailure(admission.code);
      if (admission.challenge !== undefined)
        response.setHeader("WWW-Authenticate", admission.challenge);
      response.setHeader("Connection", "close");
      json(response, failure.status, failure.body);
      return;
    }
    const sourceRoute = skillSourceRoute(request.url);
    if (sourceRoute !== undefined) {
      await serveSkillSource(
        request,
        response,
        sourceRoute,
        this.options.skillSources,
        this.options.ready,
      );
      return;
    }
    const statusRoute = learningStatusRoute(request.url);
    if (statusRoute !== undefined) {
      await serveLearningStatus(
        request,
        response,
        statusRoute,
        this.options.learningStatus,
        this.options.ready,
      );
      return;
    }
    const changesRoute = learningChangeRoute(request.url);
    if (changesRoute !== undefined) {
      await serveLearningChanges(
        request,
        response,
        changesRoute,
        this.options.learningChanges,
        this.options.ready,
      );
      return;
    }
    const bridgeRoute = bridgeObservationRoute(request.url);
    if (bridgeRoute !== undefined) {
      await serveBridgeObservation(
        request,
        response,
        bridgeRoute,
        this.options.bridgeObservation,
        this.options.ready,
      );
      return;
    }
    const auditRoute = executionAuditRoute(request.url);
    if (auditRoute !== undefined) {
      await serveExecutionAudit(
        request,
        response,
        auditRoute,
        this.options.executionAudits,
        this.options.maxConfigurationBytes ?? 16 * 1024 * 1024,
        this.options.ready,
      );
      return;
    }
    if (request.url === AGENT_EXECUTION_STATE_PATH || request.url === AGENT_EXECUTION_WATCH_PATH) {
      await serveAgentExecutionState(
        request,
        response,
        this.options.executionState,
        this.options.maxConfigurationBytes ?? 16 * 1024 * 1024,
        this.options.ready,
        this.options.stateDeliveryTimeoutMs,
      );
      return;
    }
    if (request.url === RUNTIME_BARRIER_QUERY_PATH) {
      await serveRuntimeBarrierQuery(
        request,
        response,
        this.options.runtimeBarriers,
        this.options.maxConfigurationBytes ?? 16 * 1024 * 1024,
        this.options.ready,
      );
      return;
    }
    if (request.url === AGENT_SETTLEMENT_PATH) {
      await settleAgent(
        request,
        response,
        this.options.settlement,
        this.options.maxConfigurationBytes ?? 16 * 1024 * 1024,
        this.options.ready,
      );
      return;
    }
    if (request.url === EXECUTION_CONFIGURATION_PATH) {
      await applyExecutionConfiguration(
        request,
        response,
        this.options.executionConfiguration,
        this.options.maxConfigurationBytes ?? 16 * 1024 * 1024,
      );
      return;
    }
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
    if (this.isClosing()) return rejectUpgrade(socket, 503, "Service Unavailable");
    const admission = await this.options.authentication.admit(request, true);
    if ("status" in admission) return rejectAuthenticatedUpgrade(socket, admission);
    const protocol = acpProtocol(request.url);
    if (protocol === null) {
      this.telemetry.count("antnest.acp.connections", { result: "rejected", reason: "not_found" });
      return rejectUpgrade(socket, 404, "Not Found");
    }
    try {
      if (!(await this.options.ready()) || this.isClosing()) {
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
    const identity = trustedIdentity(request.headers);
    if (identity === null) {
      this.telemetry.count("antnest.acp.connections", {
        result: "rejected",
        reason: "unauthorized",
      });
      return rejectUpgrade(socket, 401, "Unauthorized");
    }
    socket.pause();
    try {
      const binding = {
        connectionId: this.id(),
        ...identity,
      };
      this.webSockets.handleUpgrade(request, socket, head, (webSocket) => {
        const span = activeHttpSpan();
        span?.addEvent("antnest.http.upgrade.connection.setup.started");
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
              promptCapabilities,
              application: this.options.application,
              outputs: this.outputs,
              ...(this.options.notices === undefined ? {} : { notices: this.options.notices }),
              ...(this.options.skillCommands === undefined
                ? {}
                : { skillCommands: this.options.skillCommands }),
              ...(this.options.permissions === undefined
                ? {}
                : { permissions: this.options.permissions }),
            }).connect(
              createAcpV1WebSocketStream(
                webSocket,
                () =>
                  admission.claims === undefined || Date.now() < (admission.claims.exp + 30) * 1000,
              ),
            );
            this.observeConnection(connection, protocol);
          } else {
            const connection = createAcpV2Agent({
              binding,
              promptCapabilities,
              application: this.options.application,
              outputs: this.outputs,
              ...(this.options.permissions === undefined
                ? {}
                : { permissions: this.options.permissions }),
            }).connect(
              createAcpV2WebSocketWireStream(
                webSocket,
                () =>
                  admission.claims === undefined || Date.now() < (admission.claims.exp + 30) * 1000,
              ),
            );
            this.observeConnection(connection, protocol);
          }
          span?.addEvent("antnest.http.upgrade.connection.setup.completed");
        } catch (error) {
          this.report(error, "acp_connect");
          webSocket.close(1011, "ACP connection setup failed");
        }
      });
      socket.resume();
      return 101;
    } catch (error) {
      this.telemetry.count("antnest.acp.connections", {
        result: "rejected",
        reason: "connection_setup_failed",
      });
      this.report(error, "upgrade_authentication");
      const span = activeHttpSpan();
      if (span !== undefined) recordBoundaryError(span, error, "upgrade_authentication");
      return rejectUpgrade(socket, 503, "Service Unavailable");
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

function rejectAuthenticatedUpgrade(socket: Duplex, failure: AuthenticationFailure): number {
  if (!socket.destroyed) {
    const body = JSON.stringify(httpFailure(failure.code).body);
    const challenge =
      failure.challenge === undefined ? "" : `WWW-Authenticate: ${failure.challenge}\r\n`;
    socket.end(
      `HTTP/1.1 ${failure.status} Authentication Failed\r\n${challenge}Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
    );
  }
  return failure.status;
}
