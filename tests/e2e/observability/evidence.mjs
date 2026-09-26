import assert from "node:assert/strict";
import { tag } from "./trace-tree.mjs";

const value = (fields, key) =>
  fields?.find((field) => field.key === key)?.value;

function graph(trace) {
  assert(
    trace?.traceID && trace.spans?.length && trace.processes,
    "trace is missing",
  );
  assert.equal(
    trace.warnings?.length ?? 0,
    0,
    "Jaeger trace warnings require review",
  );
  const spans = new Map(trace.spans.map((span) => [span.spanID, span]));
  assert.equal(spans.size, trace.spans.length, "duplicate span ID");
  const service = (span) => trace.processes[span.processID]?.serviceName;
  const parent = (span) => {
    const parents =
      span.references?.filter((ref) => ref.refType === "CHILD_OF") ?? [];
    assert(parents.length <= 1, "multiple synchronous parents");
    if (!parents.length) return undefined;
    assert.equal(parents[0].traceID, trace.traceID, "foreign parent trace");
    const result = spans.get(parents[0].spanID);
    assert(result, "missing synchronous parent");
    return result;
  };
  for (const span of trace.spans) {
    assert.equal(
      span.warnings?.length ?? 0,
      0,
      "Jaeger span warnings require review",
    );
    assert.equal(span.traceID, trace.traceID, "foreign span trace");
    assert(service(span), "unknown service");
    assert(
      Number.isFinite(span.duration) && span.duration >= 0,
      "unfinished span",
    );
    assert(
      !/^HTTP (\S+) \1(?: |$)/u.test(span.operationName),
      "duplicated HTTP method in span name",
    );
    const seen = new Set();
    for (let current = span; current; current = parent(current)) {
      assert(!seen.has(current.spanID), "cyclic trace");
      seen.add(current.spanID);
    }
  }
  return { service, parent };
}

function inspectHeaders(span) {
  for (const field of span.tags ?? []) {
    assert(
      !/^http\.(request|response)\.header\./u.test(field.key),
      "HTTP header values must not be captured",
    );
  }
}

function inspectPayloads(span, captureRpcContent) {
  const seen = new Set();
  for (const event of span.logs ?? []) {
    const name = value(event.fields, "event");
    for (const field of event.fields ?? []) {
      if (
        /^antnest\.error\.(stage|type|code|message|causes)$/u.test(field.key)
      ) {
        assert.equal(
          typeof field.value,
          "string",
          "error metadata must remain typed",
        );
      }
    }
    if (!["antnest.request", "antnest.response"].includes(name)) continue;
    assert(captureRpcContent !== false, "RPC content captured while disabled");
    assert(
      tag(span, "rpc.method") && tag(span, "span.kind") !== "client",
      "payload requires a receiving RPC boundary",
    );
    assert(!seen.has(name), "RPC payload was recorded more than once");
    seen.add(name);
    assert.equal(
      value(event.fields, "antnest.payload.capture"),
      undefined,
      "legacy payload projection remains",
    );
    const json = value(event.fields, "antnest.payload.json");
    assert.equal(
      typeof json,
      "string",
      "RPC payload must contain complete JSON",
    );
    JSON.parse(json);
  }
  return seen.size;
}

export function inspectHTTPTrace(trace, config) {
  const { service, parent } = graph(trace);
  const roots = trace.spans.filter(
    (span) =>
      service(span) === config.rootService &&
      tag(span, "span.kind") === "server" &&
      tag(span, "http.route") === config.route,
  );
  assert.equal(roots.length, 1, "exact request root required");
  const root = roots[0];
  if (config.status !== undefined)
    assert.equal(tag(root, "http.response.status_code"), config.status);
  const inRequest = (span) => {
    for (let current = span; current; current = parent(current))
      if (current === root) return true;
    return false;
  };
  if (config.localOnly)
    assert.equal(
      trace.spans.length,
      1,
      "stateless local health must not call dependencies",
    );
  const hops = (config.hops ?? []).map(([from, to, expected = 1]) => {
    const servers = trace.spans.filter(
      (span) =>
        service(span) === to &&
        tag(span, "span.kind") === "server" &&
        inRequest(span),
    );
    const matched = servers.filter((span) => {
      const client = parent(span);
      return (
        client &&
        service(client) === from &&
        tag(client, "span.kind") === "client" &&
        inRequest(client)
      );
    });
    assert.equal(
      matched.length,
      expected,
      `missing/duplicate HTTP boundary ${from} -> ${to}`,
    );
    return { from, to, calls: matched.length };
  });
  const serialized = JSON.stringify(trace);
  for (const secret of config.secrets ?? []) {
    assert(secret.length >= 6, "secret canary must be specific");
    for (const encoded of [
      secret,
      encodeURIComponent(secret),
      Buffer.from(secret).toString("base64"),
    ])
      assert(!serialized.includes(encoded), "secret canary found in trace");
  }
  let diagnosticEvents = 0;
  for (const span of trace.spans) {
    inspectHeaders(span);
    diagnosticEvents += inspectPayloads(span, config.captureRpcContent);
  }
  return {
    trace_id: trace.traceID,
    spans: trace.spans.length,
    services: [...new Set(trace.spans.map(service))].sort(),
    hops,
    diagnostic_events: diagnosticEvents,
    warnings: 0,
  };
}
