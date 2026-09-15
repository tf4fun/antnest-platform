import type { DiscoveredModel, ModelCatalogEntry } from "./types.ts";

export function enrichDiscoveredModels(
  remote: DiscoveredModel[],
  presets: ModelCatalogEntry[],
  saved: ModelCatalogEntry[] = [],
): ModelCatalogEntry[] {
  const defaults = new Map(presets.map((model) => [model.model_id, model]));
  const result = new Map<string, ModelCatalogEntry>();
  for (const model of remote) {
    if (result.has(model.model_id)) continue;
    const preset = defaults.get(model.model_id);
    result.set(model.model_id, {
      ...preset,
      ...model,
      context_window: model.context_window ?? preset?.context_window ?? 0,
      max_output_tokens:
        model.max_output_tokens ?? preset?.max_output_tokens ?? 0,
      supports_images:
        model.supports_images ?? preset?.supports_images ?? false,
    });
  }
  for (const preset of presets) {
    if (!result.has(preset.model_id))
      result.set(preset.model_id, { ...preset });
  }
  for (const model of saved) result.set(model.model_id, { ...model });
  return [...result.values()];
}
