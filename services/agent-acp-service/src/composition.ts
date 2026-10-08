import { LearningStatusReader } from "./application/learning-status-reader.js";
import { SkillSources } from "./application/skill-sources.js";
import { SkillProjectionWorker } from "./application/skill-projection-worker.js";
import { PostgresSkillSourceProjections } from "./adapters/postgres/skill-source-projections.js";
import {
  RegistrySkillProjectionClient,
  RuntimeSkillSourceVerifier,
} from "./adapters/skill-source-http.js";
import { PostgresLearningStatusRead } from "./adapters/postgres/learning-status-read.js";
import { SessionConfigurationService } from "./application/session-configuration.js";
import { PostgresToolPermissions } from "./adapters/postgres/tool-permissions.js";
import { PostgresSkillDiscoveryAuthority } from "./adapters/postgres/skill-discovery-authority.js";
import { RegistrySkillDiscoveryClient } from "./adapters/skill-discovery-http.js";
import { SkillDiscoveryTools } from "./application/skill-discovery-tools.js";
import { TemporarySkills } from "./application/temporary-skills.js";
import { TemporarySkillCleanupWorker } from "./application/temporary-skill-cleanup-worker.js";
import { PostgresTemporarySkills } from "./adapters/postgres/temporary-skills.js";
import { RuntimeSkillTemporaryClient } from "./adapters/runtime-skill-temporary-client.js";
import { DomainError } from "./domain/errors.js";
import { PermissionConnections } from "./application/permission-connections.js";
import { ToolPermissions } from "./application/tool-permissions.js";
import { PostgresSessionConfiguration } from "./adapters/postgres/session-configuration.js";
import { newResourceId } from "./domain/resource-id.js";

import { Pool } from "pg";
import { RuntimeConnections } from "./adapters/runtime-connections.js";
import type { RuntimeConnectionAuthority } from "./ports/runtime-connections.js";

import { PostgresExecutionConfiguration } from "./adapters/postgres/execution-configuration.js";
import { ExecutionDirectory } from "./application/execution-directory.js";
import { ProviderClients } from "./application/provider-clients.js";
import { AgentSettlement } from "./application/agent-settlement.js";
import { AgentExecutionState } from "./application/agent-execution-state.js";
import { ExecutionAudits } from "./application/execution-audit.js";
import { PostgresExecutionAudits } from "./adapters/postgres/execution-audit.js";
import type { ExecutionAccessSnapshot } from "./domain/execution-configuration.js";
import { SessionOutputStreams } from "./transport/acp/session-output.js";
import { OfficialMcpDialer } from "./adapters/mcp/official-client.js";
import { McpToolCatalog } from "./adapters/mcp/tool-catalog.js";
import { OpenAICompatibleModel } from "./adapters/model/openai-compatible.js";
import { PostgresContextRepository } from "./adapters/postgres/context-repository.js";
import { PostgresExecutionRepository } from "./adapters/postgres/execution-repository.js";
import { PostgresKernel, postgresPoolOptions } from "./adapters/postgres/kernel.js";
import { migrate } from "./adapters/postgres/migrate.js";
import { PostgresRunEventRepository } from "./adapters/postgres/run-event-repository.js";
import { PostgresRunRepository } from "./adapters/postgres/run-repository.js";
import { PostgresBridgeObservationRepository } from "./adapters/postgres/bridge-observation-repository.js";
import { BridgeObservationService } from "./application/bridge-observation.js";
import { SecretBox } from "./adapters/postgres/secret-box.js";
import { PostgresSessionRepository } from "./adapters/postgres/session-repository.js";
import { PostgresWorkerLock, WorkerOwnershipLostError } from "./adapters/postgres/worker-lock.js";
import { AcpApplication } from "./application/application.js";
import { AccessService } from "./application/access-service.js";
import { ContextBuilder } from "./application/context-builder.js";
import { RuntimeSkillCommands } from "./application/runtime-skill-commands.js";
import { PromptCoordinator } from "./application/prompt-coordinator.js";
import { RunExecutor } from "./application/run-executor.js";
import { RunRecovery } from "./application/run-recovery.js";
import { RunSupervisor } from "./application/run-supervisor.js";
import { LearningForegroundGate } from "./application/learning-foreground-gate.js";
import { LearningMaintenanceGuard } from "./application/learning-maintenance-guard.js";
import { LearningPausedRecovery } from "./application/learning-paused-recovery.js";
import { LearningWorker } from "./application/learning-worker.js";
import { LearningScanSweep } from "./application/learning-scan-sweep.js";
import {
  LearningScanCoordinator,
  PersistedLearningReviewCue,
} from "./application/learning-scan-coordinator.js";
import { LearningClaimAdmission } from "./application/learning-claim-admission.js";
import { LearningModelAdmission } from "./application/learning-model-admission.js";
import { LearningModelAuthority } from "./application/learning-model-authority.js";
import { LearningReviewRunner } from "./application/learning-review-runner.js";
import {
  LearningTelemetry,
  InstrumentedLearningTaskProcessor,
  InstrumentedLearningApply,
} from "./telemetry/learning.js";
import { LearningReviewProcessor } from "./application/learning-review-processor.js";
import { LearningApplyAttempt } from "./application/learning-apply-attempt.js";
import { LearningApplyRecovery } from "./application/learning-apply-recovery.js";
import { LearningEffectRecovery } from "./application/learning-effect-recovery.js";
import { LearningTaskProcessor } from "./application/learning-task-processor.js";
import { LearningChangeReader } from "./application/learning-change-reader.js";
import { LearningNoticePublisher } from "./application/learning-notice-publisher.js";
import { LearningChangeCursor } from "./domain/learning-change-cursor.js";
import { ControllerLearningPolicyClient } from "./adapters/controller-learning-policy.js";
import { tracedFetch } from "./telemetry/http.js";
import { DirectoryLearningRuntimeBinding } from "./adapters/learning-runtime-binding.js";
import { RuntimeSkillMaintenanceSigner } from "./adapters/runtime-skill-maintenance-signer.js";
import { RuntimeSkillMaintenanceClient } from "./adapters/runtime-skill-maintenance-client.js";
import { PostgresLearningCandidateCleanup } from "./adapters/postgres/learning-candidate-cleanup.js";
import { LearningCandidateCleanup } from "./application/learning-candidate-cleanup.js";
import { PostgresLearningScan } from "./adapters/postgres/learning-scan.js";
import { PostgresLearningEvidence } from "./adapters/postgres/learning-evidence.js";
import { PostgresLearningBudget } from "./adapters/postgres/learning-budget.js";
import { PostgresLearningReviewSource } from "./adapters/postgres/learning-review-source.js";
import { PostgresLearningCandidates } from "./adapters/postgres/learning-candidates.js";
import { PostgresLearningManagedSkills } from "./adapters/postgres/learning-managed-skills.js";
import { PostgresLearningTaskOutcomes } from "./adapters/postgres/learning-task-outcomes.js";
import { PostgresLearningMaintenanceLedger } from "./adapters/postgres/learning-maintenance-ledger.js";
import { PostgresLearningCommitRequests } from "./adapters/postgres/learning-commit-requests.js";
import { PostgresLearningApplyBases } from "./adapters/postgres/learning-apply-bases.js";
import { PostgresLearningChanges } from "./adapters/postgres/learning-changes.js";
import { PostgresLearningChangeRead } from "./adapters/postgres/learning-change-read.js";
import { SessionService } from "./application/session-service.js";
import type { AgentAcpConfig } from "./config.js";
import type { TelemetryPort } from "./ports/telemetry.js";
import {
  InstrumentedAcpApplication,
  InstrumentedRunExecutor,
  InstrumentedModel,
  InstrumentedToolCatalog,
  InstrumentedRuntimeInformation,
} from "./telemetry/instrumented-ports.js";
import { AgentAcpHttpServer } from "./transport/http-server.js";
import { InstrumentedToolPermissions } from "./telemetry/instrumented-permissions.js";

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
  const ownership = new AbortController();
  const recoveryRequired = (error: Error): void => {
    requestedFailure ??= error;
    serving = false;
    ownership.abort(requestedFailure);
    components?.learningNotices.stop();
    components?.supervisor.stop(requestedFailure);
    failure.resolve(requestedFailure);
  };

  try {
    const ownedRuntimeConnections = new RuntimeConnections({
      ...config.authentication.workload.runtimeTransport(),
      reportCleanupFailure: () => telemetry.log("warn", "runtime_connection_cleanup_failed"),
    });
    runtimeConnections = ownedRuntimeConnections;
    await telemetry.span("postgres.migrate", { "db.system.name": "postgresql" }, () =>
      migrate(pool),
    );
    await requireDependenciesReady(pool, telemetry);
    const acquiredWorkerLock = await telemetry.span(
      "postgres.worker_lock.acquire",
      { "db.system.name": "postgresql" },
      () => PostgresWorkerLock.acquire(pool),
    );
    workerLock = acquiredWorkerLock;
    const built = buildComponents(
      pool,
      config,
      telemetry,
      recoveryRequired,
      ownership.signal,
      ownedRuntimeConnections,
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
        await acquiredWorkerLock.pauseAbandonedLearningTasks();
        ownership.signal.throwIfAborted();
        await built.permissionRepository.cancelAbandoned();
        ownership.signal.throwIfAborted();
        await built.recovery.recover(ownership.signal);
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

    const server = new AgentAcpHttpServer({
      authentication: config.authentication,
      executionConfiguration: built.directory,
      settlement: built.settlement,
      executionState: built.executionState,
      executionAudits: built.executionAudits,
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
      maxConfigurationBytes: config.maxConfigurationBytes,
      telemetry,
      ready: async () =>
        serving && acquiredWorkerLock.isHeld() && (await dependenciesReady(pool, telemetry)),
    });
    listeningServer = server;
    await server.listenControl(config.controlListen.host, config.controlListen.port);
    await server.listen(config.listen.host, config.listen.port);
    serving = true;
    built.learningNotices.start();
    const learningRun = built.learningWorker?.run(ownership.signal).catch((error: unknown) => {
      if (!ownership.signal.aborted) recoveryRequired(asError(error));
    });
    const projectionRun = built.skillProjectionWorker
      ?.run(ownership.signal)
      .catch((error: unknown) => {
        if (!ownership.signal.aborted) recoveryRequired(asError(error));
      });
    const temporaryCleanupRun = built.temporarySkillCleanupWorker
      .run(ownership.signal)
      .catch((error: unknown) => {
        if (!ownership.signal.aborted) recoveryRequired(asError(error));
      });
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
        built.learningNotices.stop();
        const results = await Promise.allSettled([
          server.close(),
          built.supervisor.shutdown(),
          ...(learningRun === undefined ? [] : [learningRun]),
          ...(projectionRun === undefined ? [] : [projectionRun]),
          temporaryCleanupRun,
        ]);
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
    if (startupError instanceof WorkerOwnershipLostError) {
      await runtimeConnections?.close().catch(() => undefined);
      throw startupError;
    }
    components?.supervisor.stop(startupError);
    components?.learningNotices.stop();
    await listeningServer?.close().catch(() => undefined);
    await components?.supervisor.shutdown().catch(() => undefined);
    await runtimeConnections?.close().catch(() => undefined);
    await workerLock?.release().catch(() => undefined);
    await pool.end().catch(() => undefined);
    await config.authentication.workload.close().catch(() => undefined);
    throw startupError;
  }
}

export async function waitForStartupRecovery(
  recovery: Promise<void>,
  failure: Promise<Error>,
): Promise<void> {
  await Promise.race([recovery, failure.then((error) => Promise.reject(error))]);
}

export function buildComponents(
  pool: Pool,
  config: AgentAcpConfig,
  telemetry: TelemetryPort,
  recoveryRequired: (error: Error) => void,
  ownershipSignal: AbortSignal,
  runtimeConnections: RuntimeConnectionAuthority,
) {
  const kernel = new PostgresKernel(pool, telemetry);
  const sessions = new PostgresSessionRepository(kernel, new SecretBox(config.clientMcpKey));
  const runs = new PostgresRunRepository(kernel);
  const contexts = new PostgresContextRepository(kernel);
  const executions = new PostgresExecutionRepository(kernel);
  const events = new PostgresRunEventRepository(kernel);

  const model = new InstrumentedModel(
    new OpenAICompatibleModel({
      destination: { allowPrivateEndpoints: config.providerAllowPrivateEndpoints },
    }),
    telemetry,
  );
  const providers = new ProviderClients(model);
  const permissionConnections = new PermissionConnections();
  const outputs = new SessionOutputStreams();
  const learningGate: LearningForegroundGate = new LearningForegroundGate(
    (scope) => supervisor.occupancy({ ...scope, principalId: "" }).busy,
  );
  const revokeAccess = (snapshot: ExecutionAccessSnapshot): void => {
    supervisor.revokeAccess(snapshot);
    permissionConnections.revokeAccess(snapshot);
    outputs.revokeAccess(snapshot);
  };
  const directory = new ExecutionDirectory({
    repository: new PostgresExecutionConfiguration(kernel),
    clients: providers,
    runtimeConnections,
    onPublished: (organizationId) => outputs.invalidateOrganization(organizationId),
    onApplied: (snapshot) => {
      revokeAccess(snapshot);
      learningGate.syncOrganization(snapshot.organization_id, snapshot.agents);
      return Promise.resolve();
    },
    onUnavailable: (organizationId) => {
      revokeAccess({ organization_id: organizationId, agents: [] });
      learningGate.syncOrganization(organizationId, []);
    },
  });
  const signing = config.skillMaintenanceSigning;
  const signer =
    signing === undefined
      ? undefined
      : new RuntimeSkillMaintenanceSigner(signing.kid, signing.privateKey);
  // Cleanup survives configuration disabling discovery; persisted scopes remain authoritative.
  const temporarySkills = new TemporarySkills(
    new PostgresTemporarySkills(kernel),
    new RuntimeSkillTemporaryClient(signer, runtimeConnections, undefined, (scope) =>
      directory.runtimeForCleanup(scope),
    ),
    telemetry,
  );
  const temporarySkillCleanupWorker = new TemporarySkillCleanupWorker({
    skills: temporarySkills,
    gate: learningGate,
    report: (outcome) => telemetry.count("antnest.acp.skill_temporary_cleanup", { outcome }),
  });
  const rawTools = new McpToolCatalog({
    runtimeDialer: new OfficialMcpDialer({ trust: "runtime", connections: runtimeConnections }),
    revisions: sessions,
    reportConnectionCloseFailure: (source, sourceId, error) => {
      telemetry.count("antnest.acp.mcp.close_failures", { source });
      telemetry.log(
        "warn",
        "mcp_connection_close_failed",
        { "mcp.source": source, "mcp.source_id": sourceId },
        error,
      );
    },
  });
  const tools = new InstrumentedToolCatalog(
    config.skillDiscovery === undefined
      ? rawTools
      : new SkillDiscoveryTools({
          runtime: rawTools,
          registry: new RegistrySkillDiscoveryClient(
            config.skillDiscovery.registryUrl,
            tracedFetch(config.dependencyFetchers.registry!, "skill_registry"),
          ),
          authority: new PostgresSkillDiscoveryAuthority(kernel, directory),
          temporary: temporarySkills,
          telemetry,
        }),
    telemetry,
  );
  const information = new InstrumentedRuntimeInformation(rawTools, telemetry);
  const access = new AccessService({ directory });
  const permissionRepository = new PostgresToolPermissions(kernel);
  const permissions = new InstrumentedToolPermissions(
    new ToolPermissions(permissionRepository, permissionConnections, access),
    telemetry,
  );
  const executor = new RunExecutor({
    runtimeConnections,
    temporarySkills,
    permissions,
    executions,
    contextBuilder: new ContextBuilder({
      repository: contexts,
      runtimeInformation: information,
      readSkill: (binding, path, signal) => rawTools.readSkill(binding, path, signal),
      tools,
      id: newResourceId,
      now,
    }),
    providers,
    tools,
    events,
    ownershipSignal,
    recoveryRequired,
    id: newResourceId,
    now,
  });
  const supervisor: RunSupervisor = new RunSupervisor(
    new InstrumentedRunExecutor(executor, telemetry),
    async (scope, signal) => {
      await learningGate.preempt(scope, signal);
      try {
        await temporarySkills.releaseAgent(scope, signal);
      } catch {
        signal.throwIfAborted();
        throw new DomainError("runtime_barrier_required", "Temporary Skill cleanup is pending");
      }
    },
  );
  const sessionService = new SessionService({ repository: sessions, id: newResourceId, now });
  const application = new InstrumentedAcpApplication(
    new AcpApplication({
      configuration: new SessionConfigurationService({
        sessions: sessionService,
        repository: new PostgresSessionConfiguration(kernel),
        directory,
        now,
      }),
      access,
      sessions: sessionService,
      prompts: new PromptCoordinator({
        repository: runs,
        directory,
        protection: executions,
        runTimeoutMs: config.runTimeoutMs,
        recoveryRequired,
        id: newResourceId,
        now,
      }),
      runs: supervisor,
    }),
    telemetry,
  );
  const recovery = new RunRecovery({
    executions,
    runs,
    events,
    telemetry,
    now,
  });
  const learningChangeRead = new PostgresLearningChangeRead(kernel);
  const learningNotices = new LearningNoticePublisher(access, learningChangeRead);
  const learningWorker = buildLearningWorker({
    config,
    kernel,
    directory,
    providers,
    rawTools,
    gate: learningGate,
    telemetry,
    onCommitted: () => learningNotices.wake(),
    temporarySkills,
    runtimeConnections,
  });
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
            gate: learningGate,
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
    skillSources,
    skillProjectionWorker,
    temporarySkillCleanupWorker,
    directory,
    skillCommands: new RuntimeSkillCommands({
      directory,
      gate: learningGate,
      runtime: rawTools,
      busy: (binding) => supervisor.occupancy(binding).busy,
    }),
    settlement: new AgentSettlement({
      directory,
      supervisor,
      learning: learningGate,
      protection: executions,
      temporarySkills,
      now,
    }),
    executionState: new AgentExecutionState({ directory, supervisor, protection: executions }),
    executionAudits: new ExecutionAudits(new PostgresExecutionAudits(kernel)),
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
    application,
    recovery,
    supervisor,
    learningGate,
    learningWorker,
    permissionConnections,
    permissionRepository,
  };
}

function buildLearningWorker(input: {
  config: AgentAcpConfig;
  kernel: PostgresKernel;
  directory: ExecutionDirectory;
  providers: ProviderClients;
  rawTools: McpToolCatalog;
  gate: LearningForegroundGate;
  telemetry: TelemetryPort;
  onCommitted: () => void;
  temporarySkills: TemporarySkills;
  runtimeConnections: RuntimeConnectionAuthority;
}): LearningWorker | undefined {
  const { config, kernel, directory, providers, rawTools, gate, telemetry, onCommitted } = input;
  if (
    config.skillLearningControllerUrl === undefined ||
    config.skillMaintenanceSigning === undefined
  )
    return undefined;
  const policy = new ControllerLearningPolicyClient(
    config.skillLearningControllerUrl,
    tracedFetch(config.dependencyFetchers.controller!, "agent_controller"),
  );
  const scanStore = new PostgresLearningScan(kernel);
  const evidence = new PostgresLearningEvidence(kernel);
  const budget = new PostgresLearningBudget(kernel);
  const candidates = new PostgresLearningCandidates(kernel);
  const managed = new PostgresLearningManagedSkills(kernel);
  const outcomes = new PostgresLearningTaskOutcomes(kernel);
  const intents = new PostgresLearningMaintenanceLedger(kernel, (requestId) =>
    input.runtimeConnections.releaseOperation(requestId),
  );
  const commitRequests = new PostgresLearningCommitRequests(kernel);
  const bases = new PostgresLearningApplyBases(kernel);
  const changes = new PostgresLearningChanges(kernel, onCommitted);
  const binding = new DirectoryLearningRuntimeBinding(directory);
  const cleanupBinding = { current: binding.forCleanup.bind(binding) };
  const signer = new RuntimeSkillMaintenanceSigner(
    config.skillMaintenanceSigning.kid,
    config.skillMaintenanceSigning.privateKey,
  );
  const runtime = new RuntimeSkillMaintenanceClient(signer, intents, input.runtimeConnections);
  const guard = new LearningMaintenanceGuard(gate, intents, (scope, signal) =>
    input.temporarySkills.assertClearAgent(scope, signal),
  );
  const modelAdmission = new LearningModelAdmission(policy, budget);
  const reviewRunner = new LearningReviewRunner(
    evidence,
    new PostgresLearningReviewSource(kernel),
    new LearningModelAuthority(directory),
    modelAdmission,
    budget,
    providers,
    new LearningTelemetry(telemetry),
  );
  const review = new LearningReviewProcessor(reviewRunner, evidence, candidates, managed, outcomes);
  const apply = new LearningApplyAttempt(
    candidates,
    binding,
    policy,
    rawTools,
    managed,
    runtime,
    bases,
    commitRequests,
    changes,
  );
  const processor = new InstrumentedLearningTaskProcessor(
    new LearningTaskProcessor(review, new InstrumentedLearningApply(apply, telemetry), outcomes),
    telemetry,
  );
  const effectRecovery = new LearningEffectRecovery(intents, runtime, cleanupBinding);
  const applyRecovery = new LearningApplyRecovery(effectRecovery, commitRequests, changes);
  const paused = new LearningPausedRecovery(
    outcomes,
    guard,
    applyRecovery,
    intents,
    policy,
    processor,
    gate,
    (claim, error) =>
      telemetry.log(
        "warn",
        "skill_learning_recovery_failed",
        {
          task_id: claim.taskId,
          agent_id: claim.agentId,
        },
        error,
      ),
  );
  const coordinator = new LearningScanCoordinator(
    policy,
    scanStore,
    new PersistedLearningReviewCue(scanStore),
    config.skillLearningDebugAgentId,
  );
  const scan = new LearningScanSweep(scanStore, coordinator, (scope, error) =>
    telemetry.log(
      "warn",
      "skill_learning_scan_failed",
      {
        agent_id: scope.agentId,
      },
      error,
    ),
  );
  return new LearningWorker(
    paused,
    scan,
    new LearningClaimAdmission(policy, scanStore),
    guard,
    processor,
    outcomes,
    (claim, error) =>
      telemetry.log(
        "warn",
        "skill_learning_task_failed",
        {
          task_id: claim.taskId,
          agent_id: claim.agentId,
        },
        error,
      ),
    undefined,
    (error) => telemetry.log("warn", "skill_learning_cycle_failed", {}, error),
    new LearningCandidateCleanup(
      new PostgresLearningCandidateCleanup(kernel),
      cleanupBinding,
      runtime,
      guard,
    ),
  );
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
