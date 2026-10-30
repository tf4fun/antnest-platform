import assert from "node:assert/strict";
import { createTraceDiagnostics } from "../../support/trace-diagnostics.mjs";
import { displaySurfaces } from "./organization-freshness.mjs";

export async function collectOrganizationDisplayEvidence({
  record,
  directory,
  collect,
  diagnostics = createTraceDiagnostics({ directory }),
}) {
  assert(Number.isFinite(record.ttlMS) && record.ttlMS > 0);
  assert(Number.isFinite(record.renameCommittedMS));
  // Actual HTTP responses establish freshness and identity even when the
  // auxiliary collector cannot prove cache source or Span relationships.
  for (const surface of Object.keys(displaySurfaces)) {
    for (const mode of ["continuous", "expiry"]) {
      const expired = record.reads.filter(
        (row) =>
          row.surface === surface &&
          row.mode === mode &&
          row.phase === "expired",
      );
      assert(expired.length > 0, "expired Organization display read missing");
      for (const row of expired) {
        assert(row.startedMS >= record.renameCommittedMS + record.ttlMS);
        assert.equal(row.status, 200);
        assert.equal(
          row.snapshot,
          "renamed",
          "Organization display remained stale after TTL",
        );
        assert.equal(row.cookie_unchanged, true);
        assert.equal(row.identity_scope_unchanged, true);
      }
    }
  }
  const trace = await diagnostics.run(
    "organization-display-freshness",
    collect,
  );
  return {
    timeline: { ttl_ms: record.ttlMS },
    feed_coverage: null,
    reads: record.reads,
    resolutions: [],
    feeds: [],
    refreshes: [],
    ...(trace.status === "passed" ? trace.value : {}),
    diagnostics: diagnostics.summary(),
  };
}
