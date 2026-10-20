import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { evidenceFilePath } from "../../support/storage.mjs";
import {
  canonicalCompleteSources,
  createCompleteSourceReceipt,
} from "../../support/complete-source-inspection.mjs";
import { inspectC4TraceSources, c4TraceOutcome } from "./c4-collection.mjs";

export function assertC4CollectedSources(inventory, reports, secrets = []) {
  assert(inventory.length > 0);
  assert.equal(
    new Set(inventory.map((row) => row.traceID)).size,
    inventory.length,
  );
  assert.equal(
    reports.length,
    inventory.length,
    "complete C4 trace inventory required",
  );
  assert.equal(
    new Set(reports.map((row) => row.trace_id)).size,
    reports.length,
  );
  for (const row of inventory) {
    const result = reports.find((item) => item.trace_id === row.traceID);
    assert(result, "original C4 trace result missing");
    assert([undefined, "passed"].includes(result.topology));
    assert(Array.isArray(result.original_sources));
    const traces = new Map(
      result.original_sources.map((source) => [source.traceID, source]),
    );
    assert.equal(traces.size, result.original_sources.length);
    const trace = traces.get(row.traceID);
    assert(trace, "original C4 root source missing");
    const checked = inspectC4TraceSources(
      trace,
      row,
      secrets,
      { traces, archivedTraceIDs: new Set(traces.keys()) },
      inventory,
    );
    for (const [field, value] of Object.entries(checked))
      assert.deepEqual(
        result[field],
        value,
        `C4 collected ${field} differs from original sources`,
      );
    const directory = result.evidence_directory;
    const manifest = JSON.parse(
      readFileSync(evidenceFilePath(directory, "manifest.json"), "utf8"),
    );
    assert.equal(manifest.status, "collected");
    assert.equal(manifest.trace_id, row.traceID);
    const receipt = createCompleteSourceReceipt("http", directory, manifest);
    assert.deepEqual(result.complete_source_receipt, receipt);
    assert.equal(
      receipt.source_snapshot_sha256,
      checked.source_snapshot_sha256,
    );
    assert.deepEqual(new Set(receipt.source_trace_ids), new Set(traces.keys()));
    for (const sample of receipt.samples) {
      const original = new Map();
      for (const query of sample.queries) {
        const bytes = readFileSync(evidenceFilePath(directory, query.file));
        const body = JSON.parse(new TextDecoder().decode(bytes));
        assert(
          body.errors == null ||
            (Array.isArray(body.errors) && body.errors.length === 0),
        );
        assert.equal(body.data?.length, 1);
        const source = body.data[0];
        assert(
          !original.has(source.traceID),
          "repeated source in one C4 sample",
        );
        original.set(source.traceID, source);
      }
      assert.equal(
        canonicalCompleteSources([...original.values()]),
        canonicalCompleteSources(result.original_sources),
        "C4 sample differs from archived original sources",
      );
    }
  }
  const outcome = c4TraceOutcome(reports);
  assert.equal(outcome.accepted, true, "unowned C4 strict findings");
  return outcome;
}
