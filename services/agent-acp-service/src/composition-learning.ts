import type { createLegacyLearningRepositories } from "./adapters/postgres/learning-repositories.js";
import type { TemporarySkills } from "./application/temporary-skills.js";
import type { RuntimeConnectionAuthority } from "./ports/runtime-connections.js";
import type { ExecutionDirectory } from "./application/execution-directory.js";
import type { ProviderClients } from "./application/provider-clients.js";
import type { McpToolCatalog } from "./adapters/mcp/tool-catalog.js";
import type { PostgresKernel } from "./adapters/postgres/kernel.js";
import type { LearningForegroundGate } from "./application/learning-foreground-gate.js";
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
import { LearningTaskProcessor } from "./application/learning-task-processor.js";
import { ControllerLearningPolicyClient } from "./adapters/controller-learning-policy.js";
import { tracedFetch } from "./telemetry/http.js";
import { DirectoryLearningRuntimeBinding } from "./adapters/learning-runtime-binding.js";
import { RuntimeSkillMaintenanceSigner } from "./adapters/runtime-skill-maintenance-signer.js";
import { RuntimeSkillMaintenanceClient } from "./adapters/runtime-skill-maintenance-client.js";
import { PostgresLearningReviewSource } from "./adapters/postgres/learning-review-source.js";
import { PostgresLearningManagedSkills } from "./adapters/postgres/learning-managed-skills.js";
import { PostgresLearningInstallRequests } from "./adapters/postgres/learning-install-requests.js";
import type { AgentAcpConfig } from "./config.js";
import type { TelemetryPort } from "./ports/telemetry.js";

export type LearningPipelineInput = {
  config: AgentAcpConfig;
  learningRepositories: ReturnType<typeof createLegacyLearningRepositories> | undefined;
  kernel: PostgresKernel;
  directory: ExecutionDirectory;
  providers: ProviderClients;
  rawTools: McpToolCatalog;
  gate: LearningForegroundGate;
  telemetry: TelemetryPort;
  temporarySkills: TemporarySkills;
  runtimeConnections: RuntimeConnectionAuthority;
};

export function buildLearningWorker(input: LearningPipelineInput): LearningWorker | undefined {
  return buildLearningPipeline(input)?.worker;
}

export function buildLearningPipeline(
  input: LearningPipelineInput,
): { worker: LearningWorker; paused: LearningPausedRecovery } | undefined {
  const { config, kernel, directory, providers, rawTools, gate, telemetry } = input;
  if (
    config.skillLearningControllerUrl === undefined ||
    config.skillMaintenanceSigning === undefined
  )
    return undefined;
  if (input.learningRepositories === undefined)
    throw new Error("Learning repositories are required when Skill learning is enabled");
  const policy = new ControllerLearningPolicyClient(
    config.skillLearningControllerUrl,
    tracedFetch(config.dependencyFetchers.controller!, "agent_controller"),
  );
  const {
    scan: scanStore,
    evidence,
    budget,
    candidates,
    outcomes,
    intents,
    bases,
    changes,
  } = input.learningRepositories;
  const managed = new PostgresLearningManagedSkills(kernel);
  const installRequests = new PostgresLearningInstallRequests(kernel);
  const binding = new DirectoryLearningRuntimeBinding(directory);
  const signer = new RuntimeSkillMaintenanceSigner(
    config.skillMaintenanceSigning.kid,
    config.skillMaintenanceSigning.privateKey,
  );
  const runtime = new RuntimeSkillMaintenanceClient(signer, intents, input.runtimeConnections);
  const guard = new LearningMaintenanceGuard(gate, (scope, signal) =>
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
    installRequests,
    changes,
  );
  const processor = new InstrumentedLearningTaskProcessor(
    new LearningTaskProcessor(review, new InstrumentedLearningApply(apply, telemetry), outcomes),
    telemetry,
  );
  const paused = new LearningPausedRecovery(
    outcomes,
    guard,
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
  const worker = new LearningWorker(
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
  );
  return { worker, paused };
}
