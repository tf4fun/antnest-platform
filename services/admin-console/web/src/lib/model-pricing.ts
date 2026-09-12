import { matchModelSelection } from "./model-catalog.ts";
import type { ModelCatalog, ModelPricing, ModelSpec } from "./types.ts";

export const modelRateFields = [
  { name: "input_per_million", label: "Input", required: true },
  { name: "output_per_million", label: "Output", required: true },
  { name: "cache_read_per_million", label: "Cache read", required: false },
  { name: "cache_write_per_million", label: "Cache write", required: false },
] as const;

export class ModelPriceError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.field = field;
  }
}

export function parseModelPricing(data: FormData): ModelPricing | undefined {
  if (data.get("pricing_enabled") !== "on") return undefined;
  const rates: Partial<Omit<ModelPricing, "currency">> = {};
  for (const field of modelRateFields) {
    const text = String(data.get(field.name) ?? "").trim();
    if (!text && !field.required) continue;
    const number = Number(text);
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(text) || !Number.isFinite(number) || number < 0) {
      throw new ModelPriceError(field.name, `${field.label} rate must be a nonnegative USD amount.`);
    }
    if (number === 0 && /[1-9]/u.test(text.split(/e/iu)[0]!)) {
      throw new ModelPriceError(field.name, `${field.label} rate is too small to represent.`);
    }
    rates[field.name] = number;
  }
  return { currency: "USD", input_per_million: rates.input_per_million!, output_per_million: rates.output_per_million!, ...rates };
}

export function pricingDraft(pricing?: ModelPricing): Record<typeof modelRateFields[number]["name"], string> {
  return {
    input_per_million: pricing?.input_per_million === undefined ? "" : String(pricing.input_per_million),
    output_per_million: pricing?.output_per_million === undefined ? "" : String(pricing.output_per_million),
    cache_read_per_million: pricing?.cache_read_per_million === undefined ? "" : String(pricing.cache_read_per_million),
    cache_write_per_million: pricing?.cache_write_per_million === undefined ? "" : String(pricing.cache_write_per_million),
  };
}

export function formatModelRate(rate?: number): string {
  if (rate === undefined) return "Not configured";
  return `$${rate !== 0 && (rate < 1e-6 || rate >= 1e9) ? rate.toExponential(6).replace(/\.?0+e/u, "e") : String(rate)}`;
}

type ModelIdentity = Pick<ModelSpec, "base_url" | "model">;

export function catalogModelPricing(catalog: ModelCatalog, model: ModelIdentity): ModelPricing | undefined {
  const selection = matchModelSelection(catalog, model);
  const provider = catalog.providers.find((entry) => entry.provider_key === selection.providerKey && !entry.custom);
  return provider?.models.find((entry) => entry.model_id === selection.modelID)?.pricing;
}

export function modelPricingIdentity(catalog: ModelCatalog, model: ModelIdentity): string {
  const selection = matchModelSelection(catalog, model);
  const provider = catalog.providers.find((entry) => entry.provider_key === selection.providerKey && !entry.custom);
  return JSON.stringify([provider?.base_url ?? model.base_url.trim().replace(/\/+$/u, ""), model.model.trim()]);
}
