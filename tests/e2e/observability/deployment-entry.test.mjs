import assert from "node:assert/strict";
import test from "node:test";
import { inspectDeploymentEntry } from "./deployment-entry.mjs";
import { fields } from "./trace-fixtures.mjs";

const traceID = "a".repeat(32);

function fixture(path = "/") {
  const span = (spanID, processID, kind, parent) => ({
    traceID,
    spanID,
    processID,
    operationName: `HTTP GET ${path}`,
    duration: 200,
    references: parent
      ? [{ refType: "CHILD_OF", traceID, spanID: parent }]
      : [],
    tags: fields({
      "span.kind": kind,
      "http.request.method": "GET",
      "http.response.status_code": 200,
      ...(kind === "server"
        ? { "http.route": path === "/" ? "/{path...}" : path }
        : { "server.address": "admin-console" }),
      "http.response.body.size": 200,
    }),
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
      ...(path === "/"
        ? [
            span("client", "edge", "client", "root"),
            span("server", "console", "server", "client"),
          ]
        : []),
    ],
  };
}

for (const path of ["/status", "/"]) {
  test(`entry ${path} reports exact ordered structure without content`, () => {
    const trace = fixture(path);
    trace.spans.reverse();
    const result = inspectDeploymentEntry(trace, path);
    assert.equal(result.trace_id, traceID);
    assert.equal(result.spans, path === "/" ? 3 : 1);
    assert.equal(result.chain[0].parent_span_id, null);
    assert.equal(result.errors, 0);
    assert.equal(result.diagnostic_events, 0);
    assert.equal(result.warnings, 0);
  });

  for (const marker of [
    { error: true },
    { "error.type": "write_failed" },
    { "otel.status_code": "ERROR" },
    { "antnest.outcome": "failure" },
    { event: "exception" },
    { event: "antnest.error" },
    { "antnest.error.stage": "write_response" },
  ]) {
    test(`entry ${path} rejects root/downstream failures despite HTTP 200: ${JSON.stringify(marker)}`, () => {
      for (const index of path === "/" ? [0, 1, 2] : [0]) {
        for (const location of ["tags", "logs"]) {
          const trace = fixture(path);
          const span = trace.spans[index];
          if (location === "tags") span.tags.push(...fields(marker));
          else span.logs.push({ fields: fields(marker) });
          assert.throws(() => inspectDeploymentEntry(trace, path));
        }
      }
    });
  }

  for (const event of [undefined, "diagnostic", "antnest.response"]) {
    test(`entry ${path} rejects content independently of event name ${event}`, () => {
      for (const location of ["tags", "logs"]) {
        const trace = fixture(path);
        const values = fields({
          ...(event ? { event } : {}),
          "antnest.payload.json": '{"private":"must-not-be-recorded"}',
        });
        if (location === "tags") trace.spans[0].tags.push(...values);
        else trace.spans[0].logs.push({ fields: values });
        assert.throws(() => inspectDeploymentEntry(trace, path));
      }
    });
  }

  test(`entry ${path} rejects body/header namespaces in every role`, () => {
    for (const direction of ["request", "response"]) {
      for (const suffix of [
        "body",
        "body.raw",
        "body.content",
        "body.unknown",
        "body.size",
        "header",
        "headers",
        "headers.authorization",
      ]) {
        for (const index of path === "/" ? [0, 1, 2] : [0]) {
          for (const location of ["tags", "logs"]) {
            const trace = fixture(path);
            const values = fields({
              [`http.${direction}.${suffix}`]: "must-not-be-recorded",
            });
            if (location === "tags") trace.spans[index].tags.push(...values);
            else trace.spans[index].logs.push({ fields: values });
            assert.throws(() => inspectDeploymentEntry(trace, path));
          }
        }
      }
    }
  });

  test(`entry ${path} accepts only numeric body-size metadata`, () => {
    const trace = fixture(path);
    for (const span of trace.spans) {
      span.tags.push(...fields({ "http.request.body.size": 0 }));
      span.logs.push({ fields: fields({ "http.response.body.size": 128 }) });
    }
    assert.doesNotThrow(() => inspectDeploymentEntry(trace, path));
    for (const size of [-1, 0.5, Number.POSITIVE_INFINITY]) {
      const invalid = fixture(path);
      invalid.spans[0].tags.push(...fields({ "http.request.body.size": size }));
      assert.throws(() => inspectDeploymentEntry(invalid, path));
    }
  });
}

for (const [name, mutate] of [
  [
    "orphan server",
    (t) => t.spans.push({ ...t.spans[2], spanID: "extra", references: [] }),
  ],
  ["unmatched client", (t) => t.spans.push({ ...t.spans[1], spanID: "extra" })],
  [
    "hidden SQL",
    (t) =>
      t.spans.push({ ...t.spans[1], spanID: "sql", operationName: "SELECT" }),
  ],
  ["client root", (t) => (t.spans[1].references = [])],
  ["server skips client", (t) => (t.spans[2].references[0].spanID = "root")],
  [
    "downstream HTTP error",
    (t) =>
      (t.spans[2].tags.find(
        (v) => v.key === "http.response.status_code",
      ).value = 500),
  ],
  [
    "downstream method",
    (t) =>
      (t.spans[2].tags.find((v) => v.key === "http.request.method").value =
        "POST"),
  ],
  [
    "wrong route",
    (t) =>
      (t.spans[2].tags.find((v) => v.key === "http.route").value = "/status"),
  ],
  [
    "wrong target",
    (t) =>
      (t.spans[1].tags.find((v) => v.key === "server.address").value =
        "identity-service"),
  ],
  ["duplicate span", (t) => (t.spans[2].spanID = "root")],
  ["foreign trace", (t) => (t.spans[2].traceID = "b".repeat(32))],
  ["missing parent", (t) => (t.spans[2].references[0].spanID = "missing")],
  ["trace warning", (t) => (t.warnings = ["missing parent"])],
  ["span warning", (t) => (t.spans[2].warnings = ["clock skew"])],
  ["unfinished span", (t) => delete t.spans[1].duration],
  [
    "header in log",
    (t) =>
      t.spans[2].logs.push({
        fields: fields({ "http.response.header.authorization": "private" }),
      }),
  ],
]) {
  test(`entry rejects ${name}`, () => {
    const trace = fixture();
    mutate(trace);
    assert.throws(() => inspectDeploymentEntry(trace, "/"));
  });
}

test("entry health cannot contain dependencies", () => {
  const trace = fixture("/status");
  trace.spans.push(fixture().spans[1]);
  assert.throws(() => inspectDeploymentEntry(trace, "/status"));
});

test("entry does not accept another business scenario", () => {
  assert.throws(() => inspectDeploymentEntry(fixture(), "/api/admin/agents"));
});
