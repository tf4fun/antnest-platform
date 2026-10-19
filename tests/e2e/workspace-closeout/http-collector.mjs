import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { inspect as describe } from "node:util";
import {
  evidenceDirectory,
  writeEvidenceFile,
} from "../../support/storage.mjs";
import {
  canonicalCompleteSources,
  checkCompleteSources,
  assertCompleteSourceInputs,
  createCompleteSourceReceipt,
  isCompleteSourceFailure,
  preserveCompleteSourceFailure,
} from "../../support/complete-source-inspection.mjs";
import {
  collectResolveTraceEvidence,
  resolveTraceSources,
} from "../../support/gateway-resolution-evidence.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const encode = (value) => JSON.stringify(value, null, 2) + "\n";

// Keep the common complete-source convergence implementation, and archive each
// original HTTP query before inspection. The resulting receipt is byte-bound to
// the three actual consecutive complete samples, including late diagnostics.
export async function collectWorkspaceHTTPTrace(
  base,
  originalExpected,
  options,
  inspector,
) {
  const { flush, secrets = [], request = fetch, ...collection } = options;
  assert.equal(
    typeof flush,
    "function",
    "original Workspace CLIENT flush required",
  );
  await flush();
  const expected = structuredClone(originalExpected),
    attempts = collection.attempts ?? 40;
  assert(Number.isSafeInteger(attempts) && attempts >= 3 && attempts <= 40);
  const directory = evidenceDirectory(collection.directory);
  assert(directory, "Workspace source archive required");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const archive = mkdtempSync(join(directory, "workspace-http-"));
  const manifest = {
    status: "collecting",
    trace_id: expected.traceID,
    queries: [],
    attempts: [],
  };
  const errors = [],
    archiveErrors = [];
  const archiveWrite = (name, contents) => {
    try {
      writeEvidenceFile(archive, name, contents);
    } catch (error) {
      errors.push(error);
      archiveErrors.push(error);
      throw error;
    }
  };
  const save = () => archiveWrite("manifest.json", encode(manifest));
  save();
  let sequence = 0;
  const rootAddress = `${base.replace(/\/$/u, "")}/api/traces/${expected.traceID}`;
  try {
    const [report] = await collectResolveTraceEvidence(
      base,
      [expected],
      secrets,
      {
        ...collection,
        directory: archive,
        attempts,
        async request(address, settings) {
          if (address === rootAddress)
            manifest.attempts.push({
              attempt: manifest.attempts.length + 1,
              status: "collecting",
            });
          const sample = manifest.attempts.at(-1);
          assert(sample, "Workspace source query precedes its root sample");
          const index = ++sequence;
          const row = {
            attempt: sample.attempt,
            file: `query-${String(index).padStart(4, "0")}.raw`,
            address,
            outcome: "pending",
          };
          manifest.queries.push(row);
          try {
            const response = await request(address, settings);
            row.status = response.status;
            const raw = Buffer.from(await response.arrayBuffer());
            archiveWrite(row.file, raw);
            Object.assign(row, {
              outcome: "complete",
              body_complete: true,
              bytes: raw.length,
              sha256: hash(raw),
            });
            save();
            return new Response(raw, {
              status: response.status,
              headers: response.headers,
            });
          } catch (error) {
            errors.push(error);
            Object.assign(row, {
              outcome: "failed",
              error: describe(error, { depth: 8 }),
            });
            try {
              save();
            } catch {
              // archiveWrite retained the independent archive error.
            }
            throw error;
          }
        },
        async inspect(trace, bound, privacy, sourceOptions) {
          const sample = manifest.attempts.at(-1);
          try {
            const sources = resolveTraceSources(trace, privacy, sourceOptions);
            const before = JSON.stringify({ sources, bound });
            const report = await inspector(
              trace,
              bound,
              privacy,
              sourceOptions,
            );
            assertCompleteSourceInputs({ sources, bound }, before);
            const checked = await checkCompleteSources(() => {}, {
              expected: bound,
              sources,
              reports: [report],
              signal: collection.signal,
            });
            const canonical = canonicalCompleteSources(checked.sources);
            Object.assign(sample, {
              status: "validated",
              source_trace_ids: checked.sources
                .map((source) => source.traceID)
                .sort(),
              source_snapshot_sha256: hash(canonical),
              snapshot_sha256: hash(
                JSON.stringify({
                  sources: JSON.parse(canonical),
                  reports: checked.reports,
                }),
              ),
            });
            save();
            return checked.reports[0];
          } catch (error) {
            errors.push(error);
            Object.assign(sample, {
              status: "failed",
              error: describe(error, { depth: 8 }),
            });
            try {
              save();
            } catch {
              // Keep the inspector error and the independent archive error.
            }
            throw error;
          }
        },
      },
    );
    // Later complete exports may replace a partial inspection, but cannot
    // repair an archive failure from an earlier original sample.
    if (archiveErrors.length) throw archiveErrors[0];
    const result = {
      ...report,
      evidence_directory: archive,
      complete_source_receipt: createCompleteSourceReceipt(
        "http",
        archive,
        manifest,
      ),
    };
    manifest.status = "collected";
    save();
    archiveWrite("result.json", encode(result));
    return result;
  } catch (error) {
    errors.push(error);
    manifest.status = "failed";
    manifest.failure = describe(error, { depth: 8 });
    if (isCompleteSourceFailure(error)) {
      try {
        preserveCompleteSourceFailure(error, archive);
      } catch (archiveError) {
        errors.push(archiveError);
      }
    }
    try {
      save();
    } catch {
      // archiveWrite retained the original archive error.
    }
    const unique = [...new Set(errors)];
    if (unique.length === 1) throw unique[0];
    throw new AggregateError(
      unique,
      "Workspace source collection and archive failed",
    );
  }
}
