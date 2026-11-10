import {
  DEPRECATED_ALIASES,
  RESTRICTED_METRIC_ATTRIBUTES,
} from "./semconv.gen.ts";

const ALIASES = new Map<string, string>(Object.entries(DEPRECATED_ALIASES));

function legacyAliasesEnabled(): boolean {
  const raw = process.env.ANTNEST_TELEMETRY_LEGACY_ATTRIBUTES;
  return raw === undefined || raw.trim().toLowerCase() !== "false";
}

export function normalizeAttributes<T>(attributes: Record<string, T>): Record<string, T> {
  const canonical = new Map<string, T>();
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || ALIASES.has(key)) continue;
    canonical.set(key, value);
  }
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined) continue;
    const target = ALIASES.get(key);
    if (target !== undefined && !canonical.has(target)) canonical.set(target, value);
  }
  const emitted = new Map<string, T>(canonical);
  if (legacyAliasesEnabled()) {
    for (const [alias, target] of ALIASES) {
      const value = canonical.get(target);
      if (value !== undefined) emitted.set(alias, value);
    }
  }
  return Object.fromEntries(emitted);
}

export function metricAttributes<T>(attributes: Record<string, T>): Record<string, T> {
  const normalized = normalizeAttributes(attributes);
  const filtered = new Map<string, T>();
  for (const [key, value] of Object.entries(normalized)) {
    if (RESTRICTED_METRIC_ATTRIBUTES.has(ALIASES.get(key) ?? key)) continue;
    filtered.set(key, value);
  }
  return Object.fromEntries(filtered);
}
