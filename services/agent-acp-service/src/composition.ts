import { buildAgentComponents } from "./composition-agent.js";
import { OwnedAgentComponents } from "./composition-owned.js";
import { LearningStatusReader } from "./application/learning-status-reader.js";
import { SkillSources } from "./application/skill-sources.js";
import { SkillProjectionWorker } from "./application/skill-projection-worker.js";
import { PostgresSkillSourceProjections } from "./adapters/postgres/skill-source-projections.js";
import {
  RegistrySkillProjectionClient,
  RuntimeSkillSourceVerifier,
} from "./adapters/skill-source-http.js";
import { PostgresLearningStatusRead } from "./adapters/postgres/learning-status-read.js";
import { PermissionConnections } from "./application/permission-connections.js";
import { setTimeout as delay } from "node:timers/promises";

import { Pool } from "pg";
import { RuntimeConnections } from "./adapters/runtime-connections.js";
import type { RuntimeConnectionAuthority } from "./ports/runtime-connections.js";

import { PostgresExecutionConfiguration } from "./adapters/postgres/execution-configuration.js";
import {
  ExecutionDirectory,
  type LocalExecutionPublication,
} from "./application/execution-directory.js";
import { PeerAcknowledgement } from "./application/peer-acknowledgement.js";
import { parsePeerPublicationRequest } from "./application/peer-request.js";
import { PeerAuthentication } from "./adapters/peer-authentication.js";
import { HttpAgentPeers } from "./adapters/http-agent-peers.js";
import { PostgresPeerMembership } from "./adapters/postgres/peer-membership.js";
import { PostgresPeerParticipation } from "./adapters/postgres/peer-participation.js";
import { PeerAvailability } from "./application/peer-availability.js";
import { PeerServer } from "./transport/peer-server.js";
import { DomainError } from "./domain/errors.js";
import { executionPublication } from "./domain/execution-publication.js";
import { isDeepStrictEqual } from "node:util";
import type { PeerPublicationRequest } from "./ports/agent-peers.js";
import { PeerDeadlineError } from "./ports/agent-peers.js";
import { ProviderClients } from "./application/provider-clients.js";
import { AgentSettlement } from "./application/agent-settlement.js";
import { AgentAssignment } from "./application/agent-assignment.js";
import type { AgentOwnershipScope } from "./domain/agent-ownership.js";
import { OwnerForwarding } from "./application/owner-forwarding.js";
import { HttpOwnerHandles } from "./application/http-owner-handle.js";
import { PostgresAgentLeases } from "./adapters/postgres/agent-leases.js";
import { AgentExecutionState } from "./application/agent-execution-state.js";
import { ExecutionAudits } from "./application/execution-audit.js";
import { PostgresExecutionAudits } from "./adapters/postgres/execution-audit.js";
import type { ExecutionAccessSnapshot } from "./domain/execution-configuration.js";
import { SessionOutputStreams } from "./transport/acp/session-output.js";
import { OpenAICompatibleModel } from "./adapters/model/openai-compatible.js";
import { ModelTransportCleanupError } from "./ports/model.js";
import { PostgresRuntimeBarrierReader } from "./adapters/postgres/runtime-barrier.js";
import { PostgresKernel, postgresPoolOptions } from "./adapters/postgres/kernel.js";
import { migrate } from "./adapters/postgres/migrate.js";
import { createLegacyAgentRepositories } from "./adapters/postgres/agent-repositories.js";
import { createLegacyLearningRepositories } from "./adapters/postgres/learning-repositories.js";
import { PostgresBridgeObservationRepository } from "./adapters/postgres/bridge-observation-repository.js";
import { BridgeObservationService } from "./application/bridge-observation.js";
import { SecretBox } from "./adapters/postgres/secret-box.js";
import { PostgresWorkerLock, WorkerOwnershipLostError } from "./adapters/postgres/worker-lock.js";
import { AccessService } from "./application/access-service.js";
import { RuntimeSkillCommands } from "./application/runtime-skill-commands.js";
import { LearningChangeReader } from "./application/learning-change-reader.js";
import { LearningNoticePublisher } from "./application/learning-notice-publisher.js";
import { LearningChangeCursor } from "./domain/learning-change-cursor.js";
import { tracedFetch } from "./telemetry/http.js";
import { RuntimeSkillMaintenanceSigner } from "./adapters/runtime-skill-maintenance-signer.js";
import { PostgresLearningChangeRead } from "./adapters/postgres/learning-change-read.js";
import type { AgentAcpConfig } from "./config.js";
import type { TelemetryPort } from "./ports/telemetry.js";
import { InstrumentedModel } from "./telemetry/instrumented-ports.js";
import { AgentAcpHttpServer } from "./transport/http-server.js";
import {
  OwnerIncarnation,
  OwnerIncarnationError,
  parseOwnerRegistration,
  type OwnerRegistration,
} from "./application/owner-incarnation.js";
import {
  OwnerRegistrationAttemptError,
  OwnerInspectionAttemptError,
  RuntimeControllerIncarnations,
} from "./adapters/runtime-controller-incarnations.js";
import { OwnerProbeServer } from "./transport/owner-probe-server.js";

export type RunningAgentAcpService = {
  failure: Promise<Error>;
  address(): ReturnType<AgentAcpHttpServer["address"]>;
  controlAddress(): ReturnType<AgentAcpHttpServer["controlAddress"]>;
  shutdown(): Promise<void>;
};

export async function startAgentAcpService(
  config: AgentAcpConfig,
  telemetry: TelemetryPort,
  reportOwnershipLoss: (error: WorkerOwnershipLostError) => void,
  startupSignal?: AbortSignal,
): Promise<RunningAgentAcpService> {
  for (const variable of config.developmentSecretWarnings)
    telemetry.log("warn", "published_development_secret_enabled", { variable });
  if (config.providerAllowPrivateEndpoints)
    telemetry.log("warn", "provider_private_endpoints_enabled");
  if (config.skillLearningDebugAgentId !== undefined)
    telemetry.log("warn", "Skill learning debug mode is active", {
      agent_id: config.skillLearningDebugAgentId,
    });
  const pool = new Pool(postgresPoolOptions(config.databaseUrl, config.databaseTimeoutMs));
  pool.on("error", (error) => telemetry.log("error", "postgres_pool_error", {}, error));
  let workerLock: PostgresWorkerLock | undefined;
  let runtimeConnections: RuntimeConnections | undefined;
  const failure = Promise.withResolvers<Error>();
  let serving = false;
  let requestedFailure: Error | undefined;
  let components: ReturnType<typeof buildComponents> | undefined;
  let listeningServer: AgentAcpHttpServer | undefined;
  let incarnation: OwnerIncarnation | undefined;
  let ownerProbe: OwnerProbeServer | undefined;
  let peerServer: PeerServer | undefined;
  let ownerInspection: RuntimeControllerIncarnations | undefined;
  let peerAvailability: PeerAvailability | undefined;
  const background: Promise<void>[] = [];
  const ownership = new AbortController();
  const cancelStartup = (): void => ownership.abort(startupSignal?.reason);
  startupSignal?.addEventListener("abort", cancelStartup, { once: true });
  if (startupSignal?.aborted) cancelStartup();
  const recoveryRequired = (error: Error): void => {
    requestedFailure ??= error;
    serving = false;
    ownership.abort(requestedFailure);
    components?.learningNotices.stop();
    components?.supervisor.stop(requestedFailure);
    failure.resolve(requestedFailure);
  };

  try {
    ownership.signal.throwIfAborted();
    if (config.peer !== undefined && config.ownerIncarnation === undefined)
      throw new Error("ACP peer mode requires registered ownership");
    const peerAuthentication =
      config.peer === undefined
        ? undefined
        : new PeerAuthentication({
            ...config.peer,
            memberId: config.ownerIncarnation!.memberId,
            workload: config.authentication.workload,
          });
    if (config.ownerIncarnation !== undefined) {
      const owner = config.ownerIncarnation;
      incarnation = new OwnerIncarnation(owner.memberId);
      ownerProbe = new OwnerProbeServer({
        incarnation,
        authentication: config.authentication.workload,
      });
      const registration = new RuntimeControllerIncarnations({
        origin: owner.runtimeControllerUrl,
        authentication: config.authentication.workload,
      });
      ownerInspection = registration;
      const deadline = new AbortController();
      const registrationSignal = AbortSignal.any([ownership.signal, deadline.signal]);
      const closeIntent = (): void => incarnation?.close();
      registrationSignal.addEventListener("abort", closeIntent, { once: true });
      if (registrationSignal.aborted) closeIntent();
      const timer = setTimeout(
        () => deadline.abort(new OwnerIncarnationError("deadline_exceeded")),
        owner.registrationTimeoutMs,
      );
      try {
        registrationSignal.throwIfAborted();
        await ownerProbe.listen(owner.listen.host, owner.listen.port);
        registrationSignal.throwIfAborted();
        const original = incarnation.registrationRequest();
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const receipt = await registration.register(original, registrationSignal);
            registrationSignal.throwIfAborted();
            incarnation.acceptRegistration(receipt);
            break;
          } catch (error) {
            if (error instanceof OwnerRegistrationAttemptError && !error.retryable) throw error;
            registrationSignal.throwIfAborted();
            if (attempt === 2 || !(error instanceof OwnerIncarnationError)) throw error;
            // register has joined its original request and body cancellation.
            // The next attempt retains the same pending tuple and total budget.
            await delay(250 * 2 ** attempt, undefined, { signal: registrationSignal });
          }
        }
      } catch (error) {
        if (error instanceof OwnerRegistrationAttemptError && !error.retryable) throw error;
        registrationSignal.throwIfAborted();
        throw error;
      } finally {
        clearTimeout(timer);
        registrationSignal.removeEventListener("abort", closeIntent);
      }
    }
    ownership.signal.throwIfAborted();
    const registeredOwner = incarnation?.currentRegistration();
    if (config.ownerIncarnation !== undefined && registeredOwner === undefined)
      throw new Error("ACP process registration is unavailable");
    const ownedRuntimeConnections = new RuntimeConnections({
      ...config.authentication.workload.runtimeTransport(),
      reportCleanupFailure: () => telemetry.log("warn", "runtime_connection_cleanup_failed"),
    });
    runtimeConnections = ownedRuntimeConnections;
    await telemetry.span("postgres.migrate", { "db.system.name": "postgresql" }, () =>
      migrate(pool),
    );
    ownership.signal.throwIfAborted();
    await new PostgresPeerMembership(new PostgresKernel(pool, telemetry)).assertPinned(
      peerAuthentication?.membership,
    );
    ownership.signal.throwIfAborted();
    await requireDependenciesReady(pool, telemetry);
    ownership.signal.throwIfAborted();
    const acquiredWorkerLock = await telemetry.span(
      "postgres.worker_lock.acquire",
      { "db.system.name": "postgresql" },
      () =>
        PostgresWorkerLock.acquire(pool, {
          mode: peerAuthentication === undefined ? "exclusive" : "shared",
        }),
    );
    workerLock = acquiredWorkerLock;
    ownership.signal.throwIfAborted();
    if (peerAuthentication !== undefined) {
      if (registeredOwner === undefined || ownerInspection === undefined)
        throw new Error("ACP peer participation requires its original registration");
      const participation = new PostgresPeerParticipation(
        new PostgresKernel(pool, telemetry),
        peerAuthentication.membership.sha256,
      );
      // No recovery, lease acquisition or peer/business listener precedes join.
      const expiresAt = Date.now() + config.ownerIncarnation!.registrationTimeoutMs;
      await participation.join(registeredOwner);
      peerAvailability = new PeerAvailability({
        registration: registeredOwner,
        membershipSha256: peerAuthentication.membership.sha256,
        members: peerAuthentication.membership.members.map((member) => member.member_id),
        ledger: participation,
        registry: ownerInspection,
      });
      for (;;) {
        ownership.signal.throwIfAborted();
        try {
          await peerAvailability.refresh(ownership.signal, Math.min(expiresAt, Date.now() + 10000));
          break;
        } catch (error) {
          if (!retryablePeerDiscovery(error)) throw error;
          ownership.signal.throwIfAborted();
          if (Date.now() >= expiresAt) throw error;
          // A sibling may have registered with RC but not joined SQL yet.
          // Retry only after its original discovery calls and cleanup joined.
          await delay(Math.min(100, expiresAt - Date.now()), undefined, {
            signal: ownership.signal,
          });
        }
      }
    }
    const built = buildComponents(
      pool,
      config,
      telemetry,
      recoveryRequired,
      ownership.signal,
      ownedRuntimeConnections,
      registeredOwner,
      ownerInspection,
      (snapshot) => listeningServer?.revokeAccess(snapshot) ?? Promise.resolve(),
      peerAuthentication,
      peerAvailability,
    );
    components = built;
    void acquiredWorkerLock.waitForLoss().then((error) => {
      telemetry.log("error", "worker_lock_lost", {}, error);
      telemetry.count("antnest.acp.worker_lock_losses", {});
      const ownershipLoss = new WorkerOwnershipLostError({ cause: error });
      reportOwnershipLoss(ownershipLoss);
      recoveryRequired(ownershipLoss);
    });

    await waitForStartupRecovery(
      (async () => {
        if (built.owned !== undefined) await built.owned.recoverStartup(acquiredWorkerLock);
        else {
          await acquiredWorkerLock.pauseAbandonedLearningTasks();
          ownership.signal.throwIfAborted();
          await built.permissionRepository.cancelAbandoned();
          ownership.signal.throwIfAborted();
          await built.recovery.recover(ownership.signal);
        }
        ownership.signal.throwIfAborted();
        await built.directory.restore(ownership.signal);
      })(),
      failure.promise,
    );
    if (requestedFailure !== undefined) {
      throw requestedFailure;
    }
    if (!acquiredWorkerLock.isHeld()) {
      const ownershipLoss = new WorkerOwnershipLostError();
      reportOwnershipLoss(ownershipLoss);
      throw ownershipLoss;
    }

    const forwarding =
      peerAuthentication === undefined || built.owned === undefined
        ? undefined
        : {
            resolver: new OwnerForwarding({
              registration: registeredOwner!,
              membershipSha256: peerAuthentication.membership.sha256,
              assignment: new AgentAssignment(
                peerAuthentication.memberId,
                peerAuthentication.membership.members.map((member) => member.member_id),
                () => peerAvailability!.current(),
              ),
              availability: () => peerAvailability!.current(),
              directory: built.directory,
              leases: new PostgresAgentLeases(new PostgresKernel(pool, telemetry)),
              peers: new HttpAgentPeers(peerAuthentication),
            }),
            peers: peerAuthentication,
            stopped: (original: OwnerRegistration) =>
              peerAvailability!
                .current()
                .members.some(
                  (member) =>
                    member.state !== "unregistered" &&
                    member.stopped.some(
                      (proof) =>
                        proof.registration_id === original.registration_id &&
                        proof.member_id === original.member_id &&
                        proof.incarnation_id === original.incarnation_id,
                    ),
                ),
            admit: (
              request: Parameters<OwnedAgentComponents["admitForwardedExecution"]>[0],
              signal: AbortSignal,
            ) => built.owned!.admitForwardedExecution(request, signal),
          };
    if (peerAuthentication !== undefined) {
      peerServer = new PeerServer({
        registration: registeredOwner!,
        authentication: peerAuthentication,
        apply: built.applyPeerPublication,
        maxWebSocketPayloadBytes: config.maxWebSocketPayloadBytes,
        forward: (request, target, signal) => {
          if (listeningServer === undefined)
            throw new DomainError("agent_unavailable", "ACP ingress is not ready");
          return listeningServer.preparePeerWebSocket(request, target, signal);
        },
        forwardHttp: (request, response, member, signal, admitted) => {
          if (listeningServer === undefined)
            throw new DomainError("agent_unavailable", "ACP ingress is not ready");
          return listeningServer.handlePeerHttp(request, response, member, signal, admitted);
        },
        forwardControl: (request, response, member, signal, admitted) => {
          if (listeningServer === undefined)
            throw new DomainError("agent_unavailable", "ACP ingress is not ready");
          return listeningServer.handlePeerControl(request, response, member, signal, admitted);
        },
      });
      await peerServer.listen(config.peer!.listen.host, config.peer!.listen.port);
      ownership.signal.throwIfAborted();
    }
    const server = new AgentAcpHttpServer({
      authentication: config.authentication,
      ...(forwarding === undefined ? {} : { forwarding }),
      ...(forwarding === undefined
        ? {}
        : {
            httpForwarding: {
              ...forwarding,
              registration: registeredOwner!,
              handles: new HttpOwnerHandles({
                secretBox: new SecretBox(config.clientMcpKey),
                membershipSha256: peerAuthentication!.membership.sha256,
              }),
            },
          }),
      executionConfiguration: built.directory,
      settlement: built.settlement,
      executionState: built.executionState,
      executionAudits: built.executionAudits,
      runtimeBarriers: built.runtimeBarriers,
      bridgeObservation: built.bridgeObservation,
      learningChanges: built.learningChanges,
      learningStatus: built.learningStatus,
      notices: built.learningNotices,
      skillCommands: built.skillCommands,
      skillSources: built.skillSources,
      stateDeliveryTimeoutMs: config.stateDeliveryTimeoutMs,
      outputs: built.outputs,
      application: built.application,
      permissions: built.permissionConnections,
      maxWebSocketPayloadBytes: config.maxWebSocketPayloadBytes,
      connectionLimits: config.connectionLimits,
      maxConfigurationBytes: config.maxConfigurationBytes,
      telemetry,
      ready: async () =>
        serving && acquiredWorkerLock.isHeld() && (await dependenciesReady(pool, telemetry)),
    });
    listeningServer = server;
    await server.listenControl(config.controlListen.host, config.controlListen.port);
    ownership.signal.throwIfAborted();
    await server.listen(config.listen.host, config.listen.port);
    ownership.signal.throwIfAborted();
    serving = true;
    built.learningNotices.start();
    built.owned?.start();
    if (peerAvailability !== undefined) {
      const availability = peerAvailability;
      const refreshAborted = (): boolean => ownership.signal.aborted;
      const refresh = (async () => {
        while (!refreshAborted()) {
          try {
            await availability.refresh(ownership.signal, Date.now() + 10000);
            await built.directory.reconcileOwnership(ownership.signal);
          } catch (error) {
            if (!retryablePeerDiscovery(error)) throw error;
            if (ownership.signal.aborted && error === ownership.signal.reason) break;
            if (!(error instanceof DomainError || error instanceof OwnerIncarnationError))
              throw error;
            if (ownership.signal.aborted) break;
            telemetry.log("warn", "peer_ownership_refresh_unavailable", {}, error);
          }
          if (!ownership.signal.aborted)
            await delay(1000, undefined, { signal: ownership.signal }).catch((error: unknown) => {
              if (!ownership.signal.aborted) throw error;
            });
        }
      })().catch((error: unknown) => {
        // Cleanup failures remain observable even when shutdown requested abort.
        recoveryRequired(asError(error));
        throw error;
      });
      void refresh.catch(() => undefined);
      background.push(refresh);
    }
    const learningRun = (built.owned === undefined ? built.learningWorker : undefined)
      ?.run(ownership.signal)
      .catch((error: unknown) => {
        if (!ownership.signal.aborted) recoveryRequired(asError(error));
      });
    if (learningRun !== undefined) background.push(learningRun);
    const projectionRun = built.skillProjectionWorker
      ?.run(ownership.signal)
      .catch((error: unknown) => {
        if (!ownership.signal.aborted) recoveryRequired(asError(error));
      });
    if (projectionRun !== undefined) background.push(projectionRun);
    const temporaryCleanupRun = (
      built.owned === undefined ? built.temporarySkillCleanupWorker : undefined
    )
      ?.run(ownership.signal)
      .catch((error: unknown) => {
        if (!ownership.signal.aborted) recoveryRequired(asError(error));
      });
    if (temporaryCleanupRun !== undefined) background.push(temporaryCleanupRun);
    telemetry.log("info", "service_started", {
      listen_host: config.listen.host,
      listen_port: config.listen.port,
      control_listen_host: config.controlListen.host,
      control_listen_port: config.controlListen.port,
    });

    let shutdownPromise: Promise<void> | undefined;
    const shutdown = (): Promise<void> => {
      shutdownPromise ??= (async () => {
        serving = false;
        ownership.abort(new Error("Agent ACP Service is shutting down"));
        incarnation?.close();
        built.learningNotices.stop();
        const results = await Promise.allSettled([
          server.close(),
          ...(ownerProbe === undefined ? [] : [ownerProbe.close()]),
          ...(peerServer === undefined ? [] : [peerServer.close()]),
          built.supervisor.shutdown(),
          ...(built.owned === undefined ? [] : [built.owned.shutdown()]),
          ...background,
        ]);
        // Review cancellation can settle the worker before the original
        // inference's finally/transport close. Join it before shared resources.
        results.push(await settle(built.joinLegacyModelRequests()));
        results.push(await settle(built.joinRevocations()));
        results.push(
          await settle(ownedRuntimeConnections.close()),
          await settle(acquiredWorkerLock.release()),
          await settle(pool.end()),
          await settle(config.authentication.workload.close()),
        );
        telemetry.log("info", "service_stopped");
        const failures = results
          .filter((result): result is PromiseRejectedResult => result.status === "rejected")
          .map((result) => result.reason as unknown);
        if (failures.length > 0) {
          throw new AggregateError(failures, "Agent ACP Service shutdown was incomplete");
        }
      })();
      return shutdownPromise;
    };
    return {
      failure: failure.promise,
      shutdown,
      address: () => server.address(),
      controlAddress: () => server.controlAddress(),
    };
  } catch (error) {
    const startupError = asError(error);
    ownership.abort(startupError);
    incarnation?.close();
    const probeCleanup = ownerProbe === undefined ? undefined : await settle(ownerProbe.close());
    components?.supervisor.stop(startupError);
    components?.learningNotices.stop();
    const cleanupFailures: unknown[] =
      probeCleanup?.status === "rejected" ? [probeCleanup.reason as unknown] : [];
    for (const cleanup of [
      () => peerServer?.close(),
      () => listeningServer?.close(),
      () => components?.supervisor.shutdown(),
      () => components?.owned?.shutdown(),
      () => Promise.allSettled(background),
      () => components?.joinLegacyModelRequests(),
      () => components?.joinRevocations(),
      () => runtimeConnections?.close(),
      () => workerLock?.release(),
      () => pool.end(),
      () => config.authentication.workload.close(),
    ]) {
      try {
        await cleanup();
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError);
      }
    }
    if (cleanupFailures.length !== 0)
      throw new AggregateError(
        [startupError, ...cleanupFailures],
        "Agent ACP Service startup cleanup was incomplete",
        { cause: error },
      );
    throw startupError;
  } finally {
    startupSignal?.removeEventListener("abort", cancelStartup);
  }
}

export async function waitForStartupRecovery(
  recovery: Promise<void>,
  failure: Promise<Error>,
): Promise<void> {
  try {
    await Promise.race([recovery, failure.then((error) => Promise.reject(error))]);
  } catch (error) {
    // Loss closes admission immediately, but the original recovery still owns
    // its SQL and cleanup. Never release dependencies merely because it lost a race.
    const [joined] = await Promise.allSettled([recovery]);
    if (joined.status === "rejected" && joined.reason !== error)
      throw new AggregateError([error, joined.reason], "Startup recovery failed while stopping", {
        cause: error,
      });
    throw error;
  }
}

export function buildComponents(
  pool: Pool,
  config: AgentAcpConfig,
  telemetry: TelemetryPort,
  recoveryRequired: (error: Error) => void,
  ownershipSignal: AbortSignal,
  runtimeConnections: RuntimeConnectionAuthority,
  registration?: OwnerRegistration,
  ownerInspection?: Pick<RuntimeControllerIncarnations, "inspect">,
  revokeTransports?: (snapshot: ExecutionAccessSnapshot) => Promise<void>,
  peerAuthentication?: PeerAuthentication,
  peerAvailability?: PeerAvailability,
) {
  const kernel = new PostgresKernel(pool, telemetry);
  const secretBox = new SecretBox(config.clientMcpKey);
  const configurationRepository = new PostgresExecutionConfiguration(kernel, secretBox);
  const peerRegistration =
    peerAuthentication === undefined ? undefined : parseOwnerRegistration(registration);
  if (
    peerAuthentication !== undefined &&
    peerAuthentication.memberId !== peerRegistration!.member_id
  )
    throw new Error("ACP peer registration does not match configured membership");
  const peerAssignment =
    peerAuthentication === undefined
      ? undefined
      : new AgentAssignment(
          peerAuthentication.memberId,
          peerAuthentication.membership.members.map((member) => member.member_id),
          peerAvailability === undefined ? undefined : () => peerAvailability.current(),
        );
  const repositories = createLegacyAgentRepositories(kernel, secretBox, ownershipSignal);
  const { permissions: permissionRepository, executions } = repositories;

  const model = new InstrumentedModel(
    new OpenAICompatibleModel({
      destination: { allowPrivateEndpoints: config.providerAllowPrivateEndpoints },
    }),
    telemetry,
  );
  const providers = new ProviderClients(model);
  const legacyModelRequests = new Set<Promise<unknown>>();
  const legacyModelCleanupFailures: ModelTransportCleanupError[] = [];
  const retainLegacyModelRequest = (original: Promise<unknown>): void => {
    legacyModelRequests.add(original);
    void original.then(
      () => legacyModelRequests.delete(original),
      (error: unknown) => {
        if (error instanceof ModelTransportCleanupError) legacyModelCleanupFailures.push(error);
        legacyModelRequests.delete(original);
      },
    );
  };
  const permissionConnections = new PermissionConnections();
  const outputs = new SessionOutputStreams();
  let owned: OwnedAgentComponents | undefined;
  let peerAcknowledgement: PeerAcknowledgement | undefined;
  const revocations = new Map<string, Promise<void>>();
  const revokeAccess = (snapshot: ExecutionAccessSnapshot): void => {
    permissionConnections.revokeAccess(snapshot);
    const original = Promise.allSettled([
      revocations.get(snapshot.organization_id),
      owned === undefined ? agent.supervisor.revokeAccess(snapshot) : owned.revoke(snapshot),
      outputs.revokeAccess(snapshot),
      revokeTransports?.(snapshot),
    ]).then((results) => {
      const errors = results.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (errors.length)
        throw new AggregateError(
          errors.map((result) => result.reason as unknown),
          "Publication revocation failed",
        );
    });
    revocations.set(snapshot.organization_id, original);
    void original.catch((error: unknown) =>
      telemetry.log(
        "error",
        "publication_revocation_failed",
        { organization_id: snapshot.organization_id },
        error,
      ),
    );
  };
  const joinRevocations = async (organizationId?: string): Promise<void> => {
    const scopes = organizationId === undefined ? [...revocations.keys()] : [organizationId];
    const results = await Promise.allSettled(
      scopes.map(async (scope) => {
        await revocations.get(scope);
        await owned?.joinRetirements(scope);
      }),
    );
    const errors = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (errors.length)
      throw new AggregateError(
        errors.map((result) => result.reason as unknown),
        "Publication cleanup was incomplete",
      );
  };
  const directory = new ExecutionDirectory({
    repository: configurationRepository,
    clients: providers,
    runtimeConnections,
    onPublished: (organizationId) => {
      outputs.invalidateOrganization(organizationId);
      owned?.published(organizationId);
    },
    onOwnershipRefreshed: (organizationId) => owned?.published(organizationId),
    needsOwnershipRefresh: (snapshot) => owned?.needsPreparation(snapshot) ?? false,
    ...(peerAuthentication === undefined
      ? {
          beforeAck: async (snapshot: Parameters<OwnedAgentComponents["beforeAck"]>[0]) => {
            await joinRevocations(snapshot.organization_id);
            if (registration !== undefined) {
              if (owned === undefined) throw new Error("Owned Agent components are unavailable");
              await owned.beforeAck(snapshot);
            }
          },
        }
      : {
          beforePeerAck: (capture: LocalExecutionPublication, deadline: Date) => {
            if (peerAcknowledgement === undefined)
              throw new Error("ACP peer acknowledgement is unavailable");
            return peerAcknowledgement.confirm(capture, deadline, ownershipSignal);
          },
        }),
    onInvalidAuthority: (organizationId) =>
      telemetry.log("warn", "execution_authority_unavailable", {
        organization_id: organizationId,
      }),
    onApplied: (snapshot) => {
      revokeAccess(snapshot);
      if (owned !== undefined) return owned.prepare(snapshot);
      agent.learningGate.syncOrganization(snapshot.organization_id, snapshot.agents);
      return Promise.resolve();
    },
    onUnavailable: (organizationId) => {
      revokeAccess({ organization_id: organizationId, agents: [] });
      agent.learningGate.syncOrganization(organizationId, []);
      owned?.withdraw(organizationId);
    },
  });
  const access = new AccessService({ directory });
  const learningChangeRead = new PostgresLearningChangeRead(kernel);
  const learningNotices = new LearningNoticePublisher(access, learningChangeRead);
  const learningRepositories =
    config.skillLearningControllerUrl === undefined || config.skillMaintenanceSigning === undefined
      ? undefined
      : createLegacyLearningRepositories(kernel, ownershipSignal, {
          onSettled: (requestId) => runtimeConnections.releaseOperation(requestId),
          onCommitted: () => learningNotices.wake(),
        });
  const agent: ReturnType<typeof buildAgentComponents> = buildAgentComponents({
    config,
    repositories,
    learningRepositories,
    kernel,
    directory,
    providers,
    permissionConnections,
    access,
    runtimeConnections,
    telemetry,
    ownershipSignal,
    recoveryRequired,
    ...(registration === undefined ? { retainModelRequest: retainLegacyModelRequest } : {}),
    now,
  });
  const {
    application,
    recovery,
    supervisor,
    learningGate,
    learningWorker,
    rawTools,
    temporarySkills,
    temporarySkillCleanupWorker,
    sessionService,
  } = agent;
  if (registration !== undefined)
    owned = new OwnedAgentComponents({
      config,
      kernel,
      directory,
      providers,
      permissionConnections,
      access,
      runtimeConnections,
      telemetry,
      ownershipSignal,
      recoveryRequired,
      now,
      registration,
      ...(peerAssignment === undefined ? {} : { assignment: peerAssignment }),
      ...(peerAvailability === undefined
        ? {}
        : {
            participation: (scope: AgentOwnershipScope) => peerAssignment!.acquireGuard(scope),
          }),
      ...(ownerInspection === undefined ? {} : { ownerInspection }),
      configuration: configurationRepository,
      legacy: repositories,
      legacyRecovery: recovery,
      learningChanged: () => learningNotices.wake(),
    });
  const checkPeerRequest = (request: PeerPublicationRequest, signal: AbortSignal) => {
    ownershipSignal.throwIfAborted();
    signal.throwIfAborted();
    if (
      peerAuthentication === undefined ||
      peerRegistration === undefined ||
      request.membership_sha256 !== peerAuthentication.membership.sha256 ||
      !isDeepStrictEqual(request.target, peerRegistration) ||
      !peerAuthentication.membership.members.some(
        (member) => member.member_id === request.source.member_id,
      )
    )
      throw new DomainError("configuration_unavailable", "ACP peer publication context changed");
    const remaining = Date.parse(request.deadline_at) - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0 || remaining > 10000)
      throw new PeerDeadlineError("ACP peer publication deadline exceeded");
  };
  const localPeerReceipt = async (
    capture: LocalExecutionPublication,
    request: PeerPublicationRequest,
    signal: AbortSignal,
  ) => {
    const lifetime = AbortSignal.any([ownershipSignal, signal]);
    checkPeerRequest(request, lifetime);
    capture.assertCurrent();
    if (
      owned === undefined ||
      !isDeepStrictEqual(executionPublication(capture.authority), request.publication)
    )
      throw new DomainError("configuration_unavailable", "ACP peer publication changed");
    await directory.reconcileOwnership(lifetime, capture.authority.organization_id);
    await joinRevocations(capture.authority.organization_id);
    const fences = await owned.localPublicationFences(capture, lifetime);
    checkPeerRequest(request, lifetime);
    capture.assertCurrent();
    return {
      request_id: request.request_id,
      membership_sha256: request.membership_sha256,
      publication: request.publication,
      registration: peerRegistration!,
      status: "applied" as const,
      revocation: "joined" as const,
      owned_agents: fences.map((fence) => ({ agent_id: fence.agentId, epoch: fence.epoch })),
    };
  };
  if (peerAuthentication !== undefined)
    peerAcknowledgement = new PeerAcknowledgement({
      registration: peerRegistration!,
      membershipSha256: peerAuthentication.membership.sha256,
      members: peerAuthentication.membership.members.map((member) => member.member_id),
      peers: new HttpAgentPeers(peerAuthentication),
      ...(peerAvailability === undefined ? {} : { availability: peerAvailability }),
      local: localPeerReceipt,
      confirm: (expected, fences, options) =>
        configurationRepository.confirmOwnedAuthority(expected, fences, options),
    });
  const applyPeerPublication = async (input: PeerPublicationRequest, signal: AbortSignal) => {
    const request = parsePeerPublicationRequest(input);
    checkPeerRequest(request, signal);
    await peerAvailability?.refresh(
      AbortSignal.any([ownershipSignal, signal]),
      Date.parse(request.deadline_at),
    );
    const capture = await directory.applyPeerPublication(request.publication);
    return localPeerReceipt(capture, request, signal);
  };
  const signing = config.skillMaintenanceSigning;
  const sourceRepository = new PostgresSkillSourceProjections(kernel);
  const discovery = config.skillDiscovery;
  const sourceVerifier =
    signing === undefined
      ? undefined
      : new RuntimeSkillSourceVerifier(
          new RuntimeSkillMaintenanceSigner(signing.kid, signing.privateKey),
          runtimeConnections,
        );
  const skillSources =
    discovery === undefined || sourceVerifier === undefined
      ? undefined
      : {
          service: new SkillSources({
            directory,
            repository: sourceRepository,
            gate: owned ?? learningGate,
            runtime: {
              verify: (record, binding, signal) =>
                telemetry.span(
                  "skill.source.observe",
                  {
                    "antnest.organization_id": record.projection.organization_id,
                    "antnest.agent_id": record.projection.agent_id,
                    "antnest.skill.name": record.projection.name,
                    "antnest.skill.source_sequence": record.projection.sequence,
                    "antnest.skill.content_digest": record.projection.content_digest,
                  },
                  () => sourceVerifier.verify(record, binding, signal),
                ),
            },
          }),
        };
  const projectionClient =
    discovery === undefined
      ? undefined
      : new RegistrySkillProjectionClient(
          discovery.registryUrl,
          tracedFetch(config.dependencyFetchers.registry!, "skill_registry"),
        );
  const skillProjectionWorker =
    projectionClient === undefined
      ? undefined
      : new SkillProjectionWorker({
          repository: sourceRepository,
          directory,
          client: {
            send: (projection, signal) =>
              telemetry.span(
                "skill.projection.deliver",
                {
                  "antnest.organization_id": projection.organization_id,
                  "antnest.agent_id": projection.agent_id,
                  "antnest.skill.name": projection.name,
                  "antnest.skill.source_sequence": projection.sequence,
                  "antnest.skill.content_digest": projection.content_digest,
                  "antnest.skill.active": projection.active,
                },
                () => projectionClient.send(projection, signal),
              ),
          },
          report: (outcome) => telemetry.count("antnest.acp.skill_projections", { outcome }),
        });
  return {
    owned,
    applyPeerPublication,
    skillSources,
    skillProjectionWorker,
    temporarySkillCleanupWorker,
    directory,
    skillCommands:
      owned?.skillCommands ??
      new RuntimeSkillCommands({
        directory,
        gate: learningGate,
        runtime: rawTools,
        busy: (binding) => supervisor.occupancy(binding).busy,
      }),
    settlement:
      owned?.settlement ??
      new AgentSettlement({
        directory,
        supervisor,
        learning: learningGate,
        protection: executions,
        temporarySkills,
        now,
      }),
    executionState:
      owned?.executionState ??
      new AgentExecutionState({ directory, supervisor, protection: executions }),
    executionAudits: new ExecutionAudits(new PostgresExecutionAudits(kernel)),
    runtimeBarriers: new PostgresRuntimeBarrierReader(kernel),
    bridgeObservation: new BridgeObservationService({
      access,
      sessions: sessionService,
      repository: new PostgresBridgeObservationRepository(kernel, telemetry),
    }),
    learningStatus: new LearningStatusReader(access, new PostgresLearningStatusRead(kernel)),
    learningChanges: new LearningChangeReader(
      access,
      learningChangeRead,
      new LearningChangeCursor(config.clientMcpKey),
    ),
    learningNotices,
    outputs,
    application: owned?.application ?? application,
    recovery,
    supervisor,
    learningGate,
    learningWorker,
    permissionConnections,
    permissionRepository,
    joinRevocations,
    async joinLegacyModelRequests(): Promise<void> {
      // Business cancellation and errors remain owned by the review worker;
      // this is the lifetime barrier for its original model calls.
      while (legacyModelRequests.size > 0) await Promise.allSettled([...legacyModelRequests]);
      if (legacyModelCleanupFailures.length > 0)
        throw new AggregateError(legacyModelCleanupFailures, "Model transport cleanup failed");
    },
  };
}

async function requireDependenciesReady(pool: Pool, telemetry: TelemetryPort): Promise<void> {
  if (!(await dependenciesReady(pool, telemetry))) {
    throw new Error("Agent ACP Service dependencies are not ready");
  }
}

export async function dependenciesReady(
  pool: { query(sql: string): Promise<unknown> },
  telemetry: TelemetryPort,
): Promise<boolean> {
  try {
    await telemetry.span("postgres.ready", { "db.system.name": "postgresql" }, () =>
      pool.query("SELECT 1"),
    );
    return true;
  } catch (error) {
    telemetry.log("warn", "dependency_not_ready", {}, error);
    return false;
  }
}

function now(): Date {
  return new Date();
}

async function settle(operation: Promise<void>): Promise<PromiseSettledResult<void>> {
  try {
    await operation;
    return { status: "fulfilled", value: undefined };
  } catch (reason) {
    return { status: "rejected", reason };
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error("Agent ACP Service startup failed");
}

/** Non-retryable transport/cleanup failures cannot be demoted to a refresh warning. */
function retryablePeerDiscovery(error: unknown): boolean {
  if (error instanceof OwnerInspectionAttemptError) return error.retryable && !error.cleanupFailed;
  if (error instanceof AggregateError)
    return error.errors.every((item: unknown) => retryablePeerDiscovery(item));
  if (error instanceof Error && error.cause !== undefined)
    return retryablePeerDiscovery(error.cause);
  return true;
}
