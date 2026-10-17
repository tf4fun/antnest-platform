import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { inspect as formatFailure, types } from "node:util";
import { collectPrivateACPConsumerTrace } from "../acp-commands/collector.mjs";
import {
  privateACPDiagnosticInventory,
  privateACPStrictOutcome,
} from "../observability/private-acp-inventory.mjs";
import { canonicalCompleteSources } from "../../support/complete-source-inspection.mjs";
import { evidenceFilePath, writeEvidenceFile } from "../../support/storage.mjs";
import { inspectCostWarningSources } from "./warning-source.mjs";
import { inspectPrivateCostRunTrace } from "./run-trace.mjs";
import { inspectPrivateCostConfigurationTrace } from "./configuration-trace.mjs";
import { inspectPrivateCostSessionTrace } from "./session-trace.mjs";
import { inspectPrivateCostControlTrace } from "./control-trace.mjs";

const ownedReasons = new Set([
  "cost-rejection",
  "private-http-sse-close",
  "completed-initialize-mcp-read-disconnect",
  "completed-runtime-tool-http-disconnect",
]);
const admissions = new WeakMap();
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sourceHash = (sources) => hash(canonicalCompleteSources(sources));
const encode = (value) => JSON.stringify(value, null, 2) + "\n";
const order = (a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b));
// Compare derived inventories independently of Jaeger's Span enumeration.
// Keep every original policy, warning array and occurrence index in the proof.
const comparablePolicy = (policy) => ({
  ...policy,
  inventory: policy.inventory.toSorted(order),
  sources: policy.sources
    .map((source) => ({
      ...source,
      occurrences: source.occurrences.toSorted(order),
    }))
    .toSorted(order),
});
const failure = () => new Error("private Cost trace admission failed");
const read = (directory, file) => {
  const path = evidenceFilePath(directory, file);
  assert(lstatSync(path).isFile(), "Cost archive entry is not a regular file");
  return readFileSync(path);
};

function assertDataProperties(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  assert(!types.isProxy(value), "Cost report cannot contain a Proxy");
  seen.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    assert(Object.hasOwn(descriptor, "value"), "Cost report accessor");
    assertDataProperties(descriptor.value, seen);
  }
}

export function privateCostStrictOutcome(results) {
  try {
    assert(Array.isArray(results) && results.length > 0);
    const business = new Set(),
      sources = new Map(),
      warnings = new Map();
    const originals = [];
    for (const result of results) {
      const binding = admissions.get(result);
      assert(binding, "unbound Cost result");
      assertDataProperties(result);
      assert.deepEqual(result, binding.result, "changed Cost result");
      const original = binding.result;
      originals.push(original);
      assert(!business.has(original.trace_id), "repeated Cost business Trace");
      business.add(original.trace_id);
      for (const file of binding.files) {
        const bytes = read(binding.directory, file.name);
        assert.equal(bytes.length, file.bytes);
        assert.equal(hash(bytes), file.sha256, "changed Cost archive");
      }
      for (const [id, digest] of binding.sources) {
        if (sources.has(id))
          assert.equal(
            sources.get(id),
            digest,
            "inconsistent shared Cost source",
          );
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
    }
    const strict = privateACPStrictOutcome(originals, ownedReasons);
    assert.equal(strict.accepted, true);
    return { ...strict, reviewed_warning_occurrences: warnings.size };
  } catch {
    return { strict_trace: "failed", accepted: false, exit_code: 1 };
  }
}

function bindReceipt(result, checks, expected) {
  const directory = result.evidence_directory;
  const receipt = result.complete_source_receipt;
  assert(receipt && receipt.version === 1 && receipt.stable_samples === 3);
  assert.equal(receipt.transport, expected.transport);
  assert.equal(receipt.samples.length, 3);
  assert(checks.length >= 3);
  const checked = checks.slice(-3),
    last = checked.at(-1);
  assert.deepEqual(receipt.source_trace_ids, last.source_trace_ids);
  assert.equal(receipt.source_snapshot_sha256, last.source_snapshot_sha256);
  const manifest = JSON.parse(read(directory, "manifest.json"));
  assert.equal(manifest.status, "collected");
  assert.equal(manifest.attempts.length >= 3, true);
  const attempts = manifest.attempts.slice(-3);
  assert.equal(
    new Set(manifest.queries.map((query) => query.file)).size,
    manifest.queries.length,
  );
  for (const query of manifest.queries) {
    assert.match(query.file, /^query-\d{4,}\.raw$/u);
    const bytes = read(directory, query.file);
    assert.equal(bytes.length, query.bytes);
    assert.equal(hash(bytes), query.sha256);
  }
  let finalSources;
  const samples = receipt.samples.map((sample, index) => {
    const current = checked[index],
      attempt = attempts[index];
    assert.equal(attempt.status, "validated");
    assert.equal(sample.attempt, attempt.attempt);
    if (index)
      assert.equal(sample.attempt, receipt.samples[index - 1].attempt + 1);
    assert.equal(sample.snapshot_sha256, attempt.snapshot_sha256);
    assert.equal(sample.source_snapshot_sha256, attempt.source_snapshot_sha256);
    assert.deepEqual(sample.source_trace_ids, attempt.source_trace_ids);
    assert.equal(sample.source_snapshot_sha256, current.source_snapshot_sha256);
    assert.deepEqual(sample.source_trace_ids, current.source_trace_ids);
    assert.deepEqual(
      comparablePolicy(current.policy),
      comparablePolicy(last.policy),
    );
    assert.deepEqual(current.reports, last.reports);
    assert.deepEqual(
      sample.queries,
      manifest.queries.filter((query) => query.attempt === sample.attempt),
    );
    const traces = new Map();
    for (const query of sample.queries) {
      assert.equal(query.status, 200);
      assert.equal(query.body_complete, true);
      assert.equal(query.outcome, "complete");
      const body = JSON.parse(read(directory, query.file));
      for (const trace of body.data ?? []) {
        if (traces.has(trace.traceID))
          assert.equal(
            sourceHash([traces.get(trace.traceID)]),
            sourceHash([trace]),
          );
        traces.set(trace.traceID, trace);
      }
    }
    assert.deepEqual(
      [...current.source_trace_order].sort(),
      sample.source_trace_ids,
    );
    const sources = current.source_trace_order.map((id) => {
      assert(traces.has(id), "missing archived Cost source");
      return traces.get(id);
    });
    assert.equal(sourceHash(sources), sample.source_snapshot_sha256);
    const policy = inspectCostWarningSources(
      sources,
      current.reports.flatMap((report) => report.time_observations ?? []),
    );
    assert.deepEqual(policy, current.policy);
    assert.equal(policy.eligible_for_review, true);
    finalSources = sources;
    return {
      attempt: sample.attempt,
      source_snapshot_sha256: sample.source_snapshot_sha256,
      source_trace_ids: sample.source_trace_ids,
      source_trace_order: current.source_trace_order,
      reports: current.reports,
      policy,
    };
  });
  assert.equal(result.trace_id, last.reports[0].trace_id);
  assert.equal(result.method, expected.method);
  assert.equal(result.warning_count, last.policy.warning_count);
  assert.deepEqual(
    new Set(result.warnings),
    new Set(last.policy.inventory.map((item) => item.warning)),
  );
  assert.deepEqual(
    result.time_observations,
    last.reports.flatMap((report) => report.time_observations ?? []),
  );
  const inventory = privateACPDiagnosticInventory(
    finalSources,
    last.reports,
    ownedReasons,
  );
  for (const [key, value] of Object.entries(inventory))
    assert.deepEqual(result[key], value);
  assert.equal(privateACPStrictOutcome([result], ownedReasons).accepted, true);
  return {
    proof: { version: 1, expected, samples },
    sources: finalSources.map((source) => [
      source.traceID,
      sourceHash([source]),
    ]),
    policy: last.policy,
  };
}

export function inspectPrivateCostTrace(
  trace,
  expected,
  secrets = [],
  requests = [],
) {
  assert.equal(expected.boundary, "private-acp");
  assert(Array.isArray(requests));
  const execution = expected.kind === "native";
  if (execution)
    assert(typeof expected.phase === "string" && expected.phase.length > 0);
  // Both correlations must survive selection: a receipt with this Trace but
  // a wrong phase, or this phase on a foreign Trace, belongs in the Run oracle.
  const selected = requests.filter(
    (item) =>
      item.trace_id === trace.traceID ||
      (execution && item.phase === expected.phase),
  );
  if (execution)
    return inspectPrivateCostRunTrace(trace, expected, secrets, selected);
  assert.equal(expected.kind, "request");
  if (expected.method === "initialize" || expected.rejection !== undefined)
    return inspectPrivateCostControlTrace(trace, expected, secrets, selected);
  if (["session/set_config_option", "session/list"].includes(expected.method))
    return inspectPrivateCostConfigurationTrace(
      trace,
      expected,
      secrets,
      selected,
    );
  assert(
    ["session/new", "session/load", "session/resume", "session/fork"].includes(
      expected.method,
    ),
    "unowned Cost ACP method",
  );
  return inspectPrivateCostSessionTrace(trace, expected, secrets, selected);
}

export async function collectPrivateCostTrace(base, expected, options = {}) {
  const originalExpected = structuredClone(expected);
  const checks = [];
  const collected = await collectPrivateACPConsumerTrace(
    base,
    originalExpected,
    options,
    {
      ownedReasons,
      inspect: inspectPrivateCostTrace,
      inspectCompleteSources: ({ expected: bound, sources, reports }) => {
        for (const [key, value] of Object.entries(originalExpected))
          if (value !== undefined) assert.deepEqual(bound[key], value);
        const policy = inspectCostWarningSources(
          sources,
          reports.flatMap((report) => report.time_observations ?? []),
        );
        if (!policy.eligible_for_review)
          throw new Error("Cost warning source validation rejected", {
            cause: policy,
          });
        checks.push({
          source_trace_ids: sources.map((source) => source.traceID).sort(),
          source_trace_order: sources.map((source) => source.traceID),
          source_snapshot_sha256: sourceHash(sources),
          reports: structuredClone(reports),
          policy,
        });
      },
    },
  );
  // The public Cost result remains ordinary mutable data. Only its exact
  // returned identity and private immutable baseline can confer admission.
  const result = structuredClone(collected),
    directory = result.evidence_directory;
  try {
    options.signal?.throwIfAborted();
    writeEvidenceFile(
      directory,
      "collection-result.private.json",
      read(directory, "result.json"),
    );
    unlinkSync(evidenceFilePath(directory, "result.json"));
    const checked = bindReceipt(result, checks, originalExpected);
    const proof = encode(checked.proof);
    writeEvidenceFile(directory, "cost-warning-review.private.json", proof);
    result.cost_warning_review = {
      version: 1,
      source_trace_ids: [...result.complete_source_receipt.source_trace_ids],
      source_snapshot_sha256:
        result.complete_source_receipt.source_snapshot_sha256,
      warning_count: checked.policy.warning_count,
      deferred_warning_count: checked.policy.deferred_warning_count,
      reviewed_lifecycle_warning_count:
        checked.policy.reviewed_lifecycle_warning_count,
      review_sha256: hash(proof),
    };
    writeEvidenceFile(directory, "result.json", encode(result));
    const files = readdirSync(directory).map((name) => {
      const bytes = read(directory, name);
      return { name, bytes: bytes.length, sha256: hash(bytes) };
    });
    admissions.set(result, {
      result: structuredClone(result),
      directory,
      files,
      sources: checked.sources,
      inventory: structuredClone(checked.policy.inventory),
    });
    return result;
  } catch (cause) {
    writeEvidenceFile(
      directory,
      "cost-warning-failure.private.txt",
      formatFailure(cause, { depth: 8 }) + "\n",
    );
    const manifest = JSON.parse(read(directory, "manifest.json"));
    manifest.status = "failed";
    manifest.cost_warning_admission = "failed";
    writeEvidenceFile(directory, "manifest.json", encode(manifest));
    if (readdirSync(directory).includes("result.json"))
      unlinkSync(evidenceFilePath(directory, "result.json"));
    options.signal?.throwIfAborted();
    throw failure();
  }
}
