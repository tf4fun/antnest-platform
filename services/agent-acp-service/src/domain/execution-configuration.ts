import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { DomainError } from "./errors.js";
import {
  authorizationModeSchema,
  sessionConfigurationSchema,
  selectSessionModel,
  type Authorization,
  type ConfigurationCatalog,
  type SessionModel,
  type SessionConfiguration,
} from "./session-configuration.js";
import type { ModelSpec, RuntimeBinding } from "./types.js";
import { resolveThinking, thinkingEfforts } from "./model-thinking.js";

const identifier = z.string().min(1).max(200);
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const endpoint = z.url().refine((value) => {
  const url = new URL(value);
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.username === "" &&
    url.password === "" &&
    url.hash === ""
  );
}, "Expected an HTTP endpoint without embedded credentials or fragment");

const providerFields = {
  connection_id: identifier,
  provider_key: z.enum(["deepseek", "openrouter"]),
  request_protocol: z.literal("openai_chat_completions"),
  base_url: endpoint,
};

const credentialFields = {
  credential_revision: identifier,
  credential: z.strictObject({ method: z.literal("api_key"), secret: z.string().min(1) }),
};

export const providerConfigurationSchema = z.union([
  z.strictObject({
    ...providerFields,
    enabled: z.literal(true),
    ...credentialFields,
  }),
  z.strictObject({ ...providerFields, enabled: z.literal(false), ...credentialFields }),
  z.strictObject({ ...providerFields, enabled: z.literal(false) }),
]);

const pricingSchema = z.strictObject({
  currency: z.literal("USD"),
  input_per_million: z.number().nonnegative(),
  output_per_million: z.number().nonnegative(),
  cache_read_per_million: z.number().nonnegative().optional(),
  cache_write_per_million: z.number().nonnegative().optional(),
});

export const executionModelSchema = z.strictObject({
  model_profile_id: identifier,
  connection_id: identifier,
  display_name: z.string().min(1).max(200),
  enabled: z.boolean(),
  model: z.string().min(1).max(200),
  context_window: revision,
  max_output_tokens: revision,
  temperature: z.number().min(0).max(2).optional(),
  supports_images: z.boolean(),
  supports_audio: z.boolean().optional(),
  supports_pdf: z.boolean().optional(),
  pricing: pricingSchema.optional(),
});

const toolRuleSchema = z.strictObject({
  source: z.enum(["runtime", "agent"]),
  source_id: identifier,
  tool_name: identifier,
  decision: z.enum(["allow", "deny"]),
});

export const agentConfigurationSchema = z.strictObject({
  agent_id: identifier,
  principal_ids: z.array(identifier),
  access_revision: identifier,
  accepting_runs: z.boolean(),
  unavailable_reason: z.string().min(1).max(200).nullable(),
  operation_id: identifier.nullable(),
  default_model_profile_id: identifier,
  fallback_model_profile_ids: z.array(identifier).max(31).optional(),
  default_authorization: z.strictObject({
    mode: authorizationModeSchema,
    tool_rules: z.array(toolRuleSchema).max(128),
  }),
  authorization_revision: revision,
  agent_spec_revision: identifier.nullable(),
  execution_revision: identifier.nullable(),
  system_prompt: z.string(),
  context_policy_version: z.literal("context-v1"),
  skill_instructions: z.array(
    z.strictObject({
      skill_key: identifier,
      version: identifier,
      instructions: z.string(),
    }),
  ),
  max_model_requests: revision,
  runtime: z
    .strictObject({
      runtime_revision: identifier,
      runtime_execution_id: identifier,
      mcp_endpoint: endpoint,
    })
    .nullable(),
});

export const executionConfigurationSchema = z.strictObject({
  organization_id: identifier,
  revision,
  providers: z.array(providerConfigurationSchema),
  models: z.array(executionModelSchema),
  agents: z.array(agentConfigurationSchema),
});

export type ProviderConfiguration = z.infer<typeof providerConfigurationSchema>;
export type ExecutionModel = z.infer<typeof executionModelSchema>;
export type AgentConfiguration = z.infer<typeof agentConfigurationSchema>;
export type ExecutionConfiguration = z.infer<typeof executionConfigurationSchema>;
export const publicProviderConfigurationSchema = z.discriminatedUnion("enabled", [
  z.strictObject({ ...providerFields, enabled: z.literal(true), credential_revision: identifier }),
  z.strictObject({
    ...providerFields,
    enabled: z.literal(false),
    credential_revision: identifier.optional(),
  }),
]);
export const publicExecutionConfigurationSchema = executionConfigurationSchema.extend({
  providers: z.array(publicProviderConfigurationSchema),
});
export type PublicProviderConfiguration = z.infer<typeof publicProviderConfigurationSchema>;
export type ProviderRouting = Pick<
  ProviderConfiguration,
  "provider_key" | "request_protocol" | "base_url"
>;

export function providerRouting(provider: ProviderRouting): ProviderRouting {
  const { provider_key, request_protocol, base_url } = provider;
  return { provider_key, request_protocol, base_url };
}

export function requireSameProviderRouting(previous: ProviderRouting, next: ProviderRouting): void {
  if (!isDeepStrictEqual(providerRouting(previous), providerRouting(next))) {
    throw new DomainError("configuration_conflict", "Provider connection routing cannot change");
  }
}

export type PublicExecutionConfiguration = z.infer<typeof publicExecutionConfigurationSchema>;
export type ExecutionIdentity = {
  organizationId: string;
  principalId: string;
  agentId: string;
};

export type ExecutionAccessSnapshot = {
  organization_id: string;
  agents: Pick<AgentConfiguration, "agent_id" | "principal_ids">[];
};

export function isExecutionAccessRevoked(
  snapshot: ExecutionAccessSnapshot,
  identity: ExecutionIdentity,
): boolean {
  return (
    snapshot.organization_id === identity.organizationId &&
    !snapshot.agents.some(
      (agent) =>
        agent.agent_id === identity.agentId && agent.principal_ids.includes(identity.principalId),
    )
  );
}

export function parseExecutionConfiguration(input: unknown): ExecutionConfiguration {
  const parsed = executionConfigurationSchema.safeParse(input);
  if (!parsed.success) {
    throw new DomainError("invalid_execution_configuration", "Invalid execution configuration");
  }
  return validateConfiguration(parsed.data);
}

export function parsePublicExecutionConfiguration(input: unknown): PublicExecutionConfiguration {
  const parsed = publicExecutionConfigurationSchema.safeParse(input);
  if (!parsed.success) {
    throw new DomainError(
      "invalid_execution_configuration",
      "Invalid stored execution configuration",
    );
  }
  return validateConfiguration(parsed.data);
}

function validateConfiguration<T extends PublicExecutionConfiguration>(snapshot: T): T {
  const providers = indexUnique(snapshot.providers, (item) => item.connection_id);
  const models = indexUnique(snapshot.models, (item) => item.model_profile_id);
  indexUnique(snapshot.agents, (item) => item.agent_id);
  for (const model of snapshot.models) {
    requireReference(providers.has(model.connection_id));
  }
  for (const agent of snapshot.agents) {
    requireReference(models.has(agent.default_model_profile_id));
    const candidates = [
      agent.default_model_profile_id,
      ...(agent.fallback_model_profile_ids ?? []),
    ];
    const connections = candidates.map((id) => {
      const model = models.get(id);
      requireReference(model !== undefined);
      return model!.connection_id;
    });
    indexUnique(connections, (id) => id);
    validateAgent(agent);
  }
  return snapshot;
}

export function publicExecutionConfiguration(
  snapshot: ExecutionConfiguration,
): PublicExecutionConfiguration {
  const providers = snapshot.providers.map((provider) => {
    const publicFields = {
      connection_id: provider.connection_id,
      ...providerRouting(provider),
    };
    return provider.enabled
      ? {
          ...publicFields,
          enabled: true as const,
          credential_revision: provider.credential_revision,
        }
      : {
          ...publicFields,
          enabled: false as const,
          ...("credential_revision" in provider
            ? { credential_revision: provider.credential_revision }
            : {}),
        };
  });
  const configuration = structuredClone({ ...snapshot, providers });
  configuration.providers.sort((a, b) => compare(a.connection_id, b.connection_id));
  configuration.models.sort((a, b) => compare(a.model_profile_id, b.model_profile_id));
  configuration.agents.sort((a, b) => compare(a.agent_id, b.agent_id));
  for (const agent of configuration.agents) agent.principal_ids.sort(compare);
  return configuration;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : Number(a > b);
}

export function authorizeConfiguredAgent(
  snapshot: PublicExecutionConfiguration,
  identity: ExecutionIdentity,
): AgentConfiguration {
  const agent = snapshot.agents.find((candidate) => candidate.agent_id === identity.agentId);
  if (
    snapshot.organization_id !== identity.organizationId ||
    agent === undefined ||
    !agent.principal_ids.includes(identity.principalId)
  ) {
    throw new DomainError("access_denied", "Agent access is not allowed");
  }
  return agent;
}

export function resolveExecutionConfiguration(
  snapshot: PublicExecutionConfiguration,
  identity: ExecutionIdentity,
  overrides: SessionConfiguration,
) {
  const agent = authorizeConfiguredAgent(snapshot, identity);
  if (!agent.accepting_runs) {
    throw new DomainError("agent_unavailable", agent.unavailable_reason ?? "Agent is unavailable");
  }
  const selection = sessionConfigurationSchema.parse(overrides);
  const effective = selectSessionModel(selection, executionConfigurationCatalog(snapshot, agent));
  const model = snapshot.models.find(
    (candidate) => candidate.model_profile_id === effective?.modelProfileId,
  );
  const provider = snapshot.providers.find(
    (candidate) => candidate.connection_id === model?.connection_id,
  );
  if (model === undefined || !model.enabled || provider === undefined || !provider.enabled) {
    throw new DomainError("model_unavailable", "Selected model is unavailable");
  }
  if (
    agent.runtime === null ||
    agent.agent_spec_revision === null ||
    agent.execution_revision === null
  ) {
    throw new DomainError("agent_unavailable", "Agent execution configuration is not ready");
  }
  const fallback =
    model.model_profile_id !== (selection.modelProfileId ?? agent.default_model_profile_id);
  const effort =
    fallback && !effective?.thinkingEfforts?.includes(selection.thinkingEffort!)
      ? undefined
      : selection.thinkingEffort;
  const thinking = resolveThinking(provider.provider_key, model.model, effort);
  return {
    organizationId: snapshot.organization_id,
    agentId: agent.agent_id,
    revision: snapshot.revision,
    agentSpecRevision: agent.agent_spec_revision,
    executionRevision: agent.execution_revision,
    providerConnectionId: provider.connection_id,
    modelProfileId: model.model_profile_id,
    model: {
      ...modelSpec(model, provider.base_url),
      ...(thinking === undefined ? {} : { thinking }),
    },
    authorization: resolveAuthorization(agent, selection),
    authorizationRevision: agent.authorization_revision,
    runtime: {
      revision: agent.runtime.runtime_revision,
      executionId: agent.runtime.runtime_execution_id,
      mcpEndpoint: agent.runtime.mcp_endpoint,
    } satisfies RuntimeBinding,
    systemPrompt: agent.system_prompt,
    contextPolicyVersion: agent.context_policy_version,
    skillInstructions: agent.skill_instructions.map((skill) => ({
      skillKey: skill.skill_key,
      version: skill.version,
      instructions: skill.instructions,
    })),
    maxModelRequests: agent.max_model_requests,
  };
}

export type ResolvedExecutionConfiguration = ReturnType<typeof resolveExecutionConfiguration>;

export function executionConfigurationCatalog(
  snapshot: PublicExecutionConfiguration,
  agent: AgentConfiguration,
): ConfigurationCatalog {
  const enabled = new Set(
    snapshot.providers
      .filter((provider) => provider.enabled)
      .map((provider) => provider.connection_id),
  );
  const available = (model: ExecutionModel) => model.enabled && enabled.has(model.connection_id);
  const model = snapshot.models.find(
    (candidate) => candidate.model_profile_id === agent.default_model_profile_id,
  );
  if (model === undefined)
    throw new DomainError("invalid_execution_configuration", "Default model is missing");
  const describeModel = (model: ExecutionModel) =>
    sessionModel(
      model,
      snapshot.providers.find((provider) => provider.connection_id === model.connection_id)
        ?.provider_key ?? "",
    );
  return {
    models: snapshot.models.filter(available).map(describeModel),
    unavailableModelProfileIds: snapshot.models
      .filter((model) => !available(model))
      .map((model) => model.model_profile_id),
    fallbackModels: (agent.fallback_model_profile_ids ?? []).flatMap((id) => {
      const candidate = snapshot.models.find((item) => item.model_profile_id === id);
      return candidate !== undefined && available(candidate) ? [describeModel(candidate)] : [];
    }),
    defaultModel: { ...describeModel(model), available: available(model) },
    defaultAuthorization: resolveAuthorization(agent, {}),
    authorizationRevision: agent.authorization_revision,
  };
}

function sessionModel(model: ExecutionModel, provider: string): SessionModel {
  return {
    modelProfileId: model.model_profile_id,
    displayName: model.display_name,
    model: model.model,
    contextWindow: model.context_window,
    maxOutputTokens: model.max_output_tokens,
    supportsImages: model.supports_images,
    providerName:
      provider === "deepseek" ? "DeepSeek" : provider === "openrouter" ? "OpenRouter" : provider,
    thinkingEfforts: thinkingEfforts(provider, model.model),
  };
}

function validateAgent(agent: AgentConfiguration): void {
  indexUnique(agent.principal_ids, (id) => id);
  indexUnique(agent.default_authorization.tool_rules, (rule) =>
    JSON.stringify([rule.source, rule.source_id, rule.tool_name]),
  );
  indexUnique(agent.skill_instructions, (skill) => skill.skill_key);
  const ready =
    agent.runtime !== null &&
    agent.agent_spec_revision !== null &&
    agent.execution_revision !== null;
  if (agent.accepting_runs && (!ready || agent.unavailable_reason !== null)) {
    throw new DomainError(
      "invalid_execution_configuration",
      "Accepting Agent requires ready configuration",
    );
  }
}

function indexUnique<T>(items: T[], key: (item: T) => string): Map<string, T> {
  const indexed = new Map<string, T>();
  for (const item of items) {
    const id = key(item);
    if (indexed.has(id)) {
      throw new DomainError(
        "invalid_execution_configuration",
        "Duplicate execution configuration identifier",
      );
    }
    indexed.set(id, item);
  }
  return indexed;
}

function requireReference(present: boolean): void {
  if (!present) {
    throw new DomainError(
      "invalid_execution_configuration",
      "Dangling execution configuration reference",
    );
  }
}

function resolveAuthorization(
  agent: AgentConfiguration,
  overrides: SessionConfiguration,
): Authorization {
  const rules = agent.default_authorization.tool_rules.map((rule) => ({
    source: rule.source,
    sourceId: rule.source_id,
    toolName: rule.tool_name,
    decision: rule.decision,
  }));
  const key = (rule: Authorization["toolRules"][number]) =>
    JSON.stringify([rule.source, rule.sourceId, rule.toolName]);
  const merged = indexUnique(rules, key);
  const selected = indexUnique(overrides.toolRules ?? [], key);
  for (const [id, rule] of selected) merged.set(id, { ...rule });
  return {
    mode: overrides.authorizationMode ?? agent.default_authorization.mode,
    toolRules: [...merged.values()],
  };
}

function modelSpec(model: ExecutionModel, baseUrl: string): ModelSpec {
  const price = model.pricing;
  return {
    baseUrl,
    model: model.model,
    contextWindow: model.context_window,
    maxOutputTokens: model.max_output_tokens,
    supportsImages: model.supports_images,
    ...(model.temperature === undefined ? {} : { temperature: model.temperature }),
    ...(model.supports_audio === undefined ? {} : { supportsAudio: model.supports_audio }),
    ...(model.supports_pdf === undefined ? {} : { supportsPdf: model.supports_pdf }),
    ...(price === undefined
      ? {}
      : {
          pricing: {
            currency: price.currency,
            inputPerMillion: price.input_per_million,
            outputPerMillion: price.output_per_million,
            ...(price.cache_read_per_million === undefined
              ? {}
              : { cacheReadPerMillion: price.cache_read_per_million }),
            ...(price.cache_write_per_million === undefined
              ? {}
              : { cacheWritePerMillion: price.cache_write_per_million }),
          },
        }),
  };
}
