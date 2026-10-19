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
import { collectPrivateACPConsumerTrace } from "../acp-commands/collector.mjs";
import { inspectPrivateCommandTrace } from "../acp-commands/trace.mjs";
import { inspectPrivateManagedTrace } from "../managed-mcp/request-trace.mjs";
import {
  inspectProgressBarrierTrace,
  inspectProgressCancelTrace,
} from "../acp-progress/control-trace.mjs";
import { collectPrivateACPNotificationTrace } from "../identity-closeout/private-acp-trace.mjs";
import { assertRuntimeBinding } from "../acp-restart/trace.mjs";
import { privateACPDiagnosticInventory } from "../observability/private-acp-inventory.mjs";
import { workspacePrivateErrorReasons as reasons } from "./private-diagnostics.mjs";
export { workspacePrivateTraceOutcome } from "./private-diagnostics.mjs";
import { inspectWorkspaceDisconnectedTrace } from "./private-disconnect-trace.mjs";
import { inspectWorkspaceAccessDeniedTrace } from "./private-denial-trace.mjs";
import { inspectWorkspaceStateTrace } from "./private-http-trace.mjs";
import { inspectWorkspaceAuthorityTrace } from "./private-authority-trace.mjs";
import { inspectWorkspaceOffboardingTrace } from "./private-offboarding-trace.mjs";

export async function inspectWorkspacePrivateRequest(
  trace,
  expected,
  secrets = [],
  requests = [],
  options = {},
) {
  assert.equal(expected.boundary, "private-acp");
  assert.equal(expected.transport, "websocket");
  assert.equal(expected.protocolVersion, 1);
  assert(["request", "ordinary", "cancelled"].includes(expected.kind));
  let result;
  if (["c4-cancel", "c4-offline"].includes(expected.phase))
    result = await inspectWorkspaceDisconnectedTrace(
      trace,
      expected,
      secrets,
      requests,
      { receipt: options.receipt },
    );
  else if (expected.rejection === "runtime_barrier_required")
    result = inspectProgressBarrierTrace(trace, expected, secrets, requests);
  else if (expected.rejection === "agent_busy")
    result = inspectPrivateManagedTrace(trace, expected, secrets, requests);
  else if (expected.rejection === "access_denied")
    result = inspectWorkspaceAccessDeniedTrace(
      trace,
      expected,
      secrets,
      requests,
    );
  else {
    assert(expected.phase === undefined || expected.phase === "c4-rebuilt");
    assert.equal(expected.rejection, undefined);
    result = inspectPrivateCommandTrace(trace, expected, secrets, requests);
  }
  if (expected.phase || expected.runId) {
    assert.equal(
      result.run_id,
      expected.runId,
      "Workspace Trace uses another Run",
    );
    assert(
      expected.runId && expected.run && expected.runtime,
      "original Workspace Run and Runtime required",
    );
    assertRuntimeBinding(trace, expected.run, expected.runtime);
  }
  for (const [key, value] of Object.entries({
    kind: expected.kind,
    method: expected.method,
    request_id: expected.requestId,
    connection_trace_id: expected.connectionTraceID,
    ...(expected.sessionId ? { session_id: expected.sessionId } : {}),
  })) {
    if (Object.hasOwn(result, key))
      assert.equal(result[key], value, "Workspace report identity differs");
    result[key] = value;
  }
  return result;
}

export async function collectWorkspacePrivateRequest(
  base,
  expected,
  options,
  sidecar = {},
) {
  // The original WeakMap receipt stays outside any generic expectation clone.
  const failures = [];
  try {
    return await collectPrivateACPConsumerTrace(base, expected, options, {
      inspect: async (trace, bound, secrets, requests) => {
        try {
          return await inspectWorkspacePrivateRequest(
            trace,
            bound,
            secrets,
            requests,
            sidecar,
          );
        } catch (error) {
          failures.push(error);
          throw error;
        }
      },
      ownedReasons: reasons,
      inspectCompleteSources: () => {},
    });
  } catch (error) {
    if (!failures.length) throw error;
    // The shared convergence collector keeps raw attempts but replaces the
    // owning error. Retain originals for the Workspace private failure archive.
    throw new AggregateError(
      [error, ...failures],
      "Workspace request Trace collection failed",
    );
  }
}
export function collectWorkspacePrivateNotification(base, receipt, options) {
  return collectPrivateACPNotificationTrace(base, receipt, {
    ...options,
    inspect: (trace, bound, secrets) =>
      inspectWorkspacePrivateNotification(
        trace,
        receipt,
        bound.connectionTrace,
        secrets,
      ),
  });
}
export function inspectWorkspacePrivateNotification(
  trace,
  receipt,
  connectionTrace,
  secrets = [],
) {
  const result = inspectProgressCancelTrace(
    trace,
    receipt,
    connectionTrace,
    secrets,
  );
  return {
    ...result,
    ...privateACPDiagnosticInventory(
      [trace, connectionTrace],
      [result],
      new Set(),
    ),
    kind: "notification",
    method: receipt.method,
    session_id: receipt.sessionId,
    connection_trace_id: receipt.connectionTraceID,
  };
}
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const encode = (value) => JSON.stringify(value, null, 2) + "\n";

// Keep the common complete-source convergence implementation, and archive each
// original HTTP query before inspection. The resulting receipt is byte-bound to
// the three actual consecutive complete samples, including late diagnostics.
async function collectHTTP(base, originalExpected, options, inspector) {
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
          const index = ++sequence;
          const row = {
            attempt: index,
            file: `query-${String(index).padStart(4, "0")}.raw`,
            address,
            outcome: "pending",
          };
          manifest.queries.push(row);
          manifest.attempts.push({ attempt: index, status: "collecting" });
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
export { collectHTTP as collectWorkspaceHTTPTrace };
export const collectWorkspacePrivateHTTP = (base, expected, options) =>
  collectHTTP(base, expected, options, inspectWorkspaceStateTrace);
export const collectWorkspaceAuthorityTrace = (base, expected, options) =>
  collectHTTP(base, expected, options, inspectWorkspaceAuthorityTrace);

export async function collectWorkspaceOffboarding(
  config,
  expected,
  secrets,
  signal,
) {
  const [result] = await collectResolveTraceEvidence(
    config.jaeger,
    [expected],
    secrets,
    {
      directory: config.evidence + "/traces",
      signal,
      inspect: (trace, bound, privacy, sources) =>
        inspectWorkspaceOffboardingTrace(
          resolveTraceSources(trace, privacy, sources),
          bound,
          privacy,
        ),
    },
  );
  return result;
}
