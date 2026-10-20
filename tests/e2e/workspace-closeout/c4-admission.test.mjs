import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { c4RunTraceFixture } from "./c4-run-trace.fixture.mjs";
import { collectC4Trace } from "./c4-collection.mjs";

const url = new URL("./c4-admission.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
async function collected(t) {
  const f = c4RunTraceFixture("unsupported-audio");
  const directory = mkdtempSync(join(tmpdir(), "antnest-c4-admission-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const inventory = [f.expected];
  const report = structuredClone(
    await collectC4Trace("http://jaeger.test", f.expected, {
      inventory,
      directory,
      attempts: 3,
      wait: async () => {},
      flush: async () => {},
      request: async () => Response.json({ data: [f.trace] }),
    }),
  );
  return { inventory, reports: [report], report };
}
test("C4 source admission rechecks owning logic, original bytes and all stable samples", async (t) => {
  assert.equal(typeof implementation.assertC4CollectedSources, "function");
  const f = await collected(t);
  const outcome = implementation.assertC4CollectedSources(
    f.inventory,
    f.reports,
  );
  assert.equal(outcome.accepted, true);
  assert.equal(outcome.exit_code, 2);
  assert.equal(f.report.strict_trace, "failed");
  assert.equal(f.report.error_spans, 3);
});
for (const [name, change] of [
  [
    "missing complete receipt",
    (f) => {
      delete f.report.complete_source_receipt;
    },
  ],
  [
    "missing original source",
    (f) => {
      f.report.original_sources = [];
    },
  ],
  [
    "changed raw diagnostics",
    (f) => {
      f.report.original_sources[0].spans[0].tags.push({
        key: "error.type",
        value: "new-error",
      });
    },
  ],
  [
    "invented owning claim",
    (f) => {
      f.report.owned_error_spans[0].reason = "unowned";
    },
  ],
  [
    "rewritten raw count",
    (f) => {
      f.report.error_spans = 0;
    },
  ],
  [
    "rewritten strict verdict",
    (f) => {
      f.report.strict_trace = "passed";
    },
  ],
  [
    "changed archived bytes",
    (f) => {
      writeFileSync(
        join(
          f.report.evidence_directory,
          f.report.complete_source_receipt.samples[0].queries[0].file,
        ),
        "changed original bytes",
      );
    },
  ],
  [
    "nonconsecutive samples",
    (f) => {
      f.report.complete_source_receipt.samples[1].attempt += 20;
    },
  ],
  [
    "duplicate root",
    (f) => {
      f.reports.push(f.report);
    },
  ],
  [
    "different original Prompt",
    (f) => {
      f.inventory[0].runId = "foreign-run";
    },
  ],
])
  test(`C4 source admission rejects ${name}`, async (t) => {
    assert.equal(typeof implementation.assertC4CollectedSources, "function");
    const f = await collected(t);
    change(f);
    assert.throws(() =>
      implementation.assertC4CollectedSources(f.inventory, f.reports),
    );
  });
