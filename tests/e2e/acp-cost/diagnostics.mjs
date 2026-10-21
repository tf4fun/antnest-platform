import assert from "node:assert/strict";
import { createTraceDiagnostics } from "../../support/trace-diagnostics.mjs";
import { collectPrivateCostTrace } from "./collector.mjs";
import {
  collectCostPricingTrace,
  costStrictOutcome,
} from "./pricing-collector.mjs";

export async function collectCostTraceDiagnostics(
  base,
  expected,
  expectedPricing,
  options = {},
) {
  const {
    collectRequest = collectPrivateCostTrace,
    collectPricing = collectCostPricingTrace,
    diagnostics = createTraceDiagnostics(options),
  } = options;
  const checked = [];
  const pricing = [];
  for (const [index, request] of expected.entries()) {
    const diagnostic = await diagnostics.run(
      `cost-request-${index}`,
      (signal) => collectRequest(base, request, { ...options, signal }),
    );
    checked.push(
      diagnostic.status === "passed"
        ? diagnostic.value
        : { label: request.label, diagnostic },
    );
  }
  for (const [index, request] of expectedPricing.entries()) {
    const diagnostic = await diagnostics.run(
      `cost-pricing-${index}`,
      (signal) => collectPricing(base, request, { ...options, signal }),
    );
    pricing.push(
      diagnostic.status === "passed" ? diagnostic.value : { diagnostic },
    );
  }
  await diagnostics.run("cost-trace-inventory", async () => {
    assert(checked.every((row) => row.trace_id));
    assert.equal(
      new Set(checked.map((row) => row.trace_id)).size,
      expected.length,
    );
    const native = checked.filter((row) => row.kind === "native");
    assert.equal(
      new Set(native.map((row) => row.run_id).filter(Boolean)).size,
      expected.filter((row) => row.kind === "native").length,
    );
    assert.deepEqual(
      new Set(native.map((row) => row.trace_id)),
      new Set((options.requests ?? []).map((row) => row.trace_id)),
    );
  });
  const strict = costStrictOutcome(checked, pricing);
  await diagnostics.run("cost-strict-trace-result", async () => {
    assert.equal(
      strict.exit_code,
      0,
      "original strict Trace findings retained as auxiliary diagnostics",
    );
  });
  return { checked, pricing, strict, trace_diagnostics: diagnostics.summary() };
}
