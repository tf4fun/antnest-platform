import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { inspect } from "node:util";
import {
  evidenceDirectory,
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

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
// Detailed original failures are private archive data, never public errors.
const collectionFailure = () => new Error("Cost pricing collection failed");

// Pricing can include Controller publication to ACP. Its complete closure
// still requires zero diagnostics; private ACP cancellation/timing ownership
// does not grant an exception to this pricing gate.
export function costStrictOutcome(acp, pricing) {
  try {
    assert(Array.isArray(acp) && acp.length > 0);
    assert(Array.isArray(pricing) && pricing.length > 0);
    for (const result of pricing) {
      assert.equal(result.pricing_trace_verified, true);
      assert.equal(result.strict_trace, "passed");
      assert.equal(result.error_spans, 0);
      assert.equal(result.warning_count, 0);
      assert.deepEqual(result.warnings, []);
    }
    assert.equal(privateACPStrictOutcome(pricing, new Set()).accepted, true);
    return privateCostStrictOutcome(acp);
  } catch {
    return { strict_trace: "failed", accepted: false, exit_code: 1 };
  }
}

export async function collectCostPricingTrace(base, expected, options = {}) {
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
    return { ...result, raw_evidence_directory: archive };
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
