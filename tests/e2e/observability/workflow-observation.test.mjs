import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { temporaryStorageRoot } from "../../support/storage.mjs";
import { collectWorkflowObservation } from "./workflow-observation.mjs";
import { workflowObservationFixture } from "./workflow-observation-fixtures.mjs";
import { inspectWorkflow, lifecyclePlans } from "./lifecycle-workflow.mjs";
import { inspectLifecycle } from "../lifecycle-closeout/evidence.mjs";
import { setTag } from "./gateway-resolution-fixtures.mjs";

function setup(t, kind, source = "cache") {
  const f = workflowObservationFixture(kind, source);
  const directory = mkdtempSync(
    join(temporaryStorageRoot(), "antnest-workflow-observation-"),
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const queries = [],
    waits = [];
  const options = {
    directory,
    request: async (url) => {
      const id = new URL(url).pathname.split("/").at(-1);
      queries.push(id);
      return Response.json({ data: [f.traces.get(id)] });
    },
    wait: async (ms) => {
      waits.push(ms);
    },
    inspect: (trace) =>
      inspectWorkflow(trace, f.requestID, {
        kind,
        agentID: f.agentID,
        runtimeRevision: "runtime-test",
      }),
  };
  const config = { resolveTTLMS: 10000, captureRpcContent: true };
  const identity = { kind, traceID: f.trace.traceID };
  const invoke = () =>
    collectWorkflowObservation("http://jaeger", identity, config, options);
  return { ...f, options, config, identity, queries, waits, invoke };
}

for (const kind of Object.keys(lifecyclePlans))
  for (const source of ["rpc", "cache", "shared", "shared-background"])
    test(`${kind} workflow collection preserves owning phases with ${source} Resolve`, async (t) => {
      const f = setup(t, kind, source),
        result = await f.invoke();
      assert.deepEqual(
        result.activities
          .slice(1)
          .map((activity) => activity.name.replace("lifecycle.", "")),
        lifecyclePlans[kind],
      );
      assert.equal(
        result.gateway_resolution.source,
        source.startsWith("shared") ? "shared" : source,
      );
      assert.equal(result.gateway_resolution.profile, "console");
      assert.equal(result.strict_trace, "passed");
      assert.deepEqual(f.waits, [6000, 1000, 1000]);
      assert.equal(f.queries.length, f.traces.size * 3);
    });

for (const kind of Object.keys(lifecyclePlans))
  test(`${kind} can retain the lifecycle closeout inspector result`, async (t) => {
    const f = setup(t, kind);
    f.options.inspect = (admission) =>
      inspectLifecycle({
        admission,
        requestID: f.requestID,
        agentID: f.agentID,
        kind,
      });
    const result = await f.invoke();
    assert.deepEqual(result.phases, lifecyclePlans[kind]);
    assert.equal(result.request_id, f.requestID);
    assert.equal(result.executor, "temporal");
  });

for (const [name, mutate] of [
  [
    "owner authorization missing",
    (f) => {
      f.trace.spans = f.trace.spans.filter(
        (s) => s.spanID !== "rpc-admit_agent",
      );
    },
  ],
  [
    "workflow identity",
    (f) =>
      setTag(
        f.trace.spans.find((s) => s.spanID === "workflow"),
        "temporalWorkflowID",
        "other",
      ),
  ],
  [
    "missing committed write",
    (f) => {
      f.trace.spans = f.trace.spans.filter(
        (s) => s.spanID !== "commit-publish",
      );
    },
  ],
  [
    "Runtime revision",
    (f) => {
      f.options.inspect = (trace) =>
        inspectWorkflow(trace, f.requestID, {
          kind: "create",
          agentID: f.agentID,
          runtimeRevision: "other",
        });
    },
  ],
  [
    "wrong Console route",
    (f) =>
      setTag(
        f.trace.spans.find((s) => s.spanID === "console"),
        "http.route",
        "/api/admin/templates",
      ),
  ],
])
  test(`workflow source adaptation retains ${name} rejection`, async (t) => {
    const f = setup(t, "create");
    mutate(f);
    await assert.rejects(f.invoke());
  });

test("unknown workflow kind rejects before fetching or waiting", async (t) => {
  const f = setup(t, "create");
  f.identity.kind = "restart";
  await assert.rejects(f.invoke());
  assert.deepEqual(f.queries, []);
  assert.deepEqual(f.waits, []);
});

test("current workflow diagnostics survive collection without becoming source error exceptions", async (t) => {
  const f = setup(t, "create", "shared");
  const write = f.trace.spans.find((s) => s.spanID === "sql-publish");
  setTag(write, "otel.status_code", "ERROR");
  const result = await f.invoke();
  assert.equal(result.strict_trace, "failed");
  assert.equal(result.error_spans, 1);
  setTag(
    f.traces.get("b".repeat(32)).spans.find((s) => s.spanID === "sql"),
    "otel.status_code",
    "ERROR",
  );
  await assert.rejects(f.invoke());
});
