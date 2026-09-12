import type {
  ModelCatalog,
  ModelCatalogEntry,
  ModelParameters,
  ModelProfile,
  ModelProviderPreset,
  ModelSpec,
} from "./types.ts";

export type ModelSelection = {
  providerKey: string;
  modelID: string;
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

export function matchModelSelection(catalog: ModelCatalog, model: Pick<ModelSpec, "base_url" | "model">): ModelSelection {
  for (const provider of catalog.providers) {
    if (provider.custom || !sameProviderEndpoint(provider, model.base_url)) continue;
    return { providerKey: provider.provider_key, modelID: model.model };
  }
  const custom = catalog.providers.find((provider) => provider.custom);
  return { providerKey: custom?.provider_key ?? "", modelID: model.model };
}

export function presetParameters(entry: ModelCatalogEntry): ModelParameters {
  const { model_id, display_name: _name, ...parameters } = entry;
  return { ...parameters, ...(entry.pricing ? { pricing: { ...entry.pricing } } : {}), model: model_id };
}

export function savedParameters(model: ModelSpec): ModelParameters {
  const { base_url: _endpoint, ...parameters } = model;
  return { ...parameters, ...(model.pricing ? { pricing: { ...model.pricing } } : {}) };
}

export function validateModelParameters(model: ModelParameters): ModelParameters {
  if (!model.model.trim()) throw new Error("Enter the model ID accepted by the API.");
  if (!Number.isSafeInteger(model.context_window) || model.context_window < 1024) {
    throw new Error("Context window must be at least 1,024 tokens.");
  }
  if (!Number.isSafeInteger(model.max_output_tokens) || model.max_output_tokens < 1) {
    throw new Error("Maximum output must be a positive token count.");
  }
  return { ...model, model: model.model.trim() };
}

export function modelInputLabel(model: Pick<ModelSpec, "supports_images" | "supports_audio" | "supports_pdf">): string {
  const formats = ["Text"];
  if (model.supports_images) formats.push("Images");
  if (model.supports_audio) formats.push("Audio");
  if (model.supports_pdf) formats.push("PDF");
  return formats.join(", ");
}

function sameProviderEndpoint(provider: ModelProviderPreset, candidate: string): boolean {
  const normalized = candidate.trim().replace(/\/+$/u, "");
  if (normalized === provider.base_url) return true;
  return provider.provider_key === "deepseek" && normalized === `${provider.base_url}/v1`;
}
