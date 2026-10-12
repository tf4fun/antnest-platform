import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { temporaryStorageRoot } from "../../support/storage.mjs";
import { unreviewedWarnings } from "../../support/strict-findings.mjs";
import { collectResolveTraceEvidence } from "../../support/gateway-resolution-evidence.mjs";
import { inspectGatewayResolution } from "../../support/gateway-resolution.mjs";
import {
  sharedResolutionFixture,
  sourceID,
} from "./gateway-resolution-fixtures.mjs";

function fixture(t) {
  const f = sharedResolutionFixture(true);
  const directory = mkdtempSync(
    join(temporaryStorageRoot(), "antnest-resolve-evidence-"),
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const requests = [];
  const request = async (url) => {
    const id = new URL(url).pathname.split("/").at(-1);
    requests.push(id);
    return Response.json({ data: [f.traces.get(id)] });
  };
  return {
    ...f,
    directory,
    request,
    requests,
    attempts: 3,
    wait: async () => {},
  };
}

for (const inspectorStrict of ["passed", "failed"])
  for (const sourceWarning of [false, true])
    test(`shared collector preserves ${inspectorStrict} business evidence with source warning=${sourceWarning}`, async (t) => {
      const f = fixture(t);
      if (sourceWarning)
        f.traces.get(sourceID).warnings = ["source clock skew"];
      let inspected = 0;
      const businessEvidence = {
        strict_trace: inspectorStrict,
        timing: { acp_start_minus_gateway_us: -125 },
        authority_bound_verified: true,
      };
      const [result] = await collectResolveTraceEvidence(
        "http://jaeger",
        [{ traceID: f.trace.traceID }],
        [],
        {
          ...f,
          inspect: async (trace, _expected, _secrets, collection) => {
            inspected++;
            return {
              ...businessEvidence,
              gateway_resolution: inspectGatewayResolution(
                trace,
                f.expected,
                collection,
              ),
            };
          },
        },
      );
      assert.equal(inspected, 3);
      assert.equal(
        result.strict_trace,
        sourceWarning ? "failed" : inspectorStrict,
        "clean Resolve sources must not erase a business inspector failure",
      );
      assert.equal(result.authority_bound_verified, true);
      assert.deepEqual(result.timing, businessEvidence.timing);
      assert.equal(businessEvidence.strict_trace, inspectorStrict);
      assert.equal(result.warning_count, sourceWarning ? 1 : 0);
      assert.deepEqual(
        result.warnings,
        sourceWarning ? ["source clock skew"] : [],
      );
      assert.equal(result.gateway_resolution.source, "shared");
      assert.equal(result.source_trace_ids.length, 2);
      assert.deepEqual(
        unreviewedWarnings(JSON.stringify(result)),
        sourceWarning ? ["source clock skew"] : [],
      );
    });

test("shared collector requires the owning inspector before querying evidence", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    collectResolveTraceEvidence(
      "http://jaeger",
      [{ traceID: f.trace.traceID }],
      [],
      f,
    ),
    /owning trace inspector required/u,
  );
  assert.deepEqual(f.requests, []);
});

for (const ownerDiagnostics of [
  {
    strict_trace: "failed",
    warnings: ["independent authority evidence mismatch"],
    warning_count: 1,
    error_spans: [{ span_id: "business-error", classification: "review" }],
  },
  {
    strict_trace: "failed",
    warnings: 1,
    diagnostics: [{ warnings: ["browser authority evidence mismatch"] }],
  },
])
  test(`shared collector retains owning diagnostics with ${typeof ownerDiagnostics.warnings} warnings`, async (t) => {
    const f = fixture(t);
    const [result] = await collectResolveTraceEvidence(
      "http://jaeger",
      [{ traceID: f.trace.traceID }],
      [],
      { ...f, inspect: () => structuredClone(ownerDiagnostics) },
    );
    assert.equal(result.strict_trace, "failed");
    assert.equal(result.warning_count, 0);
    assert.equal(result.error_spans, 0);
    assert.deepEqual(result.warnings, []);
    for (const key of [
      "warnings",
      "warning_count",
      "error_spans",
      "strict_trace",
    ])
      if (Object.hasOwn(ownerDiagnostics, key))
        assert.deepEqual(
          result.inspector_diagnostics?.[key],
          ownerDiagnostics[key],
        );
    if (ownerDiagnostics.diagnostics)
      assert.deepEqual(result.diagnostics, ownerDiagnostics.diagnostics);
    assert.deepEqual(
      unreviewedWarnings(JSON.stringify(result)),
      Array.isArray(ownerDiagnostics.warnings)
        ? ownerDiagnostics.warnings
        : ownerDiagnostics.diagnostics[0].warnings,
    );
  });
