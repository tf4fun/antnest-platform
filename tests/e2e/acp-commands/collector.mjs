import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  evidenceDirectory,
  shellStoragePreflight,
  writeEvidenceFile,
} from "../../support/storage.mjs";
import {
  collectResolveTraceEvidence,
  resolveTraceSources,
} from "../../support/gateway-resolution-evidence.mjs";
import { clockSkewWarning } from "../../support/strict-findings.mjs";
import { collectPrivateACPTrace } from "../identity-closeout/private-acp-trace.mjs";
import { assertSessionSuccess } from "../identity-closeout/session-diagnostics.mjs";
import { hasDiagnosticError } from "../acp-plan/requests.mjs";
import { traceTopology, tag } from "../observability/trace-tree.mjs";
import {
  inspectCommandHTTPClosure,
  inspectPrivateCommandHTTPBoundary,
  inspectPrivateCommandTrace,
} from "./trace.mjs";

const encode = (value) => JSON.stringify(value, null, 2) + "\n";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const key = (item) => `${item.trace_id}/${item.span_id}`;
const ownedReasons = new Set([
  "command-rejection",
  "private-http-sse-close",
  "completed-initialize-mcp-read-disconnect",
  "completed-runtime-tool-http-disconnect",
]);

function inventory(sources, reports) {
  const raw = sources.flatMap((trace) =>
    trace.spans
      .filter(hasDiagnosticError)
      .map((span) => ({ trace_id: trace.traceID, span_id: span.spanID })),
  );
  const rawIDs = new Set(raw.map(key));
  const claims = reports.flatMap((report) => [
    ...(report.owned_error_spans ?? []),
    ...(report.neutral_diagnostics ?? []).filter((item) =>
      rawIDs.has(key(item)),
    ),
  ]);
  assert.equal(
    new Set(claims.map(key)).size,
    claims.length,
    "duplicate command diagnostic claim",
  );
  assert.deepEqual(
    new Set(claims.map(key)),
    rawIDs,
    "unclaimed command raw error",
  );
  assert(
    claims.every((item) => ownedReasons.has(item.reason)),
    "unknown command diagnostic reason",
  );
  return {
    raw_error_inventory: raw,
    owned_error_spans: claims,
    diagnostic_inventory_verified: true,
  };
}

// Raw failure status remains failed. Admission accounts for each actual error
// identity and the existing Jaeger clock warning class without rewriting counts.
export function privateCommandStrictOutcome(results) {
  const allErrors = new Map();
  let failed = false,
    warnings = false;
  try {
    assert(Array.isArray(results) && results.length > 0);
    for (const result of results) {
      assert.equal(result.diagnostic_inventory_verified, true);
      const raw = result.raw_error_inventory,
        owned = result.owned_error_spans;
      assert(Array.isArray(raw) && Array.isArray(owned));
      assert.equal(new Set(raw.map(key)).size, raw.length);
      assert.equal(new Set(owned.map(key)).size, owned.length);
      assert.deepEqual(new Set(raw.map(key)), new Set(owned.map(key)));
      assert(owned.every((item) => ownedReasons.has(item.reason)));
      assert.equal(result.error_spans, raw.length);
      assert(
        Array.isArray(result.warnings) &&
          result.warnings.every(
            (warning) =>
              typeof warning === "string" && clockSkewWarning.test(warning),
          ),
      );
      assert(
        Number.isSafeInteger(result.warning_count) &&
          result.warning_count >= result.warnings.length,
      );
      assert.equal(result.warning_count === 0, result.warnings.length === 0);
      assert.equal(
        result.strict_trace,
        raw.length || result.warning_count ? "failed" : "passed",
      );
      for (const item of owned) {
        if (allErrors.has(key(item)))
          assert.deepEqual(
            allErrors.get(key(item)),
            item,
            "inconsistent shared raw diagnostic",
          );
        else allErrors.set(key(item), item);
      }
      failed ||= result.strict_trace === "failed";
      warnings ||= result.warning_count > 0;
    }
    return {
      strict_trace: failed ? "failed" : "passed",
      accepted: true,
      exit_code: failed ? 2 : 0,
      reviewed_error_spans: allErrors.size,
      ...(warnings ? { clock_warnings_accepted: true } : {}),
    };
  } catch {
    return { strict_trace: "failed", accepted: false, exit_code: 1 };
  }
}

function sameProcess(trace, span, referenceTrace, referenceSpan) {
  const identities = ([source, node]) => {
    const process = source.processes[node.processID];
    assert.equal(process?.serviceName, "agent-acp-service");
    const fields = process.tags ?? [];
    assert.equal(new Set(fields.map((item) => item.key)).size, fields.length);
    const attributes = Object.fromEntries(
      fields.map(({ key, value }) => [key, value]),
    );
    assert(
      typeof attributes["host.name"] === "string" &&
        attributes["host.name"].length > 0,
    );
    assert(
      Number.isSafeInteger(attributes["process.pid"]) &&
        attributes["process.pid"] > 0,
    );
    assert(
      typeof attributes["service.instance.id"] === "string" &&
        attributes["service.instance.id"].length > 0,
    );
    return [
      attributes["host.name"],
      attributes["process.pid"],
      attributes["service.instance.id"],
    ];
  };
  assert.deepEqual(
    identities([trace, span]),
    identities([referenceTrace, referenceSpan]),
    "HTTP auxiliary belongs to another ACP process",
  );
}

function inspectAuxiliary(
  trace,
  receipt,
  expected,
  primary,
  reference,
  secrets,
  requests,
) {
  if (receipt.rpcMethod === "initialize") {
    const bound = {
      boundary: "private-acp",
      protocolVersion: 1,
      transport: "http",
      kind: "request",
      label: "initialize",
      method: "initialize",
      agentId: expected.agentId,
      requestId: String(receipt.requestID),
      inputSessionID: null,
      traceID: receipt.traceID,
      clientSpanID: receipt.clientSpanID,
      connectionID: receipt.connectionID,
      httpRequestIndex: receipt.index,
      httpConnection: expected.httpConnection,
    };
    const receiver = inspectPrivateCommandHTTPBoundary(
      trace,
      bound,
      secrets,
    ).http;
    sameProcess(trace, receiver, primary, reference);
    return inspectPrivateCommandTrace(trace, bound, secrets, requests);
  }
  assert(["GET", "DELETE"].includes(receipt.method));
  assert.equal(trace.traceID, receipt.traceID);
  const tree = traceTopology(trace),
    roots = trace.spans.filter((span) => !tree.parent(span));
  assert.equal(roots.length, 1);
  const client = roots[0];
  assert.equal(client.spanID, receipt.clientSpanID);
  assert.equal(client.references.length, 0);
  assert.equal(tree.service(client), "antnest-private-acp-client");
  assert.equal(
    client.operationName,
    `HTTP ${receipt.method} agent-acp-workspace`,
  );
  for (const [field, value] of Object.entries({
    "span.kind": "client",
    "http.request.method": receipt.method,
    "http.response.status_code": receipt.status,
    "http.response.body.size": receipt.bytes,
    "antnest.outcome": receipt.bodyOutcome,
    "antnest.http.body.outcome": receipt.bodyOutcome,
  }))
    assert.equal(tag(client, field), value);
  const receivers = trace.spans.filter(
    (span) =>
      tree.service(span) === "agent-acp-service" &&
      tag(span, "span.kind") === "server",
  );
  assert.equal(receivers.length, 1);
  const receiver = receivers[0];
  assert.equal(tree.parent(receiver), client);
  assert.equal(receiver.operationName, `HTTP ${receipt.method} /v1/acp`);
  for (const [field, value] of Object.entries({
    "http.request.method": receipt.method,
    "http.route": "/v1/acp",
    "antnest.listener": "workspace",
    "http.response.status_code": receipt.status,
  }))
    assert.equal(tag(receiver, field), value);
  sameProcess(trace, receiver, primary, reference);
  // Successful GET/DELETE execute only the transport readiness query. Account
  // for the entire production subtree; no business RPC or SQL may hide here.
  const readiness = trace.spans.filter(
    (span) => span.operationName === "postgres.ready",
  );
  const queries = trace.spans.filter((span) => span.operationName === "SELECT");
  assert.equal(readiness.length, 1, "missing or repeated auxiliary readiness");
  assert.equal(
    queries.length,
    1,
    "missing or repeated auxiliary readiness SQL",
  );
  const ready = readiness[0],
    sql = queries[0];
  assert.equal(trace.spans.length, 4, "unaccounted HTTP auxiliary work");
  assert.equal(tree.parent(ready), receiver);
  assert.equal(tree.parent(sql), ready);
  assert.equal(tag(ready, "span.kind"), "internal");
  assert.equal(tag(sql, "span.kind"), "client");
  for (const span of [receiver, ready, sql]) {
    assert.equal(span.references.length, 1, "unexpected auxiliary reference");
    sameProcess(trace, span, primary, reference);
  }
  const database = new Map([
    [ready, { "db.system.name": "postgresql" }],
    [
      sql,
      {
        "db.system.name": "postgresql",
        "db.namespace": "antnest_agent_acp",
        "db.operation.name": "SELECT",
        "db.query.text": "SELECT 1",
      },
    ],
  ]);
  const claims = [];
  for (const span of trace.spans) {
    const fields = [
      ...(span.tags ?? []),
      ...(span.logs ?? []).flatMap((event) => event.fields ?? []),
    ];
    assert(
      !fields.some((field) =>
        /^(rpc\.|acp\.|antnest\.(request|run|session|command)\.)/.test(
          field.key,
        ),
      ),
      "auxiliary HTTP contains business protocol metadata",
    );
    assert.deepEqual(
      Object.fromEntries(
        (span.tags ?? [])
          .filter((field) => field.key.startsWith("db."))
          .map(({ key, value }) => [key, value]),
      ),
      database.get(span) ?? {},
      "unexpected auxiliary database work",
    );
    let view = span;
    if (span === receiver && tag(span, "antnest.outcome") === "disconnected") {
      assert.equal(receipt.method, "GET");
      assert.equal(receipt.bodyOutcome, "cancelled");
      const cancel = receipt.events.filter((item) => item.kind === "cancel");
      const closed = receipt.events.filter(
        (item) => item.kind === "body_closed",
      );
      assert.equal(cancel.length, 1);
      assert.equal(closed.length, 1);
      assert(
        cancel[0].monotonicMs >= receipt.started.monotonicMs &&
          closed[0].monotonicMs >= cancel[0].monotonicMs &&
          receipt.ended.monotonicMs >= closed[0].monotonicMs,
      );
      const status = tag(span, "otel.status_code");
      assert(["ERROR", 2].includes(status));
      const allowed = {
        "antnest.outcome": "disconnected",
        "error.type": "stream_interrupted",
        "otel.status_code": status,
        ...(tag(span, "error") === undefined ? {} : { error: true }),
      };
      for (const [field, value] of Object.entries(allowed))
        assert.equal(tag(span, field), value);
      assert.equal(
        new Set(span.tags.map((item) => item.key)).size,
        span.tags.length,
      );
      view = {
        ...span,
        tags: span.tags.filter((item) => !Object.hasOwn(allowed, item.key)),
      };
      claims.push({
        trace_id: trace.traceID,
        span_id: span.spanID,
        reason: "private-http-sse-close",
        http_request_index: receipt.index,
      });
    }
    assertSessionSuccess(
      view,
      span === client
        ? {
            "antnest.outcome": receipt.bodyOutcome,
            "antnest.http.body.outcome": receipt.bodyOutcome,
          }
        : {},
    );
  }
  return {
    trace_id: trace.traceID,
    method: receipt.method,
    http_request_index: receipt.index,
    owned_error_spans: claims,
    neutral_diagnostics: [],
  };
}

export async function collectPrivateCommandTrace(
  base,
  expected,
  {
    directory,
    flush,
    secrets = [],
    requests = [],
    signal,
    request = fetch,
    wait = delay,
    attempts = 40,
  } = {},
) {
  assert.equal(expected.boundary, "private-acp");
  if (expected.transport === "websocket")
    return collectPrivateACPTrace(base, expected, {
      directory,
      flush,
      secrets,
      signal,
      request,
      wait,
      attempts,
      inspect: (trace, bound) => {
        const result = inspectPrivateCommandTrace(
          trace,
          bound,
          secrets,
          requests,
        );
        return {
          ...result,
          ...inventory([trace, bound.connectionTrace], [result]),
        };
      },
    });
  let archive, manifest;
  const save = () =>
    writeEvidenceFile(archive, "manifest.json", encode(manifest));
  try {
    signal?.throwIfAborted();
    assert.equal(expected.transport, "http");
    assert.equal(typeof flush, "function");
    assert(Number.isSafeInteger(attempts) && attempts >= 3 && attempts <= 40);
    const endpoint = new URL(base);
    assert(
      ["http:", "https:"].includes(endpoint.protocol) &&
        !endpoint.username &&
        !endpoint.password &&
        !endpoint.search &&
        !endpoint.hash,
    );
    directory = evidenceDirectory(directory);
    assert(directory, "command evidence directory required");
    shellStoragePreflight(directory);
    const closure = inspectCommandHTTPClosure(expected.httpConnection);
    const auxiliary = closure.wire.filter(
      (item) =>
        item.traceID !== expected.traceID &&
        (item.method !== "POST" || item.rpcMethod === "initialize"),
    );
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    archive = mkdtempSync(join(directory, "commands-http-"));
    manifest = {
      status: "collecting",
      trace_id: expected.traceID,
      queries: [],
    };
    save();
    const archivedRequest = async (address, options = {}) => {
      const file = `query-${String(manifest.queries.length + 1).padStart(4, "0")}.raw`;
      const query = {
        url: String(address),
        file,
        status: null,
        outcome: "pending",
        body_complete: false,
      };
      manifest.queries.push(query);
      let bytes = Buffer.alloc(0),
        reader,
        cancellation;
      const preserve = () => {
        writeEvidenceFile(archive, file, bytes);
        Object.assign(query, { bytes: bytes.length, sha256: hash(bytes) });
        save();
      };
      const cancel = () => {
        if (reader) cancellation ??= reader.cancel().catch(() => {});
        return cancellation;
      };
      preserve();
      try {
        options.signal?.throwIfAborted();
        const response = await request(address, options);
        query.status = response.status;
        preserve();
        reader = response.body?.getReader();
        options.signal?.addEventListener("abort", cancel, { once: true });
        if (options.signal?.aborted) cancel();
        options.signal?.throwIfAborted();
        if (reader)
          for (;;) {
            const chunk = await reader.read();
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
          text: async () => bytes.toString("utf8"),
          json: async () => JSON.parse(bytes.toString("utf8")),
        };
      } catch {
        query.outcome = options.signal?.aborted ? "aborted" : "failed";
        throw new Error("command raw response incomplete");
      } finally {
        options.signal?.removeEventListener("abort", cancel);
        if (!query.body_complete) await cancel();
        reader?.releaseLock();
        preserve();
      }
    };
    await flush();
    signal?.throwIfAborted();
    const [result] = await collectResolveTraceEvidence(
      endpoint.href,
      [{ ...expected, relatedTraceIDs: auxiliary.map((item) => item.traceID) }],
      secrets,
      {
        request: archivedRequest,
        wait,
        attempts,
        directory: archive,
        signal,
        inspect: (trace, item, _secrets, collection) => {
          const sources = resolveTraceSources(trace, secrets, collection);
          assert.equal(
            sources.length,
            1 + auxiliary.length,
            "unexpected command source Trace",
          );
          const before = JSON.stringify(sources);
          const main = inspectPrivateCommandTrace(
            trace,
            item,
            secrets,
            requests,
          );
          const reference = inspectPrivateCommandHTTPBoundary(
            trace,
            item,
            secrets,
          ).http;
          const extra = auxiliary.map((receipt) =>
            inspectAuxiliary(
              collection.traces.get(receipt.traceID),
              receipt,
              item,
              trace,
              reference,
              secrets,
              requests,
            ),
          );
          const evidence = inventory(sources, [main, ...extra]);
          assert.equal(
            JSON.stringify(sources),
            before,
            "command inspector modified raw",
          );
          return {
            ...main,
            ...evidence,
            neutral_diagnostics: [main, ...extra].flatMap(
              (report) => report.neutral_diagnostics ?? [],
            ),
            time_observations: [main, ...extra].flatMap(
              (report) => report.time_observations ?? [],
            ),
            http_auxiliary: extra.map(
              ({ trace_id, method, http_request_index }) => ({
                trace_id,
                method,
                http_request_index,
              }),
            ),
          };
        },
      },
    );
    signal?.throwIfAborted();
    result.evidence_directory = archive;
    writeEvidenceFile(archive, "result.json", encode(result));
    manifest.status = "collected";
    save();
    return result;
  } catch {
    if (manifest) {
      manifest.status = "failed";
      manifest.aborted = signal?.aborted === true;
      save();
    }
    signal?.throwIfAborted();
    throw new Error("private command HTTP trace collection failed");
  }
}
