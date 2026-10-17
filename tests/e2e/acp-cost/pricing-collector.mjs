import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { inspect, types } from "node:util";
import {
  evidenceDirectory,
  evidenceFilePath,
  writeEvidenceFile,
} from "../../support/storage.mjs";
import { collectObservabilityResolution } from "../observability/resolve-evidence.mjs";
import { resolveObservationConfig } from "../observability/resolve-config.mjs";
import { resolveTraceSources } from "../../support/gateway-resolution-evidence.mjs";
import {
  privateACPDiagnosticInventory,
  privateACPStrictOutcome,
} from "../observability/private-acp-inventory.mjs";
import { assertSessionSuccess } from "../identity-closeout/session-diagnostics.mjs";
import { inspectPricingTrace } from "./trace.mjs";
import { assertCostTraceSource } from "./trace-source.mjs";
import { privateCostStrictOutcome } from "./collector.mjs";
import { canonicalCompleteSources } from "../../support/complete-source-inspection.mjs";
import { reviewCostWarningSources } from "./warning-source.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sourceHash = (sources) => hash(canonicalCompleteSources(sources));
const admissions = new WeakMap();
const read = (directory, name) =>
  readFileSync(evidenceFilePath(directory, name));
// Detailed original failures are private archive data, never public errors.
const collectionFailure = () => new Error("Cost pricing collection failed");

function warningPolicy(sources) {
  for (const trace of sources)
    for (const item of [trace, ...trace.spans])
      assert(
        Array.isArray(item.warnings ?? []) &&
          (item.warnings ?? []).every((value) => typeof value === "string"),
      );
  // Clean sources require no SDK exception; their full topology and business
  // invariants are checked independently by Resolve and the owning inspector.
  const warned = sources.filter(
    (trace) =>
      (trace.warnings?.length ?? 0) > 0 ||
      trace.spans.some((span) => (span.warnings?.length ?? 0) > 0),
  );
  const policy = reviewCostWarningSources(
    warned
      .toSorted((a, b) => a.traceID.localeCompare(b.traceID))
      .map((trace) => ({
        ...trace,
        spans: trace.spans.toSorted((a, b) => a.spanID.localeCompare(b.spanID)),
      })),
  );
  assert.equal(policy.eligible_for_review, true);
  return policy;
}

function archiveFiles(directory) {
  assert(
    lstatSync(directory).isDirectory(),
    "pricing archive directory changed",
  );
  return readdirSync(directory)
    .sort()
    .flatMap((name) => {
      const path = join(directory, name),
        stat = lstatSync(path);
      if (stat.isDirectory()) return archiveFiles(path);
      assert(stat.isFile(), "pricing archive is not a regular file");
      const bytes = read(directory, name);
      return [{ directory, name, bytes: bytes.length, sha256: hash(bytes) }];
    });
}

function assertDataProperties(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  assert(!types.isProxy(value));
  seen.add(value);
  for (const descriptor of Object.values(
    Object.getOwnPropertyDescriptors(value),
  )) {
    assert(Object.hasOwn(descriptor, "value"));
    assertDataProperties(descriptor.value, seen);
  }
}

function bindPricing(result, archive, checks, expected) {
  assert.equal(checks.length, 3);
  const last = checks.at(-1);
  let finalSources;
  for (const sample of checks) {
    assert.equal(sample.source_snapshot_sha256, last.source_snapshot_sha256);
    assert.deepEqual(sample.policy, last.policy);
    const traces = new Map();
    for (const query of sample.queries) {
      assert.equal(query.status, 200);
      assert.equal(query.body_complete, true);
      assert.equal(query.outcome, "complete");
      const bytes = read(archive, query.file);
      assert.equal(bytes.length, query.bytes);
      assert.equal(hash(bytes), query.sha256);
      const body = JSON.parse(bytes);
      assert(Array.isArray(body.data) && body.data.length === 1);
      for (const trace of body.data) {
        if (traces.has(trace.traceID))
          assert.equal(
            sourceHash([traces.get(trace.traceID)]),
            sourceHash([trace]),
          );
        traces.set(trace.traceID, trace);
      }
    }
    finalSources = [...traces.values()];
    assert.deepEqual([...traces.keys()].sort(), sample.source_trace_ids);
    assert.equal(sourceHash(finalSources), sample.source_snapshot_sha256);
    assert.deepEqual(warningPolicy(finalSources), sample.policy);
  }
  assert.equal(result.trace_id, expected.traceID);
  assert.equal(result.warning_count, last.policy.warning_count);
  assert.deepEqual(
    new Set(result.warnings),
    new Set(last.policy.inventory.map((item) => item.warning)),
  );
  const inventory = privateACPDiagnosticInventory(finalSources, [], new Set());
  for (const [key, value] of Object.entries(inventory))
    assert.deepEqual(result[key], value);
  assert.equal(privateACPStrictOutcome([result], new Set()).accepted, true);
  const proof =
    JSON.stringify({ version: 1, expected, samples: checks }) + "\n";
  writeEvidenceFile(archive, "pricing-warning-review.private.json", proof);
  const bound = {
    ...result,
    raw_evidence_directory: archive,
    pricing_warning_review: {
      version: 1,
      stable_samples: 3,
      warning_count: last.policy.warning_count,
      waived_external_sdk_warning_count:
        last.policy.waived_external_sdk_warning_count,
      review_sha256: hash(proof),
    },
  };
  admissions.set(bound, {
    result: structuredClone(bound),
    files: archiveFiles(archive),
    sources: finalSources.map((source) => [
      source.traceID,
      sourceHash([source]),
    ]),
    inventory: last.policy.inventory,
  });
  return bound;
}

// Pricing SDK diagnostics do not own any business errors. Original pricing
// objects, all three source samples and raw archives remain bound to admission.
export function costStrictOutcome(acp, pricing) {
  try {
    assert(Array.isArray(acp) && acp.length > 0);
    assert(Array.isArray(pricing) && pricing.length > 0);
    const originals = [],
      business = new Set(),
      sources = new Map(),
      warnings = new Map();
    for (const result of pricing) {
      const binding = admissions.get(result);
      assert(binding, "unbound pricing result");
      assertDataProperties(result);
      assert.deepEqual(result, binding.result);
      const original = binding.result;
      assert.equal(original.pricing_trace_verified, true);
      assert.equal(original.error_spans, 0);
      assert(!business.has(original.trace_id), "repeated pricing Trace");
      business.add(original.trace_id);
      assert.deepEqual(
        archiveFiles(original.raw_evidence_directory),
        binding.files,
      );
      for (const [id, digest] of binding.sources) {
        if (sources.has(id)) assert.equal(sources.get(id), digest);
        sources.set(id, digest);
      }
      for (const item of binding.inventory) {
        const key = JSON.stringify([
          item.trace_id,
          item.span_id,
          item.warning_index,
        ]);
        if (warnings.has(key)) assert.deepEqual(warnings.get(key), item);
        warnings.set(key, item);
      }
      originals.push(original);
    }
    const pricingStrict = privateACPStrictOutcome(originals, new Set());
    const acpStrict = privateCostStrictOutcome(acp);
    assert.equal(pricingStrict.accepted, true);
    assert.equal(acpStrict.accepted, true);
    const failed =
      pricingStrict.strict_trace === "failed" ||
      acpStrict.strict_trace === "failed";
    return {
      ...acpStrict,
      strict_trace: failed ? "failed" : "passed",
      exit_code: failed ? 2 : 0,
      pricing_reviewed_warning_occurrences: warnings.size,
      ...(pricingStrict.clock_warnings_accepted
        ? { clock_warnings_accepted: true }
        : {}),
    };
  } catch {
    return { strict_trace: "failed", accepted: false, exit_code: 1 };
  }
}

export async function collectCostPricingTrace(base, expected, options = {}) {
  expected = structuredClone(expected);
  const { request = fetch, signal, secrets = [], wait } = options;
  signal?.throwIfAborted();
  const directory = evidenceDirectory(options.directory);
  assert(directory, "Cost pricing evidence directory required");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  assert.match(expected.traceID, /^[a-f0-9]{32}$/u);
  const archive = mkdtempSync(
    join(directory, `cost-pricing-${expected.traceID}-`),
  );
  const manifest = {
    trace_id: expected.traceID,
    outcome: "collecting",
    queries: [],
  };
  const checks = [];
  let checkedQueries = 0;
  const save = () =>
    writeEvidenceFile(
      archive,
      "manifest.private.json",
      JSON.stringify(manifest) + "\n",
    );
  save();
  // Archive bytes before any JSON decoding. The same adapter wraps the main
  // query and every Resolve source/refresh query in each stability sample.
  const archivedRequest = async (address, init = {}) => {
    const query = {
      url: String(address),
      file: `query-${String(manifest.queries.length + 1).padStart(4, "0")}.raw`,
      status: null,
      outcome: "pending",
      body_complete: false,
    };
    manifest.queries.push(query);
    let bytes = Buffer.alloc(0),
      reader,
      cancellation;
    const preserve = () => {
      writeEvidenceFile(archive, query.file, bytes);
      Object.assign(query, { bytes: bytes.length, sha256: hash(bytes) });
      save();
    };
    const cancel = () => {
      if (reader) cancellation ??= reader.cancel().catch(() => {});
      return cancellation;
    };
    preserve();
    try {
      init.signal?.throwIfAborted();
      const response = await request(address, init);
      query.status = response.status;
      preserve();
      reader = response.body?.getReader();
      init.signal?.addEventListener("abort", cancel, { once: true });
      if (init.signal?.aborted) cancel();
      init.signal?.throwIfAborted();
      if (reader)
        for (;;) {
          const chunk = await reader.read();
          if (chunk.value !== undefined) {
            bytes = Buffer.concat([bytes, Buffer.from(chunk.value)]);
            preserve();
          }
          init.signal?.throwIfAborted();
          if (chunk.done) break;
        }
      query.body_complete = true;
      query.outcome = "complete";
      return {
        status: response.status,
        text: async () => bytes.toString("utf8"),
      };
    } catch (error) {
      query.outcome = init.signal?.aborted ? "aborted" : "failed";
      writeEvidenceFile(
        archive,
        query.file + ".failure.private.txt",
        inspect(error, { depth: 8 }) + "\n",
      );
      throw error;
    } finally {
      init.signal?.removeEventListener("abort", cancel);
      if (!query.body_complete) await cancel();
      reader?.releaseLock();
      preserve();
    }
  };
  try {
    const config = resolveObservationConfig({});
    assert.equal(
      config.captureRpcContent,
      false,
      "Cost RPC capture must remain disabled",
    );
    const result = await collectObservabilityResolution(
      base,
      {
        traceID: expected.traceID,
        profile: "console",
        resolveTTLMS: options.resolveTTLMS ?? config.resolveTTLMS,
        route: "/api/admin/{path...}",
        consoleRoute: expected.publicRoute,
        method: "POST",
        status: 201,
      },
      {
        directory: archive,
        captureRpcContent: false,
        signal,
        wait,
        request: archivedRequest,
        inspectWarnings: ({ sources }) => {
          const policy = warningPolicy(sources);
          checks.push({
            source_trace_ids: sources.map((source) => source.traceID).sort(),
            source_snapshot_sha256: sourceHash(sources),
            queries: structuredClone(manifest.queries.slice(checkedQueries)),
            policy,
          });
          checkedQueries = manifest.queries.length;
        },
        inspect: (trace, _expected, collection) => {
          const before = JSON.stringify([...collection.traces]);
          const sources = resolveTraceSources(trace, secrets, collection);
          assertCostTraceSource(...sources);
          for (const source of sources)
            for (const span of source.spans) assertSessionSuccess(span);
          const owned = inspectPricingTrace(trace, expected, secrets);
          const inventory = privateACPDiagnosticInventory(
            sources,
            [],
            new Set(),
          );
          assert.equal(
            JSON.stringify([...collection.traces]),
            before,
            "Cost pricing inspector mutated original sources",
          );
          return { ...owned, ...inventory, pricing_trace_verified: true };
        },
      },
    );
    manifest.outcome = "complete";
    save();
    return bindPricing(result, archive, checks, expected);
  } catch (error) {
    manifest.outcome = signal?.aborted ? "aborted" : "failed";
    writeEvidenceFile(
      archive,
      "failure.private.txt",
      inspect(error, { depth: 8 }) + "\n",
    );
    signal?.throwIfAborted();
    throw collectionFailure();
  } finally {
    save();
  }
}
