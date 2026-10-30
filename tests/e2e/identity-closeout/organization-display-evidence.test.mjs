import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectOrganizationDisplayEvidence } from "./organization-display-evidence.mjs";

const reads = () =>
  ["session", "bootstrap", "ssr"].flatMap((surface) =>
    ["continuous", "expiry"].map((mode) => ({
      surface,
      mode,
      phase: "expired",
      startedMS: 11000,
      status: 200,
      snapshot: "renamed",
      cookie_unchanged: true,
      identity_scope_unchanged: true,
    })),
  );

test("Trace failure retains evidence and permits subsequent business checks", async (t) => {
  const directory = mkdtempSync(
    join(tmpdir(), "organization-display-evidence-"),
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const result = await collectOrganizationDisplayEvidence({
    record: { ttlMS: 10000, renameCommittedMS: 1000, reads: reads() },
    directory,
    collect: async () => {
      throw new Error("missing display span");
    },
  });
  assert.equal(result.timeline.ttl_ms, 10000);
  assert.equal(result.diagnostics.status, "warning");
  assert.equal(result.reads.length, 6);
  assert.deepEqual(result.resolutions, []);
  const summary = JSON.parse(
    readFileSync(join(directory, result.diagnostics.evidence)),
  );
  assert.equal(summary.checks[0].status, "failed");
  assert.match(
    readFileSync(join(directory, summary.checks[0].failure_evidence), "utf8"),
    /missing display span/,
  );
});

test("successful Trace evidence remains attached to passed HTTP freshness", async (t) => {
  const directory = mkdtempSync(
    join(tmpdir(), "organization-display-evidence-"),
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const resolutions = [{ trace_id: "synthetic", strict_trace: "passed" }];
  const result = await collectOrganizationDisplayEvidence({
    record: { ttlMS: 10000, renameCommittedMS: 1000, reads: reads() },
    directory,
    collect: async () => ({ resolutions }),
  });
  assert.deepEqual(result.resolutions, resolutions);
  assert.equal(result.diagnostics.status, "passed");
});

for (const fault of [
  "stale",
  "failed request",
  "changed identity",
  "missing surface",
]) {
  test(`${fault} remains a business failure when Trace is unavailable`, async (t) => {
    const directory = mkdtempSync(
      join(tmpdir(), "organization-display-evidence-"),
    );
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const rows = reads();
    if (fault === "stale") rows[0].snapshot = "original";
    if (fault === "failed request") rows[0].status = 503;
    if (fault === "changed identity") rows[0].identity_scope_unchanged = false;
    if (fault === "missing surface") rows.pop();
    await assert.rejects(
      collectOrganizationDisplayEvidence({
        record: { ttlMS: 10000, renameCommittedMS: 1000, reads: rows },
        directory,
        collect: async () => {
          throw new Error("Trace unavailable");
        },
      }),
      assert.AssertionError,
    );
  });
}
