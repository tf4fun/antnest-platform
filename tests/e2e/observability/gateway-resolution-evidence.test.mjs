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

function independentSeed(f) {
  const traceID = "d".repeat(32);
  const root = f.trace.spans.find(
    (span) =>
      !(span.references ?? []).some((ref) => ref.refType === "CHILD_OF"),
  );
  const seed = {
    traceID,
    processes: structuredClone(f.trace.processes),
    spans: [{ ...structuredClone(root), traceID, references: [] }],
  };
  f.traces.set(traceID, seed);
  return seed;
}

for (const withException of [false, true])
  test(`independent cancellation retains its actual error classification (exception=${withException})`, async (t) => {
    const f = fixture(t),
      seed = independentSeed(f);
    seed.spans[0].tags.push({
      key: "antnest.outcome",
      type: "string",
      value: "cancelled",
    });
    if (withException)
      seed.spans[0].tags.push({
        key: "exception.type",
        type: "string",
        value: "TypeError",
      });
    const [result] = await collectResolveTraceEvidence(
      "http://jaeger",
      [{ traceID: f.trace.traceID, relatedTraceIDs: [seed.traceID] }],
      [],
      {
        ...f,
        inspect: () => ({ strict_trace: "passed" }),
      },
    );
    assert.equal(result.error_spans, withException ? 1 : 0);
    assert.equal(result.strict_trace, withException ? "failed" : "passed");
    assert(result.source_trace_ids.includes(seed.traceID));
  });

for (const [label, diagnostic] of [
  [
    "numeric OTel ERROR",
    { tag: { key: "otel.status_code", type: "int64", value: 2 } },
  ],
  [
    "exception type",
    { tag: { key: "exception.type", type: "string", value: "TypeError" } },
  ],
  [
    "exception event",
    { event: { key: "event", type: "string", value: "exception" } },
  ],
])
  test(`independent seed ${label} remains a strict raw failure`, async (t) => {
    const f = fixture(t),
      seed = independentSeed(f);
    if (diagnostic.tag) seed.spans[0].tags.push(diagnostic.tag);
    else
      (seed.spans[0].logs ??= []).push({
        timestamp: seed.spans[0].startTime + 1,
        fields: [diagnostic.event],
      });
    const [result] = await collectResolveTraceEvidence(
      "http://jaeger",
      [{ traceID: f.trace.traceID, relatedTraceIDs: [seed.traceID] }],
      [],
      {
        ...f,
        inspect: () => ({ strict_trace: "passed" }),
      },
    );
    assert.equal(result.error_spans, 1);
    assert.equal(result.strict_trace, "failed");
  });

test("independent mutation seeds participate in the same complete three-snapshot closure", async (t) => {
  const f = fixture(t),
    seed = independentSeed(f);
  let queried = 0;
  const request = async (url, options) => {
    if (new URL(url).pathname.endsWith(seed.traceID)) {
      queried++;
      if (queried >= 2) seed.warnings = ["late independent mutation warning"];
    }
    return f.request(url, options);
  };
  const [result] = await collectResolveTraceEvidence(
    "http://jaeger",
    [{ traceID: f.trace.traceID, relatedTraceIDs: [seed.traceID] }],
    [],
    {
      ...f,
      request,
      attempts: 4,
      inspect: (trace, _expected, _secrets, collection) => {
        assert(collection.archivedTraceIDs.has(seed.traceID));
        assert(collection.traces.has(seed.traceID));
        assert(
          trace.spans.every(
            (span) =>
              !(span.references ?? []).some(
                (ref) => ref.traceID === seed.traceID,
              ),
          ),
          "independent seed must not invent a parent or Link",
        );
        return { strict_trace: "passed" };
      },
    },
  );
  assert.equal(queried, 4);
  assert.equal(result.strict_trace, "failed");
  assert.deepEqual(result.warnings, ["late independent mutation warning"]);
  assert(result.source_trace_ids.includes(seed.traceID));
});

test("a missing explicit related trace cannot become a complete closure", async (t) => {
  const f = fixture(t),
    seed = independentSeed(f);
  await assert.rejects(
    collectResolveTraceEvidence(
      "http://jaeger",
      [{ traceID: f.trace.traceID, relatedTraceIDs: [seed.traceID] }],
      [],
      {
        ...f,
        request: (url, options) =>
          new URL(url).pathname.endsWith(seed.traceID)
            ? Promise.resolve(Response.json({ data: [] }, { status: 404 }))
            : f.request(url, options),
        inspect: () => ({ strict_trace: "passed" }),
      },
    ),
  );
});

test("explicit related trace content is checked for secrets before owning inspection", async (t) => {
  const f = fixture(t),
    seed = independentSeed(f);
  seed.warnings = ["private-mutation-canary"];
  let inspected = 0;
  await assert.rejects(
    collectResolveTraceEvidence(
      "http://jaeger",
      [{ traceID: f.trace.traceID, relatedTraceIDs: [seed.traceID] }],
      ["private-mutation-canary"],
      {
        ...f,
        inspect: () => {
          inspected++;
          return { strict_trace: "passed" };
        },
      },
    ),
  );
  assert.equal(inspected, 0);
});

for (const relatedTraceIDs of [
  null,
  "invalid",
  ["secret-invalid-id"],
  ["d".repeat(32), "d".repeat(32)],
])
  test(`invalid explicit seed inventory is rejected before network: ${JSON.stringify(relatedTraceIDs)}`, async (t) => {
    const f = fixture(t);
    await assert.rejects(
      collectResolveTraceEvidence(
        "http://jaeger",
        [{ traceID: f.trace.traceID, relatedTraceIDs }],
        [],
        {
          ...f,
          inspect: () => ({ strict_trace: "passed" }),
        },
      ),
    );
    assert.deepEqual(f.requests, []);
  });

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
