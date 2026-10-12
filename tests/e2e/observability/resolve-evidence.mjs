import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { hasError } from "../acp-plan/requests.mjs";
import { inspectTraceContent } from "./evidence.mjs";
import { assertReceivingRPCContent } from "./rpc-content-boundaries.mjs";
import { databaseChildrenTopology, tag, traceTree } from "./trace-tree.mjs";
import {
  assertGatewayResolutionAttributes,
  inspectGatewayResolution,
} from "../../support/gateway-resolution.mjs";
import { collectResolutionSources } from "../../support/gateway-resolution-collect.mjs";
import { resolveTraceDiagnostics } from "../../support/gateway-resolution-evidence.mjs";
import {
  evidenceDirectory,
  writeEvidenceFile,
} from "../../support/storage.mjs";

const failure = () =>
  new Error("observability Resolve evidence validation failed");
const traceIDPattern = /^[a-f0-9]{32}$/u;
const contentEvents = new Set(["antnest.request", "antnest.response"]);
const hasObservationError = (span) =>
  hasError(span) ||
  [
    ...(span.tags ?? []),
    ...(span.logs ?? []).flatMap((event) => event.fields ?? []),
  ].some(
    ({ key, value }) =>
      (key === "error" && value === true) ||
      /^(error\.|exception\.|antnest\.error\.)/u.test(key) ||
      (key === "otel.status_code" && ["ERROR", 2].includes(value)) ||
      (key === "antnest.outcome" && value === "failure") ||
      (key === "event" &&
        ["error", "exception", "antnest.error"].includes(value)),
  );
const one = (spans) => {
  assert.equal(spans.length, 1);
  return spans[0];
};

function validateExpected(expected, captureRpcContent) {
  assert.match(expected.traceID, traceIDPattern);
  assert(["session", "console"].includes(expected.profile));
  assert(
    Number.isFinite(expected.resolveTTLMS) &&
      expected.resolveTTLMS >= 0 &&
      expected.resolveTTLMS <= 30000,
  );
  assert.equal(typeof captureRpcContent, "boolean");
  if (expected.profile === "session") {
    assert.equal(expected.route, "/api/session");
    assert.equal(expected.method, "GET");
    assert.equal(expected.status, 200);
  } else {
    assert.equal(expected.route, "/api/admin/{path...}");
    assert(["GET", "POST", "PUT", "PATCH", "DELETE"].includes(expected.method));
    assert(
      Number.isInteger(expected.status) &&
        expected.status >= 200 &&
        expected.status < 300,
    );
    assert(
      typeof expected.consoleRoute === "string" &&
        expected.consoleRoute.startsWith("/api/admin/"),
    );
  }
}

// Development RPC payloads deliberately may contain credentials. Validate
// their boundary and complete JSON, without projecting/redacting their fields
// or applying a secret-canary scan to the raw archive.
function inspectContent(trace, captureRpcContent) {
  inspectTraceContent(trace, { captureRpcContent });
  assertGatewayResolutionAttributes(trace);
  for (const span of trace.spans) {
    const check = ({ key, value }, event) => {
      assert(!/^http\.(request|response)\.headers?(?:$|\.)/u.test(key));
      if (/^http\.(request|response)\.body(?:$|\.)/u.test(key))
        assert(
          /^http\.(request|response)\.body\.size$/u.test(key) &&
            Number.isSafeInteger(value) &&
            value >= 0,
        );
      assert(
        !["pgx.query.parameters", "db.connection_string"].includes(key) &&
          !/^db\.(query\.parameters?|query\.results?|statement\.parameters)(\.|$)/u.test(
            key,
          ),
      );
      if (event) assert(!key.startsWith("antnest.identity.resolve."));
      if (!key.startsWith("antnest.payload.")) return;
      assert(captureRpcContent && event && key === "antnest.payload.json");
      assert.equal(event.fields.filter((field) => field.key === key).length, 1);
      const name = one(
        event.fields.filter((field) => field.key === "event"),
      ).value;
      assert(contentEvents.has(name));
      assert.equal(tag(span, "span.kind"), "server");
      assert(
        typeof tag(span, "rpc.method") === "string" && tag(span, "rpc.method"),
      );
      assert(
        !["websocket", "sse"].includes(tag(span, "network.transport")) &&
          tag(span, "rpc.service") !== "acp",
      );
      assertReceivingRPCContent(trace, span);
    };
    for (const field of span.tags ?? []) check(field);
    for (const event of span.logs ?? [])
      for (const field of event.fields ?? []) check(field, event);
  }
}

function inspectResolution(trace, expected, collection) {
  validateExpected(expected, collection.captureRpcContent);
  assert.equal(trace.traceID, expected.traceID);
  assert.equal(collection.traces.get(trace.traceID), trace);
  for (const [id, source] of collection.traces) {
    assert.equal(source.traceID, id);
    traceTree(source);
    inspectContent(source, collection.captureRpcContent);
    // Sources and refresh triggers cannot inherit a workflow's declared retry
    // exceptions. The owning inspector retains authority over current work.
    if (source !== trace) assert(!source.spans.some(hasObservationError));
  }
  const tree = traceTree(trace);
  const root = one(trace.spans.filter((span) => !tree.parent(span)));
  assert.equal(tree.service(root), "edge-gateway");
  assert.equal(tag(root, "span.kind"), "server");
  assert.equal(tag(root, "http.route"), expected.route);
  assert.equal(tag(root, "http.request.method"), expected.method);
  assert.equal(tag(root, "http.response.status_code"), expected.status);
  const decision = one(
    trace.spans.filter(
      (span) => span.operationName === "gateway.identity.resolve",
    ),
  );
  let upstream, consoleServer;
  if (expected.profile === "console") {
    consoleServer = one(
      trace.spans.filter(
        (span) =>
          tree.service(span) === "admin-console" &&
          tag(span, "span.kind") === "server",
      ),
    );
    assert.equal(tag(consoleServer, "http.route"), expected.consoleRoute);
    assert.equal(tag(consoleServer, "http.request.method"), expected.method);
    assert.equal(
      tag(consoleServer, "http.response.status_code"),
      expected.status,
    );
    upstream = tree.parent(consoleServer);
    assert.equal(tree.service(upstream), "edge-gateway");
    assert.equal(tree.parent(upstream), root);
    assert.equal(tag(upstream, "span.kind"), "client");
    assert.equal(tag(upstream, "http.request.method"), expected.method);
    assert.equal(tag(upstream, "http.response.status_code"), expected.status);
  }
  assert(
    ![root, decision, upstream, consoleServer]
      .filter(Boolean)
      .some(hasObservationError),
  );
  const result = inspectGatewayResolution(
    trace,
    {
      rootSpanID: root.spanID,
      decisionSpanID: decision.spanID,
      ...(upstream ? { upstreamSpanID: upstream.spanID } : {}),
      profile: expected.profile,
      ttlMs: expected.resolveTTLMS,
    },
    collection,
  );
  let client,
    server,
    sql = [];
  if (result.rpc_client_span_id) {
    const source = collection.traces.get(result.source_trace_id);
    const sourceTree = traceTree(source);
    client = sourceTree.spans.get(result.rpc_client_span_id);
    server = sourceTree.spans.get(result.identity_server_span_id);
    sql = databaseChildrenTopology(source, server);
    assert(![client, server, ...sql].some(hasObservationError));
    if (collection.captureRpcContent)
      assert.deepEqual(
        (server.logs ?? [])
          .map(
            (event) =>
              event.fields?.find((field) => field.key === "event")?.value,
          )
          .filter((name) => contentEvents.has(name))
          .sort(),
        ["antnest.request", "antnest.response"],
      );
    if (expected.profile === "session") {
      assert.equal(tag(client, "server.address"), "identity-service");
      assert.equal(sql.length, 1);
      assert.equal(sql[0].operationName, "SELECT");
      assert.equal(sourceTree.parent(sql[0]), server);
      assert.equal(
        source.spans.filter((span) => sourceTree.chain(span).includes(server))
          .length,
        2,
      );
    }
  }
  // An RPC-free decision cannot hide another actual Resolve in this request.
  const currentReceivers = trace.spans.filter(
    (span) =>
      tree.service(span) === "identity-service" &&
      tag(span, "http.route") === "/rpc/identity/resolve-access-token",
  );
  assert.deepEqual(currentReceivers, result.source === "rpc" ? [server] : []);
  const clients = trace.spans.filter(
    (span) =>
      tree.service(span) === "edge-gateway" &&
      tag(span, "span.kind") === "client",
  );
  const expectedClients = [
    upstream,
    ...(result.source === "rpc" ? [client] : []),
  ].filter(Boolean);
  assert.equal(clients.length, expectedClients.length);
  assert(clients.every((span) => expectedClients.includes(span)));
  if (expected.profile === "session") {
    const allowed = new Set([
      root,
      decision,
      ...(result.source === "rpc" ? [client, server, ...sql] : []),
    ]);
    assert.equal(trace.spans.length, allowed.size);
    assert(trace.spans.every((span) => allowed.has(span)));
  }
  return result;
}

export function inspectObservabilityResolution(trace, expected, collection) {
  try {
    return inspectResolution(trace, expected, collection);
  } catch {
    // Neither assertions nor JSON parser diagnostics may publish RPC bodies.
    throw failure();
  }
}

export async function collectObservabilityResolution(
  base,
  expected,
  {
    directory,
    captureRpcContent,
    signal,
    inspect,
    request = fetch,
    wait = delay,
  } = {},
) {
  try {
    signal?.throwIfAborted();
    validateExpected(expected, captureRpcContent);
    assert.equal(typeof inspect, "function");
    directory = evidenceDirectory(directory);
    assert(directory);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    // Do not overwrite a prior run of the same request, including failed runs.
    const archive = mkdtempSync(join(directory, expected.traceID + "-"));
    await wait(6000, undefined, { signal });
    let previous, result;
    for (let sample = 1; sample <= 3; sample++) {
      signal?.throwIfAborted();
      const sampleDirectory = join(archive, `sample-${sample}`);
      const archivedRequest = async (url, options) => {
        const id = new URL(url).pathname.split("/").at(-1);
        assert.match(id, traceIDPattern);
        const response = await request(url, options);
        const text = await response.text();
        // Keep even malformed JSON/API error bodies private before validation.
        writeEvidenceFile(sampleDirectory, `query-${id}.txt`, text);
        signal?.throwIfAborted();
        return { status: response.status, text: async () => text };
      };
      const response = await archivedRequest(
        `${base.replace(/\/$/u, "")}/api/traces/${expected.traceID}`,
        {
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
            : AbortSignal.timeout(10000),
        },
      );
      assert.equal(response.status, 200);
      const body = JSON.parse(await response.text());
      assert(
        body.errors == null ||
          (Array.isArray(body.errors) && body.errors.length === 0),
      );
      assert(Array.isArray(body.data) && body.data.length === 1);
      const trace = body.data[0];
      assert.equal(trace.traceID, expected.traceID);
      const sources = await collectResolutionSources(base, [trace], {
        request: archivedRequest,
        signal,
        directory: sampleDirectory,
        captureRpcContent,
      });
      const collection = { ...sources, captureRpcContent, signal };
      const resolution = inspectObservabilityResolution(
        trace,
        expected,
        collection,
      );
      const owning = await inspect(trace, expected, collection, resolution);
      signal?.throwIfAborted();
      assert(owning && typeof owning === "object");
      const snapshot = JSON.stringify(
        [...sources.traces.values()]
          .toSorted((a, b) => a.traceID.localeCompare(b.traceID))
          .map((source) => ({
            ...source,
            spans: source.spans.toSorted((a, b) =>
              a.spanID.localeCompare(b.spanID),
            ),
          })),
      );
      if (previous !== undefined) assert.equal(snapshot, previous);
      previous = snapshot;
      const diagnostics = resolveTraceDiagnostics(trace, [
        ...sources.traces.values(),
      ]);
      // Include exception events and numeric OTel errors even when an older
      // consumer's hasError vocabulary does not recognize them yet.
      diagnostics.error_spans = [...sources.traces.values()].reduce(
        (count, source) =>
          count + source.spans.filter(hasObservationError).length,
        0,
      );
      diagnostics.strict_trace =
        diagnostics.warning_count || diagnostics.error_spans
          ? "failed"
          : "passed";
      const retained = Object.fromEntries(
        Object.keys(diagnostics)
          .filter((key) => Object.hasOwn(owning, key))
          .map((key) => [key, owning[key]]),
      );
      result = {
        ...owning,
        ...diagnostics,
        ...(Object.keys(retained).length
          ? { inspector_diagnostics: retained }
          : {}),
        strict_trace:
          owning.strict_trace === "failed"
            ? "failed"
            : diagnostics.strict_trace,
        gateway_resolution: resolution,
        evidence_directory: archive,
      };
      if (sample < 3) await wait(1000, undefined, { signal });
    }
    return result;
  } catch {
    signal?.throwIfAborted();
    throw failure();
  }
}
