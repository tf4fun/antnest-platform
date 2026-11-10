import { DEPRECATED_ALIASES, RESTRICTED_METRIC_ATTRIBUTES, SEMCONV } from "./semconv.gen.js";

const SHORT_ALIASES: Record<string, string> = {
  "request.id": SEMCONV.ANTNEST_REQUEST_ID,
  "agent.id": SEMCONV.ANTNEST_AGENT_ID,
  "run.id": SEMCONV.ANTNEST_RUN_ID,
  "session.id": SEMCONV.ANTNEST_SESSION_ID,
  "admission.id": SEMCONV.ANTNEST_ADMISSION_ID,
  "execution.revision": SEMCONV.ANTNEST_EXECUTION_REVISION,
};

const ALIASES = new Map<string, string>(
  Object.entries({ ...DEPRECATED_ALIASES, ...SHORT_ALIASES }),
);

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
  return Object.fromEntries(
    Object.entries(normalizeAttributes(attributes)).filter(
      ([key]) => !RESTRICTED_METRIC_ATTRIBUTES.has(ALIASES.get(key) ?? key),
    ),
  );
}
