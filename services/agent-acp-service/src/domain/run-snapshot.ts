import { createHash } from "node:crypto";
import {
  resolveExecutionConfiguration,
  type ExecutionIdentity,
  type PublicExecutionConfiguration,
} from "./execution-configuration.js";
import type { SessionConfiguration } from "./session-configuration.js";
import type { AgentExecutionSpec, ModelCandidate, RunExecutionSnapshot } from "./types.js";

export function runSnapshot(input: {
  configuration: PublicExecutionConfiguration;
  identity: ExecutionIdentity;
  overrides: SessionConfiguration;
  accessRevision: string;
  clientMcpRevisionId: string;
  deadlineAt: Date;
}): RunExecutionSnapshot {
  const selected = resolveExecutionConfiguration(
    input.configuration,
    input.identity,
    input.overrides,
  );
  const authorization = {
    modelProfileId: selected.modelProfileId,
    authorization: selected.authorization,
    authorizationRevision: selected.authorizationRevision,
  };
  const executionSpec: AgentExecutionSpec = {
    configuration: { ...authorization, digest: digest(authorization) },
    model: selected.model,
    systemPrompt: selected.systemPrompt,
    contextPolicyVersion: selected.contextPolicyVersion,
    skillInstructions: selected.skillInstructions,
    maxModelRequests: selected.maxModelRequests,
    ...(selected.runBudget === undefined ? {} : { runBudget: { ...selected.runBudget } }),
    ...(selected.modelRetry === undefined ? {} : { modelRetry: { ...selected.modelRetry } }),
    ...(selected.modelFailover === undefined
      ? {}
      : {
          modelFailover: selected.modelFailover,
          fallbackModels: structuredClone(selected.fallbackModels ?? []),
        }),
    ...(selected.compactionModel === undefined
      ? {}
      : { compactionModel: structuredClone(selected.compactionModel) }),
  };
  return {
    organizationId: selected.organizationId,
    providerConnectionId: selected.providerConnectionId,
    modelProfileId: selected.modelProfileId,
    ...(selected.modelProfileRevision === undefined
      ? {}
      : { modelProfileRevision: selected.modelProfileRevision }),
    configurationRevision: selected.revision,
    accessRevision: input.accessRevision,
    deadlineAt: new Date(input.deadlineAt),
    agentSpecRevision: selected.agentSpecRevision,
    executionRevision: selected.executionRevision,
    runtimeMcpSourceDigest: digest(selected.runtime),
    agentExecutionSpecDigest: digest(executionSpec),
    runtime: selected.runtime,
    executionSpec,
    clientMcpRevisionId: input.clientMcpRevisionId,
  };
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function snapshotWithModelCandidate(
  snapshot: RunExecutionSnapshot,
  candidate: ModelCandidate,
): RunExecutionSnapshot {
  const { modelProfileRevision: _primaryRevision, ...base } = snapshot;
  void _primaryRevision;
  return {
    ...base,
    modelProfileId: candidate.modelProfileId,
    providerConnectionId: candidate.providerConnectionId,
    ...(candidate.modelProfileRevision === undefined
      ? {}
      : { modelProfileRevision: candidate.modelProfileRevision }),
    executionSpec: { ...base.executionSpec, model: candidate.model },
  };
}
