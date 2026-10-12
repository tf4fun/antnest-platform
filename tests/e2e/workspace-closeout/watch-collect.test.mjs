import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { temporaryStorageRoot } from "../../support/storage.mjs";
import { unreviewedWarnings } from "../../support/strict-findings.mjs";
import * as watch from "./current-trace.mjs";
import { fields } from "../observability/trace-fixtures.mjs";
import {
  sharedResolutionFixture,
  sourceID,
  triggerID,
  setTag,
} from "../observability/gateway-resolution-fixtures.mjs";

function fixture(t) {
  const f = sharedResolutionFixture(true);
  const route = "/api/app/agents/{agent_id}/state/watch";
  f.root.operationName = "HTTP GET " + route;
  setTag(f.root, "http.route", route);
  f.upstream.operationName = "HTTP POST agent-acp-workspace";
  setTag(f.upstream, "http.request.method", "POST");
  setTag(f.upstream, "http.response.status_code", 200);
  f.trace.processes.acp = { serviceName: "agent-acp-service" };
  f.trace.spans.push({
    traceID: f.trace.traceID,
    spanID: "watch-server",
    processID: "acp",
    operationName: "HTTP POST /rpc/agent-acp/watch-agent-execution-state",
    startTime: f.upstream.startTime + 10,
    duration: 9000,
    tags: fields({
      "span.kind": "server",
      "http.request.method": "POST",
      "http.response.status_code": 200,
      "http.route": "/rpc/agent-acp/watch-agent-execution-state",
      "rpc.method": "watch_agent_execution_state",
    }),
    references: [
      {
        refType: "CHILD_OF",
        traceID: f.trace.traceID,
        spanID: f.upstream.spanID,
      },
    ],
  });
  const directory = mkdtempSync(
    join(temporaryStorageRoot(), "antnest-watch-evidence-"),
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const queries = [];
  const request = async (url) => {
    const id = new URL(url).pathname.split("/").at(-1);
    queries.push(id);
    return Response.json({ data: [f.traces.get(id)] });
  };
  return {
    ...f,
    directory,
    queries,
    request,
    wait: async () => {},
    attempts: 4,
    expected: {
      traceID: f.trace.traceID,
      stopWindow: { start: 1000, end: 3000 },
      clock: {
        requestStartedAt: 1000,
        responseReceivedAt: 1000,
        serverDate: new Date(1000).toUTCString(),
      },
    },
  };
}
const collect = (f) => {
  assert.equal(
    typeof watch.collectWorkspaceWatch,
    "function",
    "Workspace must await its complete Resolve evidence collector",
  );
  return watch.collectWorkspaceWatch(
    "http://jaeger",
    f.expected,
    ["PRIVATE"],
    f,
  );
};

test("Workspace collection waits for complete source SQL and archives the actual trigger", async (t) => {
  const f = fixture(t),
    request = f.request;
  let sources = 0;
  f.request = async (url, options) => {
    const response = await request(url, options);
    if (url.endsWith(sourceID) && ++sources === 1) {
      const partial = structuredClone(f.traces.get(sourceID));
      partial.spans = partial.spans.filter((span) => span.spanID !== "sql");
      return Response.json({ data: [partial] });
    }
    return response;
  };
  const result = await collect(f);
  assert.equal(sources, 4);
  assert.equal(result.identity_sql, 1);
  assert.equal(result.gateway_resolution.source_root, "background-refresh");
  for (const [id, trace] of f.traces)
    assert.deepEqual(
      JSON.parse(readFileSync(join(f.directory, id + ".json"))),
      trace,
    );
});

test("Workspace collection retains late source diagnostics and converges the entire closure", async (t) => {
  const f = fixture(t),
    request = f.request;
  let sources = 0;
  f.request = async (url, options) => {
    if (url.endsWith(sourceID) && ++sources >= 2)
      f.traces.get(sourceID).warnings = ["unreviewed source warning"];
    return request(url, options);
  };
  const result = await collect(f);
  assert.equal(sources, 4);
  assert.equal(result.strict_trace, "failed");
  assert.deepEqual(unreviewedWarnings(JSON.stringify(result)), [
    "unreviewed source warning",
  ]);
  assert.deepEqual(result.source_trace_ids, [sourceID, triggerID]);
});

test("Workspace collection cannot replace source SQL failure with a custom inspector", async (t) => {
  const f = fixture(t);
  f.traces.get(sourceID).spans = f.traces
    .get(sourceID)
    .spans.filter((span) => span.spanID !== "sql");
  f.inspect = () => ({ strict_trace: "passed" });
  await assert.rejects(async () => collect(f), /zero PostgreSQL/u);
  assert.deepEqual(
    JSON.parse(readFileSync(join(f.directory, sourceID + ".json"))),
    f.traces.get(sourceID),
  );
});

test("Workspace source collection joins an aborted response body", async (t) => {
  const f = fixture(t),
    controller = new AbortController();
  f.signal = controller.signal;
  let active = false;
  const request = f.request;
  f.request = async (url, options) => {
    if (!url.endsWith(sourceID)) return request(url, options);
    return {
      status: 200,
      text: async () => {
        active = true;
        try {
          await new Promise((_, reject) => {
            options.signal.addEventListener(
              "abort",
              () => reject(options.signal.reason),
              { once: true },
            );
            controller.abort(new Error("watch evidence cancelled"));
          });
        } finally {
          active = false;
        }
      },
    };
  };
  await assert.rejects(async () => collect(f), /watch evidence cancelled/u);
  assert.equal(active, false);
});
