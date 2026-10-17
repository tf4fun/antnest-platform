import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { inspect } from "node:util";
import {
  evidenceDirectory,
  writeEvidenceFile,
} from "../../support/storage.mjs";
import {
  collectLifecycleAdmissionTrace,
  inspectLifecycle,
} from "../stage3-base/trace.mjs";

const combined = (errors) =>
  errors.length === 1
    ? errors[0]
    : new AggregateError(errors, "Persistence Lifecycle collection errors");
const remember = (errors, error) => {
  if (!errors.includes(error)) errors.push(error);
};

// The shared Lifecycle collector owns topology and complete source convergence.
// This adapter retains the original bytes of every main/Resolve HTTP response.
export async function collectPersistenceLifecycleTrace(
  base,
  expected,
  options = {},
) {
  expected = structuredClone(expected);
  assert(["create", "delete"].includes(expected.kind));
  assert.match(expected.traceID, /^[a-f0-9]{32}$/u);
  const { request = fetch, signal, secrets = [], flush } = options;
  assert.equal(typeof flush, "function");
  signal?.throwIfAborted();
  const directory = evidenceDirectory(options.directory);
  assert(directory, "Persistence Lifecycle evidence directory required");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const archive = mkdtempSync(
    join(directory, `persistence-${expected.kind}-${expected.traceID}-`),
  );
  const manifest = {
    trace_id: expected.traceID,
    outcome: "collecting",
    queries: [],
  };
  const failures = [];
  const save = () =>
    writeEvidenceFile(
      archive,
      "manifest.private.json",
      JSON.stringify(manifest) + "\n",
    );
  const archivedRequest = async (address, init = {}) => {
    const query = {
      url: String(address),
      file: `query-${String(manifest.queries.length + 1).padStart(4, "0")}.raw`,
      status: null,
      outcome: "pending",
      body_complete: false,
    };
    manifest.queries.push(query);
    const errors = [];
    let bytes = Buffer.alloc(0),
      reader,
      cancellation;
    let response;
    const preserve = () => {
      writeEvidenceFile(archive, query.file, bytes);
      Object.assign(query, {
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
      save();
    };
    const cancel = () => {
      if (reader)
        cancellation ??= Promise.resolve()
          .then(() => reader.cancel())
          .catch((error) => remember(errors, error));
      return cancellation;
    };
    const abort = () => {
      remember(errors, init.signal.reason);
      void cancel();
    };
    try {
      preserve();
      init.signal?.throwIfAborted();
      response = await request(address, init);
      query.status = response.status;
      // Own the response body before any archive operation can fail.
      reader = response.body?.getReader();
      init.signal?.addEventListener("abort", abort, { once: true });
      if (init.signal?.aborted) abort();
      init.signal?.throwIfAborted();
      preserve();
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
    } catch (error) {
      remember(errors, error);
    } finally {
      init.signal?.removeEventListener("abort", abort);
      if (!query.body_complete) await cancel();
      try {
        reader?.releaseLock();
      } catch (error) {
        remember(errors, error);
      }
      query.outcome = errors.length
        ? init.signal?.aborted
          ? "aborted"
          : "failed"
        : "complete";
      try {
        preserve();
      } catch (error) {
        remember(errors, error);
      }
    }
    if (errors.length) {
      query.outcome = init.signal?.aborted ? "aborted" : "failed";
      try {
        save();
      } catch (error) {
        remember(errors, error);
      }
      try {
        writeEvidenceFile(
          archive,
          query.file + ".failure.private.txt",
          inspect(combined(errors), { depth: 16 }) + "\n",
        );
      } catch (error) {
        remember(errors, error);
      }
      // The shared collector emits safe summaries. Retain the actual request
      // failures here so its summary cannot replace read or cleanup errors.
      const failure = combined(errors);
      remember(failures, failure);
      throw failure;
    }
    return {
      status: response.status,
      text: async () => bytes.toString("utf8"),
    };
  };
  let result;
  try {
    save();
    await flush();
    signal?.throwIfAborted();
    result = await collectLifecycleAdmissionTrace(base, expected, secrets, {
      ...options,
      directory: archive,
      request: archivedRequest,
      inspect: inspectLifecycle,
    });
    signal?.throwIfAborted();
    manifest.outcome = "complete";
    save();
  } catch (error) {
    remember(failures, error);
    if (signal?.aborted) remember(failures, signal.reason);
  }
  if (failures.length) {
    manifest.outcome = signal?.aborted ? "aborted" : "failed";
    try {
      save();
    } catch (error) {
      remember(failures, error);
    }
    try {
      writeEvidenceFile(
        archive,
        "failure.private.txt",
        inspect(combined(failures), { depth: 16 }) + "\n",
      );
    } catch (error) {
      remember(failures, error);
    }
    throw new Error("Persistence Lifecycle collection failed", {
      cause: combined(failures),
    });
  }
  return { ...result, raw_evidence_directory: archive };
}
