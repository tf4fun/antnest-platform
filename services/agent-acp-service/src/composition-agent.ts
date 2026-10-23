import { buildLearningWorker } from "./composition-learning.js";
import type { createLegacyAgentRepositories } from "./adapters/postgres/agent-repositories.js";
import type { createLegacyLearningRepositories } from "./adapters/postgres/learning-repositories.js";
import type { PostgresKernel } from "./adapters/postgres/kernel.js";
import { PostgresSkillDiscoveryAuthority } from "./adapters/postgres/skill-discovery-authority.js";
import { RegistrySkillDiscoveryClient } from "./adapters/skill-discovery-http.js";
import { RuntimeSkillTemporaryClient } from "./adapters/runtime-skill-temporary-client.js";
import { RuntimeSkillMaintenanceSigner } from "./adapters/runtime-skill-maintenance-signer.js";
import { OfficialMcpDialer } from "./adapters/mcp/official-client.js";
import { McpToolCatalog } from "./adapters/mcp/tool-catalog.js";
import { AcpApplication } from "./application/application.js";
import type { AccessService } from "./application/access-service.js";
import type { ExecutionDirectory } from "./application/execution-directory.js";
import type { PermissionConnections } from "./application/permission-connections.js";
import type { ProviderClients } from "./application/provider-clients.js";
import { ContextBuilder } from "./application/context-builder.js";
import { LearningForegroundGate } from "./application/learning-foreground-gate.js";
import { PromptCoordinator } from "./application/prompt-coordinator.js";
import { RunExecutor } from "./application/run-executor.js";
import { RunRecovery } from "./application/run-recovery.js";
import { RunSupervisor } from "./application/run-supervisor.js";
import { SessionService } from "./application/session-service.js";
import { SessionConfigurationService } from "./application/session-configuration.js";
import { SkillDiscoveryTools } from "./application/skill-discovery-tools.js";
import { TemporarySkills } from "./application/temporary-skills.js";
import { ToolPermissions } from "./application/tool-permissions.js";
import { TemporarySkillCleanupWorker } from "./application/temporary-skill-cleanup-worker.js";
import type { AgentAcpConfig } from "./config.js";
import { DomainError } from "./domain/errors.js";
import type { AgentOwnershipLostError } from "./domain/agent-ownership.js";
import { newResourceId } from "./domain/resource-id.js";
import type { RuntimeConnectionAuthority } from "./ports/runtime-connections.js";
import type { TelemetryPort } from "./ports/telemetry.js";
import { tracedFetch } from "./telemetry/http.js";
import {
  InstrumentedAcpApplication,
  InstrumentedRunExecutor,
  InstrumentedToolCatalog,
  InstrumentedRuntimeInformation,
} from "./telemetry/instrumented-ports.js";
import { InstrumentedToolPermissions } from "./telemetry/instrumented-permissions.js";

export function buildAgentComponents(input: {
  config: AgentAcpConfig;
  repositories: ReturnType<typeof createLegacyAgentRepositories>;
  learningRepositories: ReturnType<typeof createLegacyLearningRepositories> | undefined;
  kernel: PostgresKernel;
  directory: ExecutionDirectory;
  providers: ProviderClients;
  permissionConnections: PermissionConnections;
  access: AccessService;
  runtimeConnections: RuntimeConnectionAuthority;
  telemetry: TelemetryPort;
  ownershipSignal: AbortSignal;
  recoveryRequired: (error: Error) => void;
  ownershipLost?: (error: AgentOwnershipLostError) => void;
  retainModelRequest?: (original: Promise<unknown>) => void;
  beforeTemporaryCleanup?: (
    scope: { organizationId: string; agentId: string },
    signal: AbortSignal,
  ) => Promise<void>;
  now: () => Date;
}) {
  const {
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
  } = input;
  const {
    sessions,
    sessionConfiguration,
    permissions: permissionRepository,
    temporarySkills: temporaryStore,
    runs,
    events,
    executions,
    contexts,
  } = input.repositories;
  const learningGate: LearningForegroundGate = new LearningForegroundGate(
    (scope) => supervisor.occupancy({ ...scope, principalId: "" }).busy,
  );
  const signing = config.skillMaintenanceSigning;
  const signer =
    signing === undefined
      ? undefined
      : new RuntimeSkillMaintenanceSigner(signing.kid, signing.privateKey);
  // Cleanup survives configuration disabling discovery; persisted scopes remain authoritative.
  const temporarySkills = new TemporarySkills(
    temporaryStore,
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
  const permissions = new InstrumentedToolPermissions(
    new ToolPermissions(permissionRepository, permissionConnections, access),
    telemetry,
  );
  const recovery = new RunRecovery({
    executions,
    runs,
    events,
    telemetry,
    now,
  });
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
    recovery,
    id: newResourceId,
    now,
  });
  const supervisor: RunSupervisor = new RunSupervisor(
    new InstrumentedRunExecutor(executor, telemetry),
    async (binding, signal) => {
      await access.assert(binding);
      await learningGate.preempt(binding, signal);
      try {
        await input.beforeTemporaryCleanup?.(binding, signal);
        await temporarySkills.releaseAgent(binding, signal);
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
        repository: sessionConfiguration,
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
        ...(input.ownershipLost === undefined ? {} : { ownershipLost: input.ownershipLost }),
        id: newResourceId,
        now,
      }),
      runs: supervisor,
    }),
    telemetry,
  );
  const learningWorker = buildLearningWorker({
    ...(input.retainModelRequest === undefined
      ? {}
      : { retainModelRequest: input.retainModelRequest }),
    config,
    kernel,
    learningRepositories: input.learningRepositories,
    directory,
    providers,
    rawTools,
    gate: learningGate,
    telemetry,
    temporarySkills,
    runtimeConnections,
  });
  return {
    application,
    recovery,
    supervisor,
    learningGate,
    learningWorker,
    rawTools,
    temporarySkills,
    temporarySkillCleanupWorker,
    sessionService,
  };
}
