export const MAX_SAFE_LIMIT = 9007199254740991;

export type ModelRetry = { max: number; base_ms: number; cap_ms: number };

export type RunBudget = {
  max_input_tokens?: number;
  max_output_tokens?: number;
  max_cost_usd_micros?: number;
};

export type PeriodCaps = {
  soft_cost_usd_micros?: number;
  hard_cost_usd_micros?: number;
};

export type TemplateModelPolicy = {
  model_retry?: ModelRetry;
  failover?: "never" | "before_output";
  run_budget?: RunBudget;
};

export type ModelCallPolicy = {
  revision: number;
  unknown_cost: "allow" | "deny";
  run_caps: RunBudget;
  daily: PeriodCaps;
  monthly: PeriodCaps;
};

export type ModelCallPolicyUpdate = Omit<ModelCallPolicy, "revision"> & {
  expected_revision: number;
  expected_principal: [string, string];
};

export const DEFAULT_MODEL_RETRY: ModelRetry = { max: 2, base_ms: 200, cap_ms: 30000 };

const MICROS_PER_USD = 1000000n;
const DECIMAL_PATTERN = /^(?:\d+(?:\.\d{1,6})?|\.\d{1,6})$/;
const TOKEN_PATTERN = /^\d+$/;

// Exact decimal conversion: an empty field means unlimited; any malformed,
// signed, exponent, over-precise or overflowing value returns undefined so the
// caller can flag the field instead of silently widening a cap.
export function usdToMicros(text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed === "" || !DECIMAL_PATTERN.test(trimmed)) return undefined;
  const [integer = "", fraction = ""] = trimmed.split(".");
  const micros = BigInt(integer) * MICROS_PER_USD + BigInt(fraction.padEnd(6, "0") || "0");
  return micros <= BigInt(MAX_SAFE_LIMIT) ? Number(micros) : undefined;
}

// Integer quotient/remainder formatting only; never re-parses a float.
export function microsToUSD(micros?: number): string {
  if (micros === undefined || !Number.isSafeInteger(micros) || micros < 0 || micros > MAX_SAFE_LIMIT) return "";
  const value = BigInt(micros);
  const fraction = (value % MICROS_PER_USD).toString().padStart(6, "0").replace(/0+$/, "");
  const whole = (value / MICROS_PER_USD).toString();
  return fraction === "" ? whole : `${whole}.${fraction}`;
}

export function tokenLimit(text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed === "" || !TOKEN_PATTERN.test(trimmed)) return undefined;
  const value = BigInt(trimmed);
  return value <= BigInt(MAX_SAFE_LIMIT) ? Number(value) : undefined;
}

function defined<T extends object>(members: [string, number | undefined][]): T {
  const result: Record<string, number> = {};
  for (const [name, value] of members) if (value !== undefined) result[name] = value;
  return result as T;
}

// Blank fields are "unlimited" and omit; any nonblank value that fails exact
// parsing is an operator error and must never silently widen a cap.
function requiredValue(text: string, label: string, parse: (value: string) => number | undefined): number | undefined {
  if (text.trim() === "") return undefined;
  const value = parse(text);
  if (value === undefined) throw new Error(`Enter a valid ${label} or leave it blank.`);
  return value;
}

export function runBudgetInput(data: FormData, prefix = "run_"): RunBudget {
  return defined<RunBudget>([
    ["max_input_tokens", requiredValue(String(data.get(`${prefix}max_input_tokens`) ?? ""), "input token limit", tokenLimit)],
    ["max_output_tokens", requiredValue(String(data.get(`${prefix}max_output_tokens`) ?? ""), "output token limit", tokenLimit)],
    ["max_cost_usd_micros", requiredValue(String(data.get(`${prefix}max_cost_usd`) ?? ""), "cost limit in USD", usdToMicros)],
  ]);
}

// run_budget is included only when the operator supplied at least one limit;
// an empty object and an omitted field are the same policy.
export function templateModelPolicyInput(data: FormData): TemplateModelPolicy {
  const policy: TemplateModelPolicy = {};
  if (data.get("retry_mode") === "custom") {
    const retry: ModelRetry = {
      max: requiredValue(String(data.get("retry_max") ?? ""), "retry count", tokenLimit) ?? Number.NaN,
      base_ms: requiredValue(String(data.get("retry_base_ms") ?? ""), "retry base delay in ms", tokenLimit) ?? Number.NaN,
      cap_ms: requiredValue(String(data.get("retry_cap_ms") ?? ""), "retry delay cap in ms", tokenLimit) ?? Number.NaN,
    };
    if (!(retry.max >= 0 && retry.max <= 8 && retry.base_ms >= 1 && retry.cap_ms >= retry.base_ms && retry.cap_ms <= 30000)) {
      throw new Error("Custom retry needs a count of 0–8, a base delay of 1–30000 ms and a delay cap at least the base and at most 30000 ms.");
    }
    policy.model_retry = retry;
  }
  const failover = String(data.get("failover") ?? "");
  if (failover === "never" || failover === "before_output") policy.failover = failover;
  else if (failover !== "" && failover !== "default") throw new Error("Choose a valid failover policy.");
  const budget = runBudgetInput(data);
  if (Object.keys(budget).length !== 0) policy.run_budget = budget;
  return policy;
}

function safeMember(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_SAFE_LIMIT;
}

function capObject(value: unknown, members: string[], label: string): Record<string, number> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const result: Record<string, number> = {};
  for (const key of Object.keys(record)) {
    if (!members.includes(key)) throw new Error(`unknown ${label} member ${key}`);
    const member = record[key];
    if (!safeMember(member)) throw new Error(`invalid ${label} member ${key}`);
    result[key] = member;
  }
  return result;
}

// The browser projection is exactly five contracted members: no organization
// and no extra Controller fields.
export function decodeModelCallPolicy(body: unknown): ModelCallPolicy {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("model call policy is not an object");
  }
  const record = body as Record<string, unknown>;
  const names = ["revision", "unknown_cost", "run_caps", "daily", "monthly"];
  for (const key of Object.keys(record)) {
    if (!names.includes(key)) throw new Error(`unexpected policy member ${key}`);
  }
  for (const name of names) {
    if (record[name] === undefined || record[name] === null) throw new Error(`missing policy member ${name}`);
  }
  const revision = record.revision;
  const unknownCost = record.unknown_cost;
  if (!safeMember(revision)) throw new Error("invalid policy revision");
  if (unknownCost !== "allow" && unknownCost !== "deny") throw new Error("invalid policy unknown_cost");
  const policy: ModelCallPolicy = {
    revision,
    unknown_cost: unknownCost,
    run_caps: capObject(record.run_caps, ["max_input_tokens", "max_output_tokens", "max_cost_usd_micros"], "run budget"),
    daily: capObject(record.daily, ["soft_cost_usd_micros", "hard_cost_usd_micros"], "daily caps"),
    monthly: capObject(record.monthly, ["soft_cost_usd_micros", "hard_cost_usd_micros"], "monthly caps"),
  };
  for (const caps of [policy.daily, policy.monthly]) {
    if (caps.soft_cost_usd_micros !== undefined && caps.hard_cost_usd_micros !== undefined &&
      caps.soft_cost_usd_micros > caps.hard_cost_usd_micros) {
      throw new Error("soft cap exceeds hard cap");
    }
  }
  if (policy.revision === 0 && (policy.unknown_cost !== "allow" ||
    Object.keys(policy.run_caps).length !== 0 || Object.keys(policy.daily).length !== 0 ||
    Object.keys(policy.monthly).length !== 0)) {
    throw new Error("default policy carries configured values");
  }
  return policy;
}

// The acknowledged replacement must echo the exact submitted intent, not just
// the incremented revision.
export function sameModelCallPolicyIntent(policy: ModelCallPolicy, input: ModelCallPolicyUpdate): boolean {
  const equal = (left: object, right: object, names: string[]) =>
    names.every((name) =>
      (left as Record<string, number | undefined>)[name] === (right as Record<string, number | undefined>)[name]);
  return policy.unknown_cost === input.unknown_cost &&
    equal(policy.run_caps, input.run_caps, ["max_input_tokens", "max_output_tokens", "max_cost_usd_micros"]) &&
    equal(policy.daily, input.daily, ["soft_cost_usd_micros", "hard_cost_usd_micros"]) &&
    equal(policy.monthly, input.monthly, ["soft_cost_usd_micros", "hard_cost_usd_micros"]);
}
