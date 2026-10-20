import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { inspect } from "node:util";
import { evidenceFilePath, writeEvidenceFile } from "./storage.mjs";

const failures = new WeakMap();
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function canonicalCompleteSources(sources) {
  return JSON.stringify(
    sources
      .toSorted((a, b) => a.traceID.localeCompare(b.traceID))
      .map((source) => ({
        ...source,
        spans: source.spans.toSorted((a, b) =>
          a.spanID.localeCompare(b.spanID),
        ),
      })),
  );
}

function freeze(value) {
  if (value && typeof value === "object") {
    assert(
      Array.isArray(value) ||
        Object.getPrototypeOf(value) === Object.prototype ||
        Object.getPrototypeOf(value) === null,
      "complete source context must contain only JSON data",
    );
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

function failure(message, cause) {
  const error = new Error(message);
  // Public errors carry no raw warning text or original cause. Only the private
  // archive writer can recover it; a copied code/name cannot forge the brand.
  failures.set(error, cause);
  return error;
}

export function assertCompleteSourceInputs(context, before) {
  try {
    assert.equal(
      JSON.stringify(context),
      before,
      "owning inspector changed complete source inputs",
    );
  } catch (cause) {
    throw failure("complete Trace source input changed", cause);
  }
}

export function assertCompleteSourceSnapshot(sources, expected) {
  try {
    assert.equal(
      canonicalCompleteSources(sources),
      canonicalCompleteSources(expected),
      "checked source snapshot differs from raw collection",
    );
  } catch (cause) {
    throw failure("complete Trace source snapshot changed", cause);
  }
}

// The hook can only inspect. Its snapshots cannot alter the collector, and
// retained references from the owning inspector cannot silently change inputs.
export async function checkCompleteSources(check, { signal, ...context }) {
  if (check === undefined) return;
  signal?.throwIfAborted();
  try {
    assert.equal(typeof check, "function");
    const before = JSON.stringify(context);
    const snapshot = freeze(structuredClone(context));
    const result = await check(Object.freeze({ ...snapshot, signal }));
    signal?.throwIfAborted();
    assert.equal(
      result,
      undefined,
      "complete source inspection cannot replace reports",
    );
    assert.equal(
      JSON.stringify(context),
      before,
      "complete source inspection changed inputs",
    );
    // Continue with these isolated values, never the owning inspector's retained
    // references. A later microtask must not change an already checked report.
    return snapshot;
  } catch (cause) {
    signal?.throwIfAborted();
    throw failure("complete Trace source inspection failed", cause);
  }
}

export function isCompleteSourceFailure(error) {
  return failures.has(error);
}

export function preserveCompleteSourceFailure(error, directory) {
  assert(isCompleteSourceFailure(error));
  writeEvidenceFile(
    directory,
    "complete-source-failure.private.txt",
    inspect(failures.get(error), { depth: 8 }) + "\n",
  );
}

// This receipt describes actual archived samples, not policy admission. It is
// produced only after the owning collector has completed its convergence gate.
export function createCompleteSourceReceipt(transport, directory, manifest) {
  try {
    return completeSourceReceipt(transport, directory, manifest);
  } catch (cause) {
    // A damaged archive is fatal, even if later Jaeger snapshots are clean.
    throw failure("complete Trace source receipt failed", cause);
  }
}

function completeSourceReceipt(transport, directory, manifest) {
  assert(["http", "websocket"].includes(transport));
  const samples = manifest.attempts.slice(-3);
  assert.equal(samples.length, 3);
  const last = samples.at(-1);
  assert.equal(
    new Set(manifest.queries.map((query) => query.file)).size,
    manifest.queries.length,
  );
  const files = new Set();
  const receipts = samples.map((sample, index) => {
    assert.equal(sample.status, "validated");
    assert(Number.isSafeInteger(sample.attempt) && sample.attempt > 0);
    if (index) assert.equal(sample.attempt, samples[index - 1].attempt + 1);
    assert.match(sample.snapshot_sha256, /^[a-f0-9]{64}$/u);
    assert.equal(sample.snapshot_sha256, last.snapshot_sha256);
    assert.equal(sample.source_snapshot_sha256, last.source_snapshot_sha256);
    assert.match(sample.source_snapshot_sha256, /^[a-f0-9]{64}$/u);
    assert.deepEqual(sample.source_trace_ids, last.source_trace_ids);
    assert(sample.source_trace_ids.length > 0);
    assert.equal(
      new Set(sample.source_trace_ids).size,
      sample.source_trace_ids.length,
    );
    const queries = manifest.queries.filter(
      (query) => query.attempt === sample.attempt,
    );
    assert(queries.length > 0);
    for (const query of queries) {
      assert.match(query.file, /^query-\d{4,}\.raw$/u);
      assert(!files.has(query.file));
      files.add(query.file);
      assert.equal(query.status, 200);
      assert.equal(query.outcome, "complete");
      assert.equal(query.body_complete, true);
      const bytes = readFileSync(evidenceFilePath(directory, query.file));
      assert.equal(bytes.length, query.bytes);
      assert.equal(hash(bytes), query.sha256);
    }
    return {
      attempt: sample.attempt,
      snapshot_sha256: sample.snapshot_sha256,
      source_snapshot_sha256: sample.source_snapshot_sha256,
      source_trace_ids: [...sample.source_trace_ids],
      queries: structuredClone(queries),
    };
  });
  return {
    version: 1,
    transport,
    stable_samples: 3,
    source_trace_ids: [...last.source_trace_ids],
    source_snapshot_sha256: last.source_snapshot_sha256,
    samples: receipts,
  };
}
