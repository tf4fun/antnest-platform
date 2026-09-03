import type {
  ModelCatalog,
  ModelProfile,
  ModelProviderPreset,
  ModelSpec,
} from "./types.ts";

export type ModelSelection = {
  providerKey: string;
  modelID: string;
};

export type ModelSelectionDraft = ModelSelection & {
  baseURL: string;
  contextWindow: number;
  maxOutputTokens: number;
  supportsImages: boolean;
};

export type ModelCatalogGate = {
  changeAllowed: boolean;
  message?: string;
};

export function modelCatalogGate(status: "loading" | "ready" | "error"): ModelCatalogGate {
  if (status === "loading") {
    return { changeAllowed: false, message: "Loading model catalog." };
  }
  if (status === "error") {
    return {
      changeAllowed: false,
      message: "Model catalog is unavailable. Retry before changing model configuration.",
    };
  }
  return { changeAllowed: true };
}

export function modelProfileLabel(
  catalog: ModelCatalog | undefined,
  profile: ModelProfile,
): string {
  if (!catalog) return profile.display_name;
  const selection = matchModelSelection(catalog, profile.model);
  return catalog.providers.find(
    (provider) => provider.provider_key === selection.providerKey,
  )?.display_name ?? profile.display_name;
}

export function initialModelSelection(catalog: ModelCatalog): ModelSelection {
  const provider = catalog.providers.find((candidate) => !candidate.custom && candidate.models.length > 0)
    ?? catalog.providers[0];
  return {
    providerKey: provider?.provider_key ?? "",
    modelID: provider?.models[0]?.model_id ?? "",
  };
}

export function matchModelSelection(catalog: ModelCatalog, model: ModelSpec): ModelSelection {
  for (const provider of catalog.providers) {
    if (provider.custom || !sameProviderEndpoint(provider, model.base_url)) continue;
    if (provider.models.some((candidate) => candidate.model_id === model.model)) {
      return { providerKey: provider.provider_key, modelID: model.model };
    }
  }
  const custom = catalog.providers.find((provider) => provider.custom);
  return { providerKey: custom?.provider_key ?? "", modelID: model.model };
}

export function resolveModelSelection(
  catalog: ModelCatalog,
  draft: ModelSelectionDraft,
): { displayName: string; model: ModelSpec } {
  const provider = catalog.providers.find((candidate) => candidate.provider_key === draft.providerKey);
  if (!provider) throw new Error("Select a model provider.");

  if (!provider.custom) {
    const model = provider.models.find((candidate) => candidate.model_id === draft.modelID);
    if (!model) throw new Error("Select a model.");
    return {
      displayName: `${provider.display_name} · ${model.display_name}`,
      model: {
        base_url: provider.base_url,
        model: model.model_id,
        context_window: model.context_window,
        max_output_tokens: model.max_output_tokens,
        supports_images: model.supports_images,
      },
    };
  }

  const baseURL = normalizedURL(draft.baseURL);
  const modelID = draft.modelID.trim();
  if (!modelID) throw new Error("Enter the model ID accepted by the custom API.");
  if (!Number.isSafeInteger(draft.contextWindow) || draft.contextWindow < 1024) {
    throw new Error("Context window must be at least 1,024 tokens.");
  }
  if (!Number.isSafeInteger(draft.maxOutputTokens) || draft.maxOutputTokens < 1) {
    throw new Error("Maximum output must be a positive token count.");
  }
  return {
    displayName: `${endpointLabel(baseURL)} · ${modelID}`,
    model: {
      base_url: baseURL,
      model: modelID,
      context_window: draft.contextWindow,
      max_output_tokens: draft.maxOutputTokens,
      supports_images: draft.supportsImages,
    },
  };
}

function sameProviderEndpoint(provider: ModelProviderPreset, candidate: string): boolean {
  const normalized = candidate.trim().replace(/\/+$/u, "");
  if (normalized === provider.base_url) return true;
  return provider.provider_key === "deepseek" && normalized === `${provider.base_url}/v1`;
}

function normalizedURL(value: string): string {
  const trimmed = value.trim().replace(/\/+$/u, "");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("Enter a valid HTTP API endpoint.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Enter an HTTP API endpoint without credentials, query, or fragment.");
  }
  return trimmed;
}

function endpointLabel(baseURL: string): string {
  try {
    return new URL(baseURL).hostname;
  } catch {
    return "Custom API";
  }
}
