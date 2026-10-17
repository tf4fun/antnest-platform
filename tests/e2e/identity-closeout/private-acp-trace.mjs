import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { searchJaegerTraces } from "../../support/jaeger-search.mjs";
import {
  evidenceDirectory,
  shellStoragePreflight,
  writeEvidenceFile,
} from "../../support/storage.mjs";
import {
  hasDiagnosticError,
  inspectPrivateACPConnection,
  requestBoundary,
  selectRequestTrace,
} from "../acp-plan/requests.mjs";
import { tag } from "../observability/trace-tree.mjs";
import {
  assertCompleteSourceInputs,
  assertCompleteSourceSnapshot,
  canonicalCompleteSources,
  checkCompleteSources,
  createCompleteSourceReceipt,
  isCompleteSourceFailure,
  preserveCompleteSourceFailure,
} from "../../support/complete-source-inspection.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const traceID = /^[a-f0-9]{32}$/u;
const spanID = /^[a-f0-9]{16}$/u;
const encode = (value) => JSON.stringify(value, null, 2) + "\n";

const requestContract = {
  kind: "request",
  required: ["method", "agentId", "requestId"],
  connection: inspectPrivateACPConnection,
  select: selectRequestTrace,
  boundary: requestBoundary,
  current: () => {},
};

export function collectPrivateACPTrace(base, expected, options) {
  return collectPrivateSources(base, expected, options, requestContract);
}

// Notifications cannot borrow the request entry point or invent an ID. Only
// the original closed connector receipt supplies this fixed contract.
export async function collectPrivateACPNotificationTrace(
  base,
  receipt,
  options = {},
) {
  const {
    privateNotificationExpectation,
    inspectPrivateNotificationConnection,
    inspectPrivateNotificationTrace,
    selectPrivateNotificationTrace,
  } = await import("./private-acp-notification.mjs");
  const expected = privateNotificationExpectation(receipt);
  const { inspect, inspectCompleteSources } = options;
  assert.equal(typeof inspect, "function");
  assert(
    inspectCompleteSources === undefined ||
      typeof inspectCompleteSources === "function",
  );
  const current = () => privateNotificationExpectation(receipt);
  return collectPrivateSources(
    base,
    expected,
    {
      ...options,
      sourceReceipt: true,
      inspect: async (trace, bound, secrets) => {
        const originals = [trace, bound.connectionTrace];
        ({ trace, bound } = structuredClone({ trace, bound }));
        const sources = [trace, bound.connectionTrace];
        const before = JSON.stringify({ sources, bound });
        let result;
        try {
          result = await inspect(trace, bound, secrets);
        } finally {
          assertCompleteSourceInputs({ sources, bound }, before);
        }
        assert(result && typeof result === "object" && !Array.isArray(result));
        assert.equal(
          result.trace_id,
          trace.traceID,
          "foreign notification report",
        );
        const checked = await checkCompleteSources(
          async (context) => {
            current();
            if (inspectCompleteSources) {
              const value = await inspectCompleteSources(context);
              assert.equal(
                value,
                undefined,
                "complete source inspection cannot replace reports",
              );
            }
            current();
          },
          {
            expected: bound,
            sources,
            reports: [result],
            signal: options.signal,
          },
        );
        assertCompleteSourceSnapshot(checked.sources, originals);
        return {
          ...checked.reports[0],
          notification_index: expected.notificationIndex,
        };
      },
    },
    {
      kind: "notification",
      required: ["method", "agentId", "sessionId"],
      current,
      connection: (bound, secrets) =>
        inspectPrivateNotificationConnection(
          receipt,
          bound.connectionTrace,
          secrets,
        ),
      select: (candidates, bound) =>
        selectPrivateNotificationTrace(
          candidates,
          receipt,
          bound.connectionTrace,
        ),
      boundary: (trace, bound, secrets) =>
        inspectPrivateNotificationTrace(
          trace,
          receipt,
          bound.connectionTrace,
          secrets,
        ),
    },
  );
}

// Every query response is archived before parsing or validation, including a
// failed attempt. Success requires complete stable raw, not just stable IDs.
async function collectPrivateSources(
  base,
  expected,
  {
    directory,
    inspect,
    flush,
    secrets = [],
    signal,
    request = fetch,
    wait = delay,
    attempts = 40,
    sourceReceipt = false,
  } = {},
  contract,
) {
  signal?.throwIfAborted();
  let archive,
    manifest,
    phase = "configuration";
  try {
    directory = evidenceDirectory(directory);
    assert(directory, "private raw evidence directory required");
    shellStoragePreflight(directory);
    assert.equal(typeof inspect, "function");
    assert.equal(typeof flush, "function");
    assert.equal(typeof sourceReceipt, "boolean");
    assert(Number.isSafeInteger(attempts) && attempts >= 3 && attempts <= 40);
    assert.equal(expected.boundary, "private-acp");
    assert.equal(expected.transport, "websocket");
    assert([1, 2].includes(expected.protocolVersion));
    assert.match(expected.connectionTraceID ?? "", traceID);
    assert.match(expected.clientSpanID ?? "", spanID);
    assert.equal(
      expected.connectionSpanID,
      undefined,
      "upgrade span must be observed from raw",
    );
    assert.equal(
      expected.connectionTrace,
      undefined,
      "upgrade raw must be queried",
    );
    for (const key of contract.required)
      assert(
        typeof expected[key] === "string" && expected[key].trim().length > 0,
      );
    const endpoint = new URL(base);
    assert(
      ["http:", "https:"].includes(endpoint.protocol) &&
        !endpoint.username &&
        !endpoint.password &&
        !endpoint.search &&
        !endpoint.hash,
    );
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    archive = mkdtempSync(
      join(directory, `private-${expected.connectionTraceID}-`),
    );
    manifest = {
      status: "collecting",
      connection_trace_id: expected.connectionTraceID,
      client_span_id: expected.clientSpanID,
      queries: [],
      attempts: [],
    };
    const save = () =>
      writeEvidenceFile(archive, "manifest.json", encode(manifest));
    save();
    phase = "CLIENT_export";
    await flush();
    let previous,
      stable = 0;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      signal?.throwIfAborted();
      contract.current();
      const receipt = { attempt, status: "collecting" };
      manifest.attempts.push(receipt);
      const archivedRequest = async (url, options) => {
        signal?.throwIfAborted();
        const file = `query-${String(manifest.queries.length + 1).padStart(4, "0")}.raw`;
        const query = {
          attempt,
          url: String(url),
          status: null,
          started_at_ms: Date.now(),
          file,
          outcome: "pending",
          body_complete: false,
        };
        manifest.queries.push(query);
        let bytes = Buffer.alloc(0),
          reader,
          cancellation;
        const preserve = () => {
          writeEvidenceFile(archive, file, bytes);
          Object.assign(query, {
            received_at_ms: Date.now(),
            bytes: bytes.length,
            sha256: hash(bytes),
          });
          save();
        };
        const cancel = () => {
          if (reader) cancellation ??= reader.cancel().catch(() => {});
          return cancellation;
        };
        preserve();
        try {
          options.signal?.throwIfAborted();
          const response = await request(url, options);
          query.status = response.status;
          preserve();
          reader = response.body?.getReader();
          options.signal?.addEventListener("abort", cancel, { once: true });
          if (options.signal?.aborted) cancel();
          options.signal?.throwIfAborted();
          if (reader)
            for (;;) {
              const chunk = await reader.read();
              // A chunk can arrive in the same turn as cancellation. Retain it
              // before checking the signal, but never parse an incomplete body.
              if (chunk.value !== undefined) {
                bytes = Buffer.concat([bytes, Buffer.from(chunk.value)]);
                preserve();
              }
              options.signal?.throwIfAborted();
              if (chunk.done) break;
            }
          query.body_complete = true;
          query.outcome = "complete";
          return {
            status: response.status,
            ok: response.ok,
            json: async () => JSON.parse(bytes.toString("utf8")),
          };
        } catch {
          query.outcome = options.signal?.aborted ? "aborted" : "failed";
          throw new Error("private trace response was incomplete");
        } finally {
          options.signal?.removeEventListener("abort", cancel);
          if (!query.body_complete) await cancel();
          reader?.releaseLock();
          query.finished_at_ms = Date.now();
          preserve();
        }
      };
      const currentSignal = () =>
        signal
          ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
          : AbortSignal.timeout(10000);
      try {
        phase = "connection_response";
        const response = await archivedRequest(
          new URL(`/api/traces/${expected.connectionTraceID}`, endpoint),
          { signal: currentSignal() },
        );
        assert.equal(response.status, 200);
        const body = await response.json();
        assert(
          body.errors == null ||
            (Array.isArray(body.errors) && body.errors.length === 0),
        );
        assert(Array.isArray(body.data) && body.data.length === 1);
        const connection = body.data[0];
        assert.equal(connection.traceID, expected.connectionTraceID);
        phase = "actual_upgrade";
        const upgrades = connection.spans?.filter(
          (span) =>
            connection.processes?.[span.processID]?.serviceName ===
              "agent-acp-service" &&
            tag(span, "span.kind") === "server" &&
            tag(span, "http.request.method") === "GET" &&
            tag(span, "http.route") === `/v${expected.protocolVersion}/acp` &&
            tag(span, "antnest.listener") === "workspace",
        );
        assert.equal(upgrades?.length, 1);
        const bound = {
          ...expected,
          connectionTrace: connection,
          connectionSpanID: upgrades[0].spanID,
        };
        contract.connection(bound, secrets);
        phase = `${contract.kind}_inventory`;
        const query = new URLSearchParams({
          service: "agent-acp-service",
          limit: "100",
          lookback: "1h",
          tags: JSON.stringify({
            "rpc.method": expected.method,
            "antnest.agent.id": expected.agentId,
            ...(contract.kind === "request"
              ? { "antnest.request.id": expected.requestId }
              : {}),
            "antnest.protocol.version": `v${expected.protocolVersion}`,
            ...(expected.sessionId === undefined
              ? {}
              : { "antnest.session.id": expected.sessionId }),
          }),
        });
        const candidates = await searchJaegerTraces(endpoint.href, query, {
          signal: currentSignal(),
          fetchImpl: archivedRequest,
        });
        const selected = contract.select(candidates, bound);
        assert(selected, `private ${contract.kind} not exported`);
        const trace = candidates.find((item) => item.traceID === selected);
        phase = `${contract.kind}_boundary`;
        contract.boundary(trace, bound, secrets);
        const sources = [connection, trace];
        const before = JSON.stringify(sources);
        phase = "owning_inspector";
        const owning = await inspect(trace, bound, secrets);
        assert(owning && typeof owning === "object" && !Array.isArray(owning));
        assert.equal(
          JSON.stringify(sources),
          before,
          "inspector changed raw evidence",
        );
        signal?.throwIfAborted();
        contract.current();
        phase = "stable_closure";
        const snapshot = JSON.stringify({
          candidates: candidates.map((item) => item.traceID).sort(),
          sources: sources
            .toSorted((a, b) => a.traceID.localeCompare(b.traceID))
            .map((source) => ({
              ...source,
              spans: source.spans.toSorted((a, b) =>
                a.spanID.localeCompare(b.spanID),
              ),
            })),
        });
        stable = previous === snapshot ? stable + 1 : 1;
        previous = snapshot;
        Object.assign(receipt, {
          status: "validated",
          stable_samples: stable,
          snapshot_sha256: hash(snapshot),
          ...(sourceReceipt
            ? {
                source_trace_ids: sources
                  .map((source) => source.traceID)
                  .sort(),
                source_snapshot_sha256: hash(canonicalCompleteSources(sources)),
              }
            : {}),
        });
        save();
        if (stable >= 3) {
          const warnings = sources.flatMap((source) => [
            ...(source.warnings ?? []),
            ...source.spans.flatMap((span) => span.warnings ?? []),
          ]);
          const errors = sources.reduce(
            (count, source) =>
              count + source.spans.filter(hasDiagnosticError).length,
            0,
          );
          const diagnostics = {
            warning_count: warnings.length,
            warnings: [...new Set(warnings)],
            error_spans: errors,
            strict_trace: warnings.length || errors ? "failed" : "passed",
            source_trace_ids: [connection.traceID],
          };
          const retained = Object.fromEntries(
            Object.keys(diagnostics)
              .filter((key) => Object.hasOwn(owning, key))
              .map((key) => [key, owning[key]]),
          );
          const result = {
            ...owning,
            ...diagnostics,
            inspector_diagnostics: retained,
            strict_trace:
              owning.strict_trace === "failed"
                ? "failed"
                : diagnostics.strict_trace,
            connection_span_id: bound.connectionSpanID,
            evidence_directory: archive,
            ...(sourceReceipt
              ? {
                  complete_source_receipt: createCompleteSourceReceipt(
                    "websocket",
                    archive,
                    manifest,
                  ),
                }
              : {}),
          };
          writeEvidenceFile(archive, "connection.json", encode(connection));
          writeEvidenceFile(archive, `${contract.kind}.json`, encode(trace));
          writeEvidenceFile(archive, "result.json", encode(result));
          Object.assign(manifest, {
            status: "collected",
            [`${contract.kind}_trace_id`]: trace.traceID,
            connection_span_id: bound.connectionSpanID,
            stable_samples: stable,
          });
          save();
          return result;
        }
      } catch (error) {
        Object.assign(receipt, {
          status: "failed",
          phase,
          error_type: error.name,
        });
        stable = 0;
        previous = undefined;
        save();
        signal?.throwIfAborted();
        if (isCompleteSourceFailure(error)) {
          preserveCompleteSourceFailure(error, archive);
          throw error;
        }
      }
      if (attempt < attempts) await wait(1000, undefined, { signal });
    }
    throw new Error("private trace did not converge");
  } catch {
    if (manifest) {
      Object.assign(manifest, {
        status: "failed",
        phase,
        aborted: signal?.aborted === true,
      });
      writeEvidenceFile(archive, "manifest.json", encode(manifest));
    }
    signal?.throwIfAborted();
    throw new Error(`private ACP trace collection failed at ${phase}`);
  }
}
