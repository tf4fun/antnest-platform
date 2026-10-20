import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { searchJaegerTraces } from "../../support/jaeger-search.mjs";
import { collectResolutionSources } from "../../support/gateway-resolution-collect.mjs";
import { resolveTraceDiagnostics } from "../../support/gateway-resolution-evidence.mjs";
import {
  evidenceDirectory,
  shellStoragePreflight,
  writeEvidenceFile,
} from "../../support/storage.mjs";
import { assertSecretFree } from "./evidence.mjs";
import { inspectBridgeSessionClosure } from "./bridge-session-cause.mjs";

const idPattern = /^[a-f0-9]{32}$/u;
const encode = (value) => JSON.stringify(value, null, 2) + "\n";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const snapshot = (traces) =>
  traces
    .toSorted((a, b) => a.traceID.localeCompare(b.traceID))
    .map((trace) => ({
      ...trace,
      spans: trace.spans.toSorted((a, b) => a.spanID.localeCompare(b.spanID)),
    }));
const searches = [
  ["close", "agent-ui", "agent_ui.acp.close", {}],
  [
    "deletion",
    "agent-acp-service",
    "HTTP DELETE /v1/acp",
    {
      "span.kind": "server",
      "http.request.method": "DELETE",
      "http.route": "/v1/acp",
      "antnest.listener": "workspace",
    },
  ],
  [
    "health",
    "agent-acp-service",
    "HTTP GET /status",
    {
      "span.kind": "server",
      "http.request.method": "GET",
      "http.route": "/status",
      "antnest.listener": "control",
    },
  ],
];

// One shared collection retains every original observation and independent
// cleanup query before any individual cause can stop admission. Raw error
// counts and failed query bodies remain evidence, including on failure.
export async function collectBridgeSessionOwnerEvidence(
  base,
  context,
  secrets = [],
  {
    directory = process.env.ANTNEST_IDENTITY_EVIDENCE_DIR,
    signal,
    request = fetch,
    wait = delay,
    attempts = 40,
  } = {},
) {
  let archive,
    manifest,
    phase = "configuration";
  const describe = (error) => {
    const message = String(error?.message ?? "collection failed");
    try {
      assertSecretFree(message, secrets);
      return message.slice(0, 1000);
    } catch {
      return "private diagnostic redacted";
    }
  };
  const save = () =>
    writeEvidenceFile(archive, "manifest.json", encode(manifest));
  try {
    signal?.throwIfAborted();
    directory = evidenceDirectory(directory);
    assert(directory, "Session owner evidence directory required");
    shellStoragePreflight(directory);
    assert(Number.isSafeInteger(attempts) && attempts >= 3 && attempts <= 40);
    const endpoint = new URL(base);
    assert(
      ["http:", "https:"].includes(endpoint.protocol) &&
        !endpoint.username &&
        !endpoint.password &&
        !endpoint.search &&
        !endpoint.hash,
    );
    context = structuredClone(context);
    assert(
      Array.isArray(context.closures) &&
        context.closures.length > 0 &&
        context.closures.length <= 64,
    );
    assert.equal(
      new Set(context.closures.map((row) => row.traceID)).size,
      context.closures.length,
      "duplicate Session observation",
    );
    const seedIDs = new Set(
      context.closures.flatMap((expected) => [
        expected.traceID,
        expected.denial.traceID,
        ...(expected.reason === "revoked" ? [expected.cause.traceID] : []),
        ...(expected.reason === "expired"
          ? [expected.checkpoint.issuance.traceID]
          : []),
      ]),
    );
    for (const id of seedIDs) assert.match(id ?? "", idPattern);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    archive = mkdtempSync(join(directory, "session-owner-"));
    const now = Date.now();
    manifest = {
      status: "collecting",
      seed_trace_ids: [...seedIDs],
      search_now_ms: now,
      queries: [],
      attempts: [],
    };
    save();
    const observations = encode(context);
    assertSecretFree(observations, secrets);
    writeEvidenceFile(archive, "observations.json", observations);
    const rounds = { close: [], deletion: [], health: [] };
    let previous,
      stable = 0;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      signal?.throwIfAborted();
      const receipt = {
        attempt,
        directory: `round-${String(attempt).padStart(3, "0")}`,
        status: "collecting",
        errors: [],
      };
      manifest.attempts.push(receipt);
      const roundDirectory = join(archive, receipt.directory);
      mkdirSync(roundDirectory, { mode: 0o700 });
      save();
      const archivedRequest = async (url, options = {}) => {
        signal?.throwIfAborted();
        const requestSignal = AbortSignal.any(
          [signal, options.signal, AbortSignal.timeout(10000)].filter(Boolean),
        );
        const query = {
          attempt,
          url: String(url),
          status: null,
          file: `query-${String(manifest.queries.length + 1).padStart(5, "0")}.raw`,
          started_at_ms: Date.now(),
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
          requestSignal.throwIfAborted();
          const response = await request(url, {
            ...options,
            signal: requestSignal,
          });
          query.status = response.status;
          preserve();
          reader = response.body?.getReader();
          requestSignal.addEventListener("abort", cancel, { once: true });
          if (requestSignal.aborted) cancel();
          requestSignal.throwIfAborted();
          if (reader)
            for (;;) {
              const chunk = await reader.read();
              if (chunk.value !== undefined) {
                bytes = Buffer.concat([bytes, Buffer.from(chunk.value)]);
                preserve();
              }
              requestSignal.throwIfAborted();
              if (chunk.done) break;
            }
          query.body_complete = true;
          query.outcome = "complete";
          return {
            status: response.status,
            ok: response.ok,
            text: async () => bytes.toString("utf8"),
            json: async () => JSON.parse(bytes.toString("utf8")),
          };
        } catch {
          query.outcome = requestSignal.aborted ? "aborted" : "failed";
          throw new Error("Session raw response was incomplete");
        } finally {
          requestSignal.removeEventListener("abort", cancel);
          if (!query.body_complete) await cancel();
          reader?.releaseLock();
          query.finished_at_ms = Date.now();
          preserve();
        }
      };
      const initial = new Map(),
        conflicts = [],
        missing = [];
      const retain = (trace) => {
        assert.match(trace?.traceID ?? "", idPattern);
        assert(
          initial.has(trace.traceID) || initial.size < 128,
          "Session source inventory limit exceeded",
        );
        const prior = initial.get(trace.traceID);
        if (
          prior &&
          JSON.stringify(snapshot([prior])) !==
            JSON.stringify(snapshot([trace]))
        )
          conflicts.push(trace.traceID);
        initial.set(trace.traceID, trace);
      };
      const fetchTrace = async (id) => {
        const response = await archivedRequest(
          new URL(`/api/traces/${id}`, base),
        );
        if (response.status === 404) {
          missing.push(id);
          return;
        }
        assert.equal(response.status, 200, "Session raw trace request failed");
        const body = await response.json();
        assert(
          body.errors == null ||
            (Array.isArray(body.errors) && body.errors.length === 0),
          "Session raw backend errors",
        );
        assert(
          Array.isArray(body.data) && body.data.length <= 1,
          "invalid Session trace response",
        );
        if (!body.data.length) {
          missing.push(id);
          return;
        }
        assert.equal(
          body.data[0].traceID,
          id,
          "Session raw trace identity differs",
        );
        retain(body.data[0]);
      };
      phase = "original_queries";
      for (const id of seedIDs) {
        try {
          await fetchTrace(id);
        } catch (error) {
          signal?.throwIfAborted();
          receipt.errors.push({ source: id, message: describe(error) });
        }
      }
      const found = {};
      phase = "independent_queries";
      for (const [name, service, operation, tags] of searches) {
        try {
          found[name] = await searchJaegerTraces(
            base,
            new URLSearchParams({
              service,
              operation,
              lookback: "1h",
              limit: "500",
              tags: JSON.stringify(tags),
            }),
            { now, signal, fetchImpl: archivedRequest },
          );
        } catch (error) {
          signal?.throwIfAborted();
          receipt.errors.push({ search: name, message: describe(error) });
          found[name] = [];
        }
        rounds[name].push(found[name]);
        for (const trace of found[name]) retain(trace);
      }
      const links = new Set(
        (found.close ?? []).flatMap((trace) =>
          trace.spans.flatMap((span) =>
            span.operationName === "agent_ui.acp.close"
              ? (span.references ?? [])
                  .filter((ref) => ref.refType === "FOLLOWS_FROM")
                  .map((ref) => ref.traceID)
              : [],
          ),
        ),
      );
      for (const id of links) {
        assert.match(id ?? "", idPattern, "invalid Session owner Link");
        if (!initial.has(id)) {
          try {
            await fetchTrace(id);
          } catch (error) {
            signal?.throwIfAborted();
            receipt.errors.push({ source: id, message: describe(error) });
          }
        }
      }
      phase = "raw_archive";
      for (const trace of initial.values())
        writeEvidenceFile(
          roundDirectory,
          trace.traceID + ".json",
          encode(trace),
        );
      writeEvidenceFile(
        roundDirectory,
        "searches.json",
        encode({ found, errors: receipt.errors }),
      );
      save();
      phase = "query_completion";
      assert.equal(
        receipt.errors.length,
        0,
        "Session independent collection failed",
      );
      let collection;
      if (!missing.length && !conflicts.length) {
        phase = "resolution_sources";
        try {
          collection = await collectResolutionSources(
            base,
            [...initial.values()],
            { request: archivedRequest, signal, directory: roundDirectory },
          );
          signal?.throwIfAborted();
        } catch (error) {
          signal?.throwIfAborted();
          if (
            (error.code && error.code !== "ERR_ASSERTION") ||
            /evidence|durable|cache alias/u.test(error.message)
          )
            throw error;
          receipt.source_error = describe(error);
        }
      }
      if (collection) {
        Object.assign(collection, {
          sessionOwnerContext: context,
          cleanupSearches: {
            found: { close: found.close, deletion: found.deletion },
            rounds: { close: rounds.close, deletion: rounds.deletion },
            errors: [],
          },
          healthSearches: {
            found: found.health,
            rounds: rounds.health,
            errors: [],
          },
        });
        const current = JSON.stringify({
          traces: snapshot([...collection.traces.values()]),
          searches: Object.fromEntries(
            Object.entries(found).map(([name, rows]) => [name, snapshot(rows)]),
          ),
        });
        stable = current === previous ? stable + 1 : 1;
        previous = current;
        Object.assign(receipt, {
          status: "complete",
          stable_snapshots: stable,
          snapshot_sha256: hash(current),
          raw_trace_ids: [...collection.traces.keys()].sort(),
        });
        save();
        if (stable >= 3) {
          signal?.throwIfAborted();
          phase = "inspection";
          const traces = context.closures.map((expected) =>
            inspectBridgeSessionClosure(
              collection.traces.get(expected.traceID),
              expected,
              secrets,
              collection,
            ),
          );
          const raw = [...collection.traces.values()];
          const result = {
            traces,
            ownerClose: traces[0].owner_close,
            diagnostics: resolveTraceDiagnostics(raw[0], raw),
            rawTraceIDs: [...collection.traces.keys()].sort(),
            archive,
          };
          writeEvidenceFile(archive, "result.json", encode(result));
          signal?.throwIfAborted();
          manifest.status = "verified";
          manifest.verified_attempt = attempt;
          save();
          return result;
        }
      } else {
        stable = 0;
        previous = undefined;
        Object.assign(receipt, {
          status: "incomplete",
          missing_trace_ids: missing,
          conflicting_trace_ids: conflicts,
        });
        save();
      }
      if (attempt < attempts) await wait(1000, undefined, { signal });
    }
    phase = "convergence";
    throw new Error("Session raw snapshots did not converge");
  } catch (error) {
    if (manifest) {
      Object.assign(manifest, {
        status: "failed",
        phase,
        error: describe(error),
      });
      save();
    }
    throw new Error(`Session owner evidence failed during ${phase}`);
  }
}
