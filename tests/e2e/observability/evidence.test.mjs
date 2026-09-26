import assert from "node:assert/strict";
import test from "node:test";
import { inspectHTTPTrace } from "./evidence.mjs";

const traceID = "a".repeat(32);
const config = {
  rootService: "edge-gateway",
  route: "/",
  status: 200,
  hops: [["edge-gateway", "admin-console"]],
};
const tag = (key, value) => ({ key, value });

function fixture() {
  const span = (spanID, processID, kind, parent) => ({
    traceID,
    spanID,
    processID,
    operationName: "HTTP GET /",
    startTime: 1000,
    duration: 200,
    references: parent
      ? [{ traceID, refType: "CHILD_OF", spanID: parent }]
      : [],
    tags: [
      tag("span.kind", kind),
      tag("http.request.method", "GET"),
      tag("http.response.status_code", 200),
      tag("http.route", "/"),
    ],
    logs: [],
  });
  return {
    traceID,
    processes: {
      edge: { serviceName: "edge-gateway" },
      console: { serviceName: "admin-console" },
    },
    spans: [
      span("root", "edge", "server"),
      span("client", "edge", "client", "root"),
      span("server", "console", "server", "client"),
    ],
  };
}

test("HTTP evidence proves actual CLIENT -> SERVER parentage, not service co-occurrence", () => {
  const result = inspectHTTPTrace(fixture(), config);
  assert.equal(result.spans, 3);
  assert.deepEqual(result.hops, [
    { from: "edge-gateway", to: "admin-console", calls: 1 },
  ]);
});
test("HTTP evidence reads Jaeger's translated status without accepting failed responses", () => {
  const trace = fixture();
  for (const span of trace.spans)
    span.tags.find((field) => field.key === "http.response.status_code").key =
      "http.status_code";
  assert.equal(inspectHTTPTrace(trace, config).spans, 3);
  trace.spans[0].tags.find((field) => field.key === "http.status_code").value =
    503;
  assert.throws(() => inspectHTTPTrace(trace, config));
});

test("HTTP evidence rejects trace-level Jaeger warnings", () => {
  const trace = fixture();
  trace.warnings = ["Trace was partially reconstructed"];
  assert.throws(() => inspectHTTPTrace(trace, config), /Jaeger.*warning/u);
});

test("HTTP evidence rejects stale span warnings even when the parent is present", () => {
  const trace = fixture();
  trace.spans[2].warnings = Array(4).fill(
    "parent span ID=client is not in the trace; skipping clock skew adjustment",
  );
  assert.throws(() => inspectHTTPTrace(trace, config), /Jaeger.*warning/u);
});

test("HTTP evidence accepts only empty or null Jaeger warnings", () => {
  const trace = fixture();
  trace.warnings = null;
  trace.spans[0].warnings = [];
  trace.spans[1].warnings = null;
  assert.equal(inspectHTTPTrace(trace, config).warnings, 0);
});

for (const [name, mutate] of [
  [
    "server directly under gateway",
    (t) => (t.spans[2].references[0].spanID = "root"),
  ],
  ["detached client", (t) => (t.spans[1].references = [])],
  ["foreign trace", (t) => (t.spans[2].traceID = "b".repeat(32))],
  ["missing parent", (t) => (t.spans[2].references[0].spanID = "unknown")],
  ["duplicate span id", (t) => (t.spans[2].spanID = "root")],
  [
    "repeated method name",
    (t) => (t.spans[0].operationName = "HTTP GET GET /"),
  ],
  [
    "incorrect route",
    (t) =>
      (t.spans[0].tags.find((v) => v.key === "http.route").value = "GET /"),
  ],
  [
    "credentials in header",
    (t) =>
      t.spans[1].tags.push(
        tag("http.request.header.authorization", ["Bearer private"]),
      ),
  ],
  [
    "too many header bytes",
    (t) =>
      t.spans[1].tags.push(
        tag("http.request.header.accept", Array(8).fill("x".repeat(512))),
        tag("http.request.header.retry-after", ["1"]),
      ),
  ],
]) {
  test(`HTTP evidence rejects ${name}`, () => {
    const trace = fixture();
    mutate(trace);
    assert.throws(() => inspectHTTPTrace(trace, config));
  });
}

function content(trace, value) {
  trace.spans[2].tags.push(tag("rpc.method", "test_rpc"));
  trace.spans[2].logs.push({
    timestamp: 1100,
    fields: [
      tag("event", "antnest.response"),
      tag("antnest.payload.json", value),
    ],
  });
}

test("complete RPC JSON is supported without printing the body in final metrics", () => {
  const trace = fixture();
  content(trace, JSON.stringify({ template_revision: "revision-2" }));
  const result = inspectHTTPTrace(trace, config);
  assert.equal(result.diagnostic_events, 1);
  assert(!JSON.stringify(result).includes("revision-2"));
});

test("ordinary HTTP never accepts header values", () => {
  const trace = fixture();
  trace.spans[1].tags.push(
    tag("http.response.header.content-type", '["application/json"]'),
  );
  assert.throws(() => inspectHTTPTrace(trace, config));
});

test("new nested RPC fields and values above 16 KiB remain complete", () => {
  const trace = fixture();
  content(trace, JSON.stringify({ newField: { raw: "x".repeat(24000) } }));
  assert.equal(inspectHTTPTrace(trace, config).diagnostic_events, 1);
  assert.throws(() =>
    inspectHTTPTrace(trace, { ...config, captureRpcContent: false }),
  );
});

test("content requires a receiving RPC boundary, not an ordinary HTTP or CLIENT span", () => {
  const trace = fixture();
  content(trace, '{"value":"actual"}');
  trace.spans[2].tags = trace.spans[2].tags.filter(
    (tag) => tag.key !== "rpc.method",
  );
  assert.throws(() => inspectHTTPTrace(trace, config));
  trace.spans[2].tags.push(tag("rpc.method", "test_rpc"));
  trace.spans[2].tags.find((tag) => tag.key === "span.kind").value = "client";
  assert.throws(() => inspectHTTPTrace(trace, { ...config, hops: [] }));
});

test("malformed RPC content and repeated payload events fail acceptance", () => {
  const trace = fixture();
  content(trace, '{"value":"cut');
  assert.throws(() => inspectHTTPTrace(trace, config));
  trace.spans[2].logs = [];
  content(trace, '{"value":"complete"}');
  content(trace, '{"value":"duplicate"}');
  assert.throws(() => inspectHTTPTrace(trace, config));
});

for (const encode of [
  String,
  encodeURIComponent,
  (v) => Buffer.from(v).toString("base64"),
]) {
  test(`secret canaries include ${encode.name || "base64"} encoding`, () => {
    const trace = fixture();
    const secret = "private/+ canary";
    content(trace, JSON.stringify({ unknown: encode(secret) }));
    assert.throws(() =>
      inspectHTTPTrace(trace, { ...config, secrets: [secret] }),
    );
  });
}

test("local health trace rejects all hidden downstream calls", () => {
  const trace = fixture();
  trace.spans = trace.spans.slice(0, 1);
  trace.spans[0].tags.find((v) => v.key === "http.route").value = "/status";
  assert.equal(
    inspectHTTPTrace(trace, {
      rootService: "edge-gateway",
      route: "/status",
      status: 200,
      localOnly: true,
    }).spans,
    1,
  );
  assert.throws(() =>
    inspectHTTPTrace(fixture(), { ...config, localOnly: true }),
  );
});
