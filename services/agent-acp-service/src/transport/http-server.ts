import type { LearningStatusReader } from "../application/learning-status-reader.js";
import { learningStatusRoute, serveLearningStatus } from "./learning-status.js";
import { randomUUID } from "node:crypto";
import { skillSourceRoute, serveSkillSource } from "./skill-sources.js";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createSecureServer } from "node:https";
import type { RequestAuthentication, AuthenticationFailure } from "./request-authentication.js";
import type { Duplex } from "node:stream";
import type { CallerClaims } from "../adapters/caller-context.js";
import type { ConnectionBinding } from "../domain/types.js";

import { context } from "@opentelemetry/api";
import { observeHttpRequest, startHttpBoundary, activeHttpSpan } from "../telemetry/http.js";
import { recordBoundaryError } from "../telemetry/diagnostics.js";
import { httpFailure } from "./public-error.js";
import { WebSocketServer, type WebSocket } from "ws";

import type { AcpApplicationPort } from "../ports/acp-application.js";
import type { SkillCommandsPort } from "../ports/skill-commands.js";
import { trustedIdentity } from "./trusted-identity.js";
import { authenticatedCaller } from "./trusted-identity.js";
import { fields } from "../adapters/service-authentication.js";
import { CALLER_CONTEXT_HEADER } from "../adapters/caller-context.js";
import type { PeerAuthentication } from "../adapters/peer-authentication.js";
import {
  encodeOwnerForward,
  OWNER_FORWARD_HEADER,
  type OwnerForwardRequest,
  type OwnerForwarding,
} from "../application/owner-forwarding.js";
import type { AgentOwnershipFence } from "../domain/agent-ownership.js";
import { isDeepStrictEqual } from "node:util";
import { PeerSocket, PeerReceiptDeliveryError } from "./peer-socket.js";
import { promptCapabilities } from "./acp/capabilities.js";
import { NOOP_TELEMETRY, type TelemetryPort } from "../ports/telemetry.js";
import {
  createAcpV1WebSocketStream,
  createAcpV2WebSocketWireStream,
  type JsonSocket,
} from "./acp/websocket-stream.js";
import { createAcpV1Agent } from "./acp/v1/agent.js";
import { createAcpV2Agent } from "./acp/v2/agent.js";
import { SessionOutputStreams } from "./acp/session-output.js";
import { AcpHttpTransport } from "./acp/http-transport.js";
import { OwnerHttpTransport, type HttpOwnerForwardingOptions } from "./owner-http.js";
import type { PermissionConnectionsPort } from "../ports/tool-permissions.js";
import type { ExecutionConfigurationPort } from "../ports/execution-configuration.js";
import type { AgentSettlementPort } from "../ports/agent-settlement.js";
import type { AgentExecutionStatePort } from "../ports/agent-execution-state.js";
import type { ExecutionAuditPort } from "../ports/execution-audit.js";
import type { RuntimeBarrierReader } from "../ports/runtime-barrier.js";
import {
  ConnectionCapacity,
  type ConnectionCapacityLimits,
} from "../application/connection-capacity.js";
import { DomainError } from "../domain/errors.js";
import {
  isExecutionAccessRevoked,
  type ExecutionAccessSnapshot,
  type ExecutionIdentity,
} from "../domain/execution-configuration.js";
import { ConnectionTasks } from "./acp/connection-tasks.js";
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

// This route belongs only to the independent, early owner listener.
const OWNER_PROBE_PATH = "/internal/acp-owner/incarnation/probe";

export type AgentAcpHttpServerOptions = {
  authentication: RequestAuthentication;
  httpForwarding?: HttpOwnerForwardingOptions;
  forwarding?: {
    resolver: Pick<OwnerForwarding, "resolve">;
    peers: Pick<PeerAuthentication, "connect">;
    admit(
      request: OwnerForwardRequest,
      signal: AbortSignal,
    ): Promise<{ fence: AgentOwnershipFence; signal: AbortSignal; assertCurrent(): void }>;
  };
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
  connectionLimits?: ConnectionCapacityLimits;
  telemetry?: TelemetryPort;
  reportError?: (error: unknown, operation: string) => void;
};

type OwnedHttpRequest = {
  identity: ExecutionIdentity | null;
  response: ServerResponse;
  deleting: boolean;
  stateWatch: boolean;
  finished: PromiseWithResolvers<void>;
};

export class AgentAcpHttpServer {
  private readonly outputs: SessionOutputStreams;
  private readonly server: Server;
  private readonly controlServer: Server;
  private readonly webSockets: WebSocketServer;
  private readonly connections = new Set<WebSocket>();
  private readonly ownedWebSockets = new Set<Promise<void>>();
  private readonly upgrades = new Set<Promise<void>>();
  private readonly socketBindings = new Set<{
    identity: ExecutionIdentity;
    close: () => void;
    joined: Promise<void>;
  }>();
  private readonly requests = new Set<OwnedHttpRequest>();
  private readonly latestAccess = new Map<string, ExecutionAccessSnapshot>();
  private readonly accessRevisions = new Map<string, number>();
  private accessRevision = 0;
  private readonly forwardedClosers = new Set<() => void>();
  private readonly forwardingFailures = new Map<
    string,
    { identity: ExecutionIdentity; error: unknown }
  >();
  private readonly capacity: ConnectionCapacity;
  private readonly id: () => string;
  private readonly telemetry: TelemetryPort;
  private readonly httpTransport: AcpHttpTransport;
  private readonly httpOwner: OwnerHttpTransport | undefined;
  private closePromise: Promise<void> | undefined;

  public constructor(private readonly options: AgentAcpHttpServerOptions) {
    // JavaScript callers must also fail closed before any listener is opened.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!options.authentication) throw new Error("Request authentication is required");
    this.outputs = options.outputs ?? new SessionOutputStreams();
    this.id = options.id ?? randomUUID;
    this.telemetry = options.telemetry ?? NOOP_TELEMETRY;
    this.capacity = new ConnectionCapacity(options.connectionLimits);
    this.httpTransport = new AcpHttpTransport({
      ...options,
      outputs: this.outputs,
      capacity: this.capacity,
    });
    this.httpOwner =
      options.httpForwarding === undefined
        ? undefined
        : new OwnerHttpTransport({
            ...options.httpForwarding,
            transport: this.httpTransport,
            capacity: this.capacity,
            authentication: options.authentication,
            revoked: (identity) => this.accessRevoked(identity),
            report: (error) => this.report(error, "owner_http_forwarding"),
          });
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
      const original = context
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
      this.upgrades.add(original);
      const forget = () => this.upgrades.delete(original);
      void original.then(forget, forget);
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

  public async revokeAccess(snapshot: ExecutionAccessSnapshot): Promise<void> {
    this.latestAccess.set(snapshot.organization_id, structuredClone(snapshot));
    this.accessRevisions.set(snapshot.organization_id, ++this.accessRevision);
    const joins: Promise<unknown>[] = [
      this.httpTransport.revokeAccess(snapshot),
      this.httpOwner?.revokeAccess(snapshot) ?? Promise.resolve(),
    ];
    for (const request of this.requests) {
      if (request.identity === null || !isExecutionAccessRevoked(snapshot, request.identity))
        continue;
      if (!request.deleting && !request.stateWatch) request.response.destroy();
      joins.push(request.finished.promise);
    }
    for (const binding of this.socketBindings) {
      if (!isExecutionAccessRevoked(snapshot, binding.identity)) continue;
      binding.close();
      joins.push(binding.joined);
    }
    const results = await Promise.allSettled(joins);
    const errors = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    for (const failure of this.forwardingFailures.values()) {
      if (isExecutionAccessRevoked(snapshot, failure.identity))
        errors.push({ status: "rejected", reason: failure.error });
    }
    if (errors.length)
      throw new AggregateError(
        errors.map((result) => result.reason as unknown),
        "Revoked transport cleanup failed",
      );
  }

  private accessRevoked(identity: ExecutionIdentity, since = 0): boolean {
    if ((this.accessRevisions.get(identity.organizationId) ?? 0) <= since) return false;
    const snapshot = this.latestAccess.get(identity.organizationId);
    return snapshot !== undefined && isExecutionAccessRevoked(snapshot, identity);
  }

  private isClosing(): boolean {
    return this.closePromise !== undefined;
  }

  private async closeOnce(): Promise<void> {
    // Both transports receive the same five-second shutdown window. Keep HTTP
    // listening for existing connections' authenticated cleanup acknowledgements.
    const results = await Promise.allSettled([
      this.httpTransport.drain(),
      this.httpOwner?.close(),
      this.closeWebSockets(),
    ]);
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
    results.push(
      ...(await Promise.allSettled([...this.requests].map((request) => request.finished.promise))),
    );
    results.push(...(await Promise.allSettled([...this.upgrades])));
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
    for (const close of this.forwardedClosers) close();
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
    const results = await Promise.allSettled(this.ownedWebSockets);
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason as unknown] : [],
    );
    failures.push(...[...this.forwardingFailures.values()].map((failure) => failure.error));
    if (failures.length) throw new AggregateError(failures, "Forwarded connection cleanup failed");
  }

  private async handleHttp(
    request: IncomingMessage,
    response: ServerResponse,
    listener: "workspace" | "control",
  ): Promise<void> {
    const original: OwnedHttpRequest = {
      identity: null,
      response,
      deleting: request.method === "DELETE",
      stateWatch: false,
      finished: Promise.withResolvers<void>(),
    };
    this.requests.add(original);
    try {
      await this.admitHttp(request, response, listener, original);
    } finally {
      this.requests.delete(original);
      original.finished.resolve();
    }
  }

  private async admitHttp(
    request: IncomingMessage,
    response: ServerResponse,
    listener: "workspace" | "control",
    original: OwnedHttpRequest,
  ): Promise<void> {
    const accessRevision = this.accessRevision;
    const path = (request.url ?? "").split("?", 1)[0];
    const control =
      path === AGENT_SETTLEMENT_PATH ||
      path === EXECUTION_CONFIGURATION_PATH ||
      path === RUNTIME_BARRIER_QUERY_PATH;
    if (
      path === OWNER_PROBE_PATH ||
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
    const identity = trustedIdentity(request.headers);
    original.identity = identity;
    if (response.destroyed) return;
    if (
      identity !== null &&
      request.method !== "DELETE" &&
      this.accessRevoked(identity, accessRevision)
    ) {
      const failure = httpFailure("access_denied");
      json(response, failure.status, failure.body);
      return;
    }
    await this.handleAuthorizedHttp(request, response, original);
  }

  private async handleAuthorizedHttp(
    request: IncomingMessage,
    response: ServerResponse,
    original: OwnedHttpRequest,
  ): Promise<void> {
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
        () => {
          original.stateWatch = true;
        },
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
      if (this.httpOwner === undefined) await this.httpTransport.handle(request, response);
      else await this.httpOwner.handle(request, response);
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

  public async handlePeerHttp(
    request: IncomingMessage,
    response: ServerResponse,
    member: string,
    signal: AbortSignal,
    admitted: () => void,
  ): Promise<void> {
    if (this.httpOwner === undefined)
      throw new DomainError("agent_unavailable", "HTTP owner forwarding is unavailable");
    await this.httpOwner.handlePeer(request, response, member, signal, admitted);
  }

  private async handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<number> {
    const accessRevision = this.accessRevision;
    if ((request.url ?? "").split("?", 1)[0] === OWNER_PROBE_PATH)
      return rejectUpgrade(socket, 404, "Not Found");
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
    if (socket.destroyed || this.isClosing())
      return rejectUpgrade(socket, 503, "Service Unavailable");
    if (this.accessRevoked(identity, accessRevision))
      return rejectUpgrade(socket, 403, "Forbidden");
    if (this.options.forwarding !== undefined) {
      const cancellation = new AbortController();
      const cancel = () => cancellation.abort(new Error("Ingress socket closed"));
      socket.once("close", cancel);
      const resolved = Promise.withResolvers<void>();
      const pendingBinding = {
        identity,
        close: () => {
          cancel();
          socket.destroy();
        },
        joined: resolved.promise,
      };
      this.socketBindings.add(pendingBinding);
      try {
        const target = await this.options.forwarding.resolver.resolve(
          identity,
          protocol,
          cancellation.signal,
        );
        cancellation.signal.throwIfAborted();
        if (target !== null)
          return await this.forwardWebSocket(request, socket, head, target, cancellation.signal);
      } catch (error) {
        this.report(error, "owner_forwarding");
        return rejectUpgrade(socket, 503, "Service Unavailable");
      } finally {
        socket.off("close", cancel);
        this.socketBindings.delete(pendingBinding);
        resolved.resolve();
      }
    }
    const setup = Promise.withResolvers<void>();
    try {
      const lease = this.capacity.reserve(identity);
      const tasks = new ConnectionTasks();
      const closed = Promise.withResolvers<void>();
      socket.once("close", () => closed.resolve());
      // A removed WebSocket or a requested close is not an ownership receipt.
      // Failed handshakes still retain their lease until the raw socket closes.
      const owned = Promise.allSettled([closed.promise, setup.promise]).then(async () => {
        await tasks.close();
        lease.release();
        this.ownedWebSockets.delete(owned);
      });
      this.ownedWebSockets.add(owned);
      const original = {
        identity,
        close: () => {
          socket.destroy();
        },
        joined: owned,
      };
      this.socketBindings.add(original);
      const forget = () => this.socketBindings.delete(original);
      void owned.then(forget, forget);
      socket.pause();
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
          const connection = this.connectWebSocket(
            webSocket,
            binding,
            tasks,
            protocol,
            admission.claims,
          );
          setup.resolve(connection.closed);
          this.observeConnection(connection, protocol);
          span?.addEvent("antnest.http.upgrade.connection.setup.completed");
        } catch (error) {
          this.report(error, "acp_connect");
          webSocket.close(1011, "ACP connection setup failed");
        }
      });
      return 101;
    } catch (error) {
      this.telemetry.count("antnest.acp.connections", {
        result: "rejected",
        reason: "connection_setup_failed",
      });
      this.report(error, "upgrade_authentication");
      const span = activeHttpSpan();
      if (span !== undefined) recordBoundaryError(span, error, "upgrade_authentication");
      if (error instanceof DomainError && error.code === "connection_quota_exceeded") {
        return rejectQuotaUpgrade(socket, error.code);
      }
      return rejectUpgrade(socket, 503, "Service Unavailable");
    } finally {
      // handleUpgrade has no asynchronous verifyClient hook. If its synchronous
      // callback did not adopt connection.closed, setup owns no pending SDK work.
      setup.resolve();
      socket.resume();
    }
  }

  public async preparePeerWebSocket(
    request: IncomingMessage,
    target: OwnerForwardRequest,
    signal: AbortSignal,
  ): Promise<{ accept(socket: WebSocket): Promise<void>; cancel(): void }> {
    const cancellation = new AbortController();
    const interrupted = AbortSignal.any([signal, cancellation.signal]);
    const joined = Promise.withResolvers<void>();
    const closed = request.socket.closed
      ? Promise.resolve()
      : new Promise<void>((resolve) => request.socket.once("close", resolve));
    let state: "preparing" | "prepared" | "accepted" | "cancelled" = "preparing";
    let prepared: Awaited<ReturnType<AgentAcpHttpServer["preparePeerWebSocketOnce"]>> | undefined;
    const finish = (original: Promise<void> = closed) => {
      interrupted.removeEventListener("abort", cancel);
      const forget = () => {
        this.socketBindings.delete(binding);
        this.forwardedClosers.delete(cancel);
      };
      void original.then(
        () => {
          forget();
          joined.resolve();
        },
        (error: unknown) => {
          forget();
          joined.reject(error);
        },
      );
    };
    const cancel = () => {
      cancellation.abort(new Error("Peer admission cancelled"));
      if (state === "accepted" || state === "cancelled") return;
      request.socket.destroy();
      if (state === "prepared") {
        state = "cancelled";
        prepared!.cancel();
        finish();
      }
    };
    const binding = { identity: target.identity, close: cancel, joined: joined.promise };
    this.socketBindings.add(binding);
    this.forwardedClosers.add(cancel);
    this.ownedWebSockets.add(joined.promise);
    const forget = () => this.ownedWebSockets.delete(joined.promise);
    void joined.promise.then(forget, forget);
    interrupted.addEventListener("abort", cancel, { once: true });
    try {
      interrupted.throwIfAborted();
      prepared = await this.preparePeerWebSocketOnce(request, target, interrupted);
      state = "prepared";
      interrupted.throwIfAborted();
      return {
        cancel,
        accept: (socket) => {
          if (state === "cancelled") {
            socket.terminate();
            return joined.promise;
          }
          state = "accepted";
          const original = prepared!.accept(socket);
          // Register the full owner lifetime before handing off the pending
          // admission. A shutdown already waiting on this promise still joins it.
          finish(original);
          return original;
        },
      };
    } catch (error) {
      cancel();
      finish();
      throw error;
    }
  }

  private async preparePeerWebSocketOnce(
    request: IncomingMessage,
    target: OwnerForwardRequest,
    signal: AbortSignal,
  ): Promise<{ accept(socket: WebSocket): Promise<void>; cancel(): void }> {
    signal.throwIfAborted();
    if (this.options.forwarding === undefined || this.isClosing() || !(await this.options.ready()))
      throw new DomainError("agent_unavailable", "Peer forwarding is unavailable");
    signal.throwIfAborted();
    request.url = target.protocol === "v1" ? "/v1/acp" : "/v2/acp";
    const admission = await this.options.authentication.admitPeer(request, target.caller, true);
    signal.throwIfAborted();
    if ("status" in admission) throw new DomainError("access_denied", "Forwarded caller rejected");
    const identity = trustedIdentity(request.headers);
    if (
      identity === null ||
      !isDeepStrictEqual(identity, target.identity) ||
      this.accessRevoked(identity)
    )
      throw new DomainError("access_denied", "Forwarded identity changed");
    const authority = await this.options.forwarding.admit(target, signal);
    signal.throwIfAborted();
    authority.signal.throwIfAborted();
    if (this.isClosing() || this.accessRevoked(identity))
      throw new DomainError("access_denied", "Forwarded access revoked");
    const lease = this.capacity.reserve(identity);
    let adopted = false;
    return {
      cancel: () => {
        if (!adopted) lease.release();
      },
      accept: (wire) => {
        adopted = true;
        const channel = new PeerSocket(
          wire,
          "owner",
          target.request_id,
          this.options.maxWebSocketPayloadBytes,
        );
        const close = () => channel.close(1001, "Owner connection closing");
        const tasks = new ConnectionTasks();
        const joined = Promise.withResolvers<void>();
        const binding = { identity, close, joined: joined.promise };
        this.socketBindings.add(binding);
        this.forwardedClosers.add(close);
        signal.addEventListener("abort", close, { once: true });
        authority.signal.addEventListener("abort", close, { once: true });
        const original = (async () => {
          const errors: unknown[] = [];
          try {
            signal.throwIfAborted();
            authority.signal.throwIfAborted();
            authority.assertCurrent();
            if (this.accessRevoked(identity))
              throw new DomainError("access_denied", "Forwarded access revoked");
            const connection = this.connectWebSocket(
              channel,
              { ...identity, connectionId: target.request_id, ownerFence: authority.fence },
              tasks,
              target.protocol,
              admission.claims,
            );
            this.observeConnection(connection, target.protocol);
            await connection.closed;
          } catch (error) {
            errors.push(error);
          }
          try {
            await tasks.close();
            close();
            await channel.finishOwner();
          } catch (error) {
            if (error instanceof PeerReceiptDeliveryError) {
              // Local SDK, writes and physical peer socket have already joined.
              // The ingress must independently retain its missing-receipt result.
              this.report(error, "peer_cleanup_receipt_unavailable");
            } else errors.push(error);
          } finally {
            signal.removeEventListener("abort", close);
            authority.signal.removeEventListener("abort", close);
            this.forwardedClosers.delete(close);
            this.socketBindings.delete(binding);
            lease.release();
          }
          if (errors.length) throw new AggregateError(errors, "Forwarded owner cleanup failed");
        })();
        this.ownedWebSockets.add(original);
        void original.then(
          () => {
            this.ownedWebSockets.delete(original);
            joined.resolve();
          },
          (error: unknown) => {
            this.ownedWebSockets.delete(original);
            this.recordForwardingFailure(identity, error);
            joined.reject(error);
          },
        );
        void joined.promise.catch(() => undefined);
        return original;
      },
    };
  }

  private async forwardWebSocket(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    target: OwnerForwardRequest,
    signal: AbortSignal,
  ): Promise<number> {
    if (authenticatedCaller(request) !== "agent-ui")
      throw new DomainError("access_denied", "Forwarded caller rejected");
    const token = fields(request).filter(
      (field) => field.name.toLowerCase() === CALLER_CONTEXT_HEADER.toLowerCase(),
    );
    if (token.length !== 1)
      throw new DomainError("access_denied", "Missing original caller context");
    const lease = this.capacity.reserve(target.identity);
    const state = { adopted: false, opened: false };
    const failures: unknown[] = [];
    let wire: WebSocket;
    try {
      wire = this.options.forwarding!.peers.connect(
        target.target.member_id,
        {
          [OWNER_FORWARD_HEADER]: encodeOwnerForward(target),
          [CALLER_CONTEXT_HEADER]: token[0]!.value,
        },
        this.options.maxWebSocketPayloadBytes,
        Math.max(1, Date.parse(target.deadline_at) - Date.now()),
      );
    } catch (error) {
      lease.release();
      throw error;
    }
    const physical = Promise.withResolvers<void>();
    wire.once("close", () => physical.resolve());
    const channel = new PeerSocket(
      wire,
      "ingress",
      target.request_id,
      this.options.maxWebSocketPayloadBytes,
    );
    const abort = () => wire.terminate();
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        wire.once("open", () => {
          state.opened = true;
          wire.pause();
          resolve();
        });
        wire.once("error", () => reject(new Error("Peer WebSocket admission failed")));
        wire.once("close", () => reject(new Error("Peer WebSocket closed before admission")));
      });
      signal.throwIfAborted();
      if (
        this.isClosing() ||
        this.accessRevoked(target.identity) ||
        Date.now() >= Date.parse(target.deadline_at)
      )
        throw new DomainError("agent_unavailable", "Forwarded admission expired");
      this.webSockets.handleUpgrade(request, socket, head, (client) => {
        state.adopted = true;
        const closed = Promise.withResolvers<void>();
        const sends = new Set<Promise<void>>();
        const errors: unknown[] = [];
        const retain = (original: Promise<void>) => {
          sends.add(original);
          void original.then(
            () => sends.delete(original),
            (error: unknown) => {
              sends.delete(original);
              errors.push(error);
              client.close(1011, "Peer delivery failed");
              channel.close(1011, "Peer delivery failed");
            },
          );
        };
        const close = () => {
          client.close(1001, "Forwarded connection closing");
          channel.close(1001, "Forwarded connection closing");
        };
        this.connections.add(client);
        this.forwardedClosers.add(close);
        client.on("message", (data, binary) => {
          client.pause();
          retain(channel.forward(data, binary).finally(() => client.resume()));
        });
        channel.on("message", (data: Buffer, binary: boolean) => {
          wire.pause();
          retain(
            new Promise<void>((resolve, reject) =>
              client.send(data, { binary }, (error) => {
                wire.resume();
                if (error) reject(error);
                else resolve();
              }),
            ),
          );
        });
        channel.once("close", (code: number, reason: Buffer) => client.close(code, reason));
        client.once("error", close);
        client.once("close", () => {
          channel.close();
          closed.resolve();
          this.connections.delete(client);
        });
        const original = (async () => {
          await closed.promise;
          const cleanup = await Promise.allSettled([channel.finishIngress(), ...sends]);
          if (errors.length || cleanup.some((result) => result.status === "rejected"))
            throw new AggregateError(
              [
                ...errors,
                ...cleanup
                  .filter((result): result is PromiseRejectedResult => result.status === "rejected")
                  .map((result) => result.reason as unknown),
              ],
              "Forwarded connection cleanup failed",
            );
        })();
        const binding = { identity: target.identity, close, joined: original };
        this.socketBindings.add(binding);
        this.ownedWebSockets.add(original);
        const forget = () => {
          this.socketBindings.delete(binding);
          this.ownedWebSockets.delete(original);
          this.forwardedClosers.delete(close);
          lease.release();
        };
        void original.then(forget, (error: unknown) => {
          this.recordForwardingFailure(target.identity, error);
          forget();
        });
        wire.resume();
      });
    } catch (error) {
      failures.push(error);
    } finally {
      signal.removeEventListener("abort", abort);
      if (!state.adopted) {
        try {
          if (state.opened) {
            wire.resume();
            await channel.finishIngress();
          } else {
            wire.terminate();
            await physical.promise;
          }
        } catch (error) {
          this.recordForwardingFailure(target.identity, error);
          failures.push(error);
        } finally {
          lease.release();
        }
      }
    }
    if (failures.length) throw new AggregateError(failures, "Forwarded admission failed");
    return 101;
  }

  private recordForwardingFailure(identity: ExecutionIdentity, error: unknown): void {
    const key = JSON.stringify([identity.organizationId, identity.principalId, identity.agentId]);
    if (!this.forwardingFailures.has(key))
      this.forwardingFailures.set(key, { identity: { ...identity }, error });
  }

  private connectWebSocket(
    socket: JsonSocket,
    binding: ConnectionBinding,
    tasks: ConnectionTasks,
    protocol: "v1" | "v2",
    claims?: CallerClaims,
  ) {
    if (protocol === "v1") {
      return createAcpV1Agent({
        binding,
        tasks,
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
          socket,
          () => claims === undefined || Date.now() < (claims.exp + 30) * 1000,
        ),
      );
    }
    return createAcpV2Agent({
      binding,
      tasks,
      promptCapabilities,
      application: this.options.application,
      outputs: this.outputs,
      ...(this.options.permissions === undefined ? {} : { permissions: this.options.permissions }),
    }).connect(
      createAcpV2WebSocketWireStream(
        socket,
        () => claims === undefined || Date.now() < (claims.exp + 30) * 1000,
      ),
    );
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

function rejectQuotaUpgrade(socket: Duplex, code: string): number {
  const failure = httpFailure(code);
  if (!socket.destroyed) {
    const body = JSON.stringify(failure.body);
    socket.end(
      `HTTP/1.1 ${failure.status} Too Many Requests\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nRetry-After: 1\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
    );
  }
  return failure.status;
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
