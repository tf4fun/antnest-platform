import type { Agent } from "./types";

export type AgentConfigurationSummary = {
  template: string;
  model: string;
  modelRevision: string;
  limits: string;
  executionPolicy: string;
  runtimeImage: string;
};

export function agentConfigurationSummary(
  agent: Agent,
): AgentConfigurationSummary | undefined {
  const configuration = agent.configuration;
  if (!configuration) return undefined;

  return {
    template: `${configuration.template.name} · revision ${configuration.template.revision}`,
    model: `${configuration.model_profile.name} · ${configuration.model_profile.model.model}`,
    modelRevision: `revision ${configuration.model_profile.revision}`,
    limits: `${configuration.model_profile.model.context_window.toLocaleString("en-US")} context · ${configuration.model_profile.model.max_output_tokens.toLocaleString("en-US")} max output`,
    executionPolicy: `${configuration.max_model_requests.toLocaleString("en-US")} model requests · ${configuration.context_policy_version}`,
    runtimeImage: configuration.runtime.image_ref,
  };
}

export function agentConfigurationLinks(agent: Agent): { template: string; model: string } | undefined {
  const configuration = agent.configuration;
  if (!configuration) return undefined;
  return {
    template: `#templates/${encodeURIComponent(configuration.template.template_id)}/revisions/${configuration.template.revision}`,
    model: `#models/${encodeURIComponent(configuration.model_profile.model_profile_id)}/revisions/${encodeURIComponent(configuration.model_profile.revision_id)}`,
  };
}
