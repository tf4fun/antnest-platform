import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decodeModelCallPolicy,
  microsToUSD,
  runBudgetInput,
  sameModelCallPolicyIntent,
  templateModelPolicyInput,
  tokenLimit,
  usdToMicros,
  MAX_SAFE_LIMIT,
} from "./model-call-policy.ts";

test("usdToMicros converts exact nonnegative decimals only", () => {
  assert.equal(usdToMicros(""), undefined);
  assert.equal(usdToMicros("   "), undefined);
  assert.equal(usdToMicros("0"), 0);
  assert.equal(usdToMicros("0.000001"), 1);
  assert.equal(usdToMicros(".5"), 500000);
  assert.equal(usdToMicros("00040.50"), 40500000);
  assert.equal(usdToMicros(" 12.25 "), 12250000);
  assert.equal(usdToMicros("9007199254.740991"), MAX_SAFE_LIMIT);
  for (const invalid of [
    "-1", "+1", "1e3", "1E3", "0.0000001", ".", "5.", "1.2.3", "abc",
    "9007199254.740992", "9007199255", " 1,000.00", "NaN", "Infinity", "1e-7",
  ]) {
    assert.equal(usdToMicros(invalid), undefined, invalid);
  }
});

test("microsToUSD formats by quotient and remainder only", () => {
  assert.equal(microsToUSD(undefined), "");
  assert.equal(microsToUSD(0), "0");
  assert.equal(microsToUSD(1), "0.000001");
  assert.equal(microsToUSD(500000), "0.5");
  assert.equal(microsToUSD(40500000), "40.5");
  assert.equal(microsToUSD(12250000), "12.25");
  assert.equal(microsToUSD(MAX_SAFE_LIMIT), "9007199254.740991");
  assert.equal(microsToUSD(MAX_SAFE_LIMIT + 1), "");
  assert.equal(microsToUSD(-1), "");
  assert.equal(microsToUSD(1.5), "");
});

test("microdollar values round trip exactly", () => {
  for (const text of ["0", "0.000001", ".5", "40.5", "12.25", "9007199254.740991", "1000000.000001"]) {
    assert.equal(microsToUSD(usdToMicros(text)), text === ".5" ? "0.5" : text, text);
  }
});

test("tokenLimit accepts digit strings within the safe bound", () => {
  assert.equal(tokenLimit(""), undefined);
  assert.equal(tokenLimit("  "), undefined);
  assert.equal(tokenLimit("0"), 0);
  assert.equal(tokenLimit("00125"), 125);
  assert.equal(tokenLimit("9007199254740991"), MAX_SAFE_LIMIT);
  for (const invalid of ["-1", "1.5", "1e3", "9007199254740992", "abc", "+5"]) {
    assert.equal(tokenLimit(invalid), undefined, invalid);
  }
});

test("runBudgetInput reads prefixed limits and preserves zeros", () => {
  const data = new FormData();
  data.set("run_max_input_tokens", "0");
  data.set("run_max_cost_usd", "0.50");
  const budget = runBudgetInput(data);
  assert.deepEqual(budget, { max_input_tokens: 0, max_cost_usd_micros: 500000 });
  assert.deepEqual(runBudgetInput(new FormData()), {});
});

test("templateModelPolicyInput builds custom retry, failover and budget", () => {
  const data = new FormData();
  data.set("retry_mode", "custom");
  data.set("retry_max", "0");
  data.set("retry_base_ms", "1");
  data.set("retry_cap_ms", "30000");
  data.set("failover", "never");
  data.set("run_max_output_tokens", "500");
  assert.deepEqual(templateModelPolicyInput(data), {
    model_retry: { max: 0, base_ms: 1, cap_ms: 30000 },
    failover: "never",
    run_budget: { max_output_tokens: 500 },
  });
});

test("templateModelPolicyInput omits defaults and blank budgets", () => {
  const data = new FormData();
  data.set("retry_mode", "default");
  data.set("failover", "default");
  assert.deepEqual(templateModelPolicyInput(data), {});
});

test("templateModelPolicyInput throws on invalid custom retry or caps", () => {
  const invalid = new FormData();
  invalid.set("retry_mode", "custom");
  invalid.set("retry_max", "9");
  invalid.set("retry_base_ms", "1");
  invalid.set("retry_cap_ms", "10");
  assert.throws(() => templateModelPolicyInput(invalid), /retry/i);
  const swapped = new FormData();
  swapped.set("retry_mode", "custom");
  swapped.set("retry_max", "1");
  swapped.set("retry_base_ms", "200");
  swapped.set("retry_cap_ms", "199");
  assert.throws(() => templateModelPolicyInput(swapped), /retry/i);
  const blankRetry = new FormData();
  blankRetry.set("retry_mode", "custom");
  assert.throws(() => templateModelPolicyInput(blankRetry), /retry/i);
  const badFailover = new FormData();
  badFailover.set("failover", "sometimes");
  assert.throws(() => templateModelPolicyInput(badFailover), /failover/i);
});

test("runBudgetInput throws on nonblank invalid limits", () => {
  for (const [field, value] of [
    ["run_max_input_tokens", "1.5"],
    ["run_max_output_tokens", "-5"],
    ["run_max_cost_usd", "abc"],
    ["run_max_cost_usd", "9007199254.740992"],
  ] as const) {
    const data = new FormData();
    data.set(field, value);
    assert.throws(() => runBudgetInput(data), undefined, `${field}=${value}`);
  }
});

test("decodeModelCallPolicy accepts complete policies and strips nothing required", () => {
  const policy = decodeModelCallPolicy({
    revision: 3, unknown_cost: "deny",
    run_caps: { max_input_tokens: 1000, max_cost_usd_micros: 50 },
    daily: { soft_cost_usd_micros: 40, hard_cost_usd_micros: 60 },
    monthly: {},
  });
  assert.deepEqual(policy, {
    revision: 3, unknown_cost: "deny",
    run_caps: { max_input_tokens: 1000, max_cost_usd_micros: 50 },
    daily: { soft_cost_usd_micros: 40, hard_cost_usd_micros: 60 },
    monthly: {},
  });
  assert.deepEqual(decodeModelCallPolicy({
    revision: 0, unknown_cost: "allow", run_caps: {}, daily: {}, monthly: {},
  }), { revision: 0, unknown_cost: "allow", run_caps: {}, daily: {}, monthly: {} });
});

test("decodeModelCallPolicy rejects malformed or noncontracted shapes", () => {
  for (const body of [
    null, "policy", 42, [],
    { revision: 1 },
    { revision: null, unknown_cost: "deny", run_caps: {}, daily: {}, monthly: {} },
    { revision: 1.5, unknown_cost: "deny", run_caps: {}, daily: {}, monthly: {} },
    { revision: -1, unknown_cost: "deny", run_caps: {}, daily: {}, monthly: {} },
    { revision: MAX_SAFE_LIMIT + 1, unknown_cost: "deny", run_caps: {}, daily: {}, monthly: {} },
    { revision: 1, unknown_cost: "warn", run_caps: {}, daily: {}, monthly: {} },
    { revision: 1, unknown_cost: "deny", run_caps: {}, daily: {}, monthly: {}, organization_id: "org" },
    { revision: 1, unknown_cost: "deny", run_caps: { max_input_tokens: null }, daily: {}, monthly: {} },
    { revision: 1, unknown_cost: "deny", run_caps: { bogus: 1 }, daily: {}, monthly: {} },
    { revision: 1, unknown_cost: "deny", run_caps: { max_input_tokens: -1 }, daily: {}, monthly: {} },
    { revision: 1, unknown_cost: "deny", run_caps: { max_input_tokens: 9007199254740992 }, daily: {}, monthly: {} },
    { revision: 1, unknown_cost: "deny", run_caps: {}, daily: { soft_cost_usd_micros: 61, hard_cost_usd_micros: 60 }, monthly: {} },
    { revision: 1, unknown_cost: "deny", run_caps: {}, daily: {}, monthly: { soft_cost_usd_micros: 11, hard_cost_usd_micros: 10 } },
    { revision: 0, unknown_cost: "deny", run_caps: {}, daily: {}, monthly: {} },
    { revision: 0, unknown_cost: "allow", run_caps: { max_input_tokens: 1 }, daily: {}, monthly: {} },
  ]) {
    assert.throws(() => decodeModelCallPolicy(body), undefined, JSON.stringify(body));
  }
});

test("sameModelCallPolicyIntent requires the exact acknowledged replacement", () => {
  const input = {
    expected_revision: 0, unknown_cost: "deny" as const,
    run_caps: { max_input_tokens: 1000 }, daily: { soft_cost_usd_micros: 40 }, monthly: {},
    expected_principal: ["org-1", "user-1"] as [string, string],
  };
  assert.equal(sameModelCallPolicyIntent({
    revision: 1, unknown_cost: "deny",
    run_caps: { max_input_tokens: 1000 }, daily: { soft_cost_usd_micros: 40 }, monthly: {},
  }, input), true);
  assert.equal(sameModelCallPolicyIntent({
    revision: 1, unknown_cost: "allow",
    run_caps: { max_input_tokens: 1000 }, daily: { soft_cost_usd_micros: 40 }, monthly: {},
  }, input), false);
  assert.equal(sameModelCallPolicyIntent({
    revision: 1, unknown_cost: "deny",
    run_caps: {}, daily: { soft_cost_usd_micros: 40 }, monthly: {},
  }, input), false);
  assert.equal(sameModelCallPolicyIntent({
    revision: 1, unknown_cost: "deny",
    run_caps: { max_input_tokens: 1000, max_output_tokens: 5 }, daily: { soft_cost_usd_micros: 40 }, monthly: {},
  }, input), false);
});
