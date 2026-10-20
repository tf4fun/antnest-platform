import assert from "node:assert/strict";
import { hasDiagnosticError } from "../acp-plan/requests.mjs";
import { clockSkewWarning } from "../../support/strict-findings.mjs";

const key = (item) => `${item.trace_id}/${item.span_id}`;

export function privateACPDiagnosticInventory(sources, reports, ownedReasons) {
  const raw = sources.flatMap((trace) =>
    trace.spans
      .filter(hasDiagnosticError)
      .map((span) => ({ trace_id: trace.traceID, span_id: span.spanID })),
  );
  const rawIDs = new Set(raw.map(key));
  const claims = reports.flatMap((report) => [
    ...(report.owned_error_spans ?? []),
    ...(report.neutral_diagnostics ?? []).filter((item) =>
      rawIDs.has(key(item)),
    ),
  ]);
  assert.equal(
    new Set(claims.map(key)).size,
    claims.length,
    "duplicate command diagnostic claim",
  );
  assert.deepEqual(
    new Set(claims.map(key)),
    rawIDs,
    "unclaimed command raw error",
  );
  assert(
    claims.every((item) => ownedReasons.has(item.reason)),
    "unknown command diagnostic reason",
  );
  return {
    raw_error_inventory: raw,
    owned_error_spans: claims,
    diagnostic_inventory_verified: true,
  };
}

// Raw failure status remains failed. Admission accounts for each actual error
// identity and the existing Jaeger clock warning class without rewriting counts.
export function privateACPStrictOutcome(results, ownedReasons) {
  const allErrors = new Map();
  let failed = false,
    warnings = false;
  try {
    assert(Array.isArray(results) && results.length > 0);
    for (const result of results) {
      assert.equal(result.diagnostic_inventory_verified, true);
      const raw = result.raw_error_inventory,
        owned = result.owned_error_spans;
      assert(Array.isArray(raw) && Array.isArray(owned));
      assert.equal(new Set(raw.map(key)).size, raw.length);
      assert.equal(new Set(owned.map(key)).size, owned.length);
      assert.deepEqual(new Set(raw.map(key)), new Set(owned.map(key)));
      assert(owned.every((item) => ownedReasons.has(item.reason)));
      assert.equal(result.error_spans, raw.length);
      assert(
        Array.isArray(result.warnings) &&
          result.warnings.every(
            (warning) =>
              typeof warning === "string" && clockSkewWarning.test(warning),
          ),
      );
      assert(
        Number.isSafeInteger(result.warning_count) &&
          result.warning_count >= result.warnings.length,
      );
      assert.equal(result.warning_count === 0, result.warnings.length === 0);
      assert.equal(
        result.strict_trace,
        raw.length || result.warning_count ? "failed" : "passed",
      );
      for (const item of owned) {
        if (allErrors.has(key(item)))
          assert.deepEqual(
            allErrors.get(key(item)),
            item,
            "inconsistent shared raw diagnostic",
          );
        else allErrors.set(key(item), item);
      }
      failed ||= result.strict_trace === "failed";
      warnings ||= result.warning_count > 0;
    }
    return {
      strict_trace: failed ? "failed" : "passed",
      accepted: true,
      exit_code: failed ? 2 : 0,
      reviewed_error_spans: allErrors.size,
      ...(warnings ? { clock_warnings_accepted: true } : {}),
    };
  } catch {
    return { strict_trace: "failed", accepted: false, exit_code: 1 };
  }
}
