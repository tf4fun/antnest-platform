import { isDeepStrictEqual } from "node:util";

import type { ExecutionIdentity } from "../domain/execution-configuration.js";
import type { LearningTaskClaim } from "../domain/learning-scan.js";
import { thinkingEfforts } from "../domain/model-thinking.js";
import type { ModelSpec, RunExecutionSnapshot } from "../domain/types.js";

type CurrentModel = {
  model_profile_id: string;
  connection_id: string;
  enabled: boolean;
  model: string;
  context_window: number;
  max_output_tokens: number;
  temperature?: number | undefined;
  supports_images: boolean;
  supports_audio?: boolean | undefined;
  supports_pdf?: boolean | undefined;
  pricing?:
    | {
        currency: "USD";
        input_per_million: number;
        output_per_million: number;
        cache_read_per_million?: number | undefined;
        cache_write_per_million?: number | undefined;
      }
    | undefined;
};

type CurrentProvider = {
  connection_id: string;
  enabled: boolean;
  provider_key: string;
  base_url: string;
};

type LearningDirectory = {
  inspect(identity: ExecutionIdentity): {
    agent: { agent_id: string; accepting_runs: boolean };
    configuration: {
      organization_id: string;
      models: CurrentModel[];
      providers: CurrentProvider[];
    };
  };
};

export class LearningModelAuthority {
  public constructor(private readonly directory: LearningDirectory) {}

  public assertCurrent(claim: LearningTaskClaim, snapshot: RunExecutionSnapshot): void {
    if (snapshot.organizationId !== claim.organizationId)
      throw new Error("Learning model source organization is invalid");
    const { agent, configuration } = this.directory.inspect({
      organizationId: claim.organizationId,
      agentId: claim.agentId,
      principalId: claim.ownerId,
    });
    if (
      configuration.organization_id !== claim.organizationId ||
      agent.agent_id !== claim.agentId ||
      !agent.accepting_runs
    )
      throw new Error("Learning Agent is not currently admitted");
    const model = configuration.models.find(
      (item) => item.model_profile_id === snapshot.modelProfileId,
    );
    const provider = configuration.providers.find(
      (item) => item.connection_id === snapshot.providerConnectionId,
    );
    if (
      model === undefined ||
      provider === undefined ||
      !model.enabled ||
      !provider.enabled ||
      model.connection_id !== provider.connection_id ||
      !isDeepStrictEqual(snapshot.executionSpec.model, currentModelSpec(model, provider, snapshot))
    )
      throw new Error("Learning model or Provider authorization changed");
  }
}

function currentModelSpec(
  model: CurrentModel,
  provider: CurrentProvider,
  snapshot: RunExecutionSnapshot,
): ModelSpec {
  const selectedThinking = snapshot.executionSpec.model.thinking;
  if (
    selectedThinking !== undefined &&
    !thinkingEfforts(provider.provider_key, model.model).includes(selectedThinking.effort)
  )
    throw new Error("Learning model thinking mode is no longer available");
  const price = model.pricing;
  return {
    baseUrl: provider.base_url,
    model: model.model,
    contextWindow: model.context_window,
    maxOutputTokens: model.max_output_tokens,
    supportsImages: model.supports_images,
    ...(model.temperature === undefined ? {} : { temperature: model.temperature }),
    ...(model.supports_audio === undefined ? {} : { supportsAudio: model.supports_audio }),
    ...(model.supports_pdf === undefined ? {} : { supportsPdf: model.supports_pdf }),
    ...(selectedThinking === undefined ? {} : { thinking: selectedThinking }),
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
