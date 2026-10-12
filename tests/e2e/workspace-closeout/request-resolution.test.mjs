import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import * as workspace from "./current-trace.mjs";
import { inspectCommandTrace } from "../acp-commands/trace.mjs";
import { temporaryStorageRoot } from "../../support/storage.mjs";
import { unreviewedWarnings } from "../../support/strict-findings.mjs";
import { fields } from "../observability/trace-fixtures.mjs";
import { fixture } from "./request-resolution-fixtures.mjs";
import {
  sourceID,
  triggerID,
  resolvePrefix as prefix,
  setTag,
} from "../observability/gateway-resolution-fixtures.mjs";

const inspect = (f) => {
  assert.equal(typeof workspace.inspectWorkspaceRequestResolution, "function");
  return workspace.inspectWorkspaceRequestResolution(
    f.trace,
    f.expected,
    ["PRIVATE"],
    f,
  );
};

for (const id of ["resolve-client", "resolve-server", "sql"])
  test(`ACP admission rejects failed actual Resolve ${id} despite HTTP 200`, () => {
    const f = fixture("shared");
    inspect(f);
    setTag(
      f.traces.get(sourceID).spans.find((span) => span.spanID === id),
      "error",
      true,
    );
    assert.throws(() => inspect(f), /failed actual Resolve/u);
  });

for (const transport of ["websocket", "http"])
  for (const source of ["cache", "rpc", "shared"])
    test(`direct ACP ${transport} verifies actual ${source} admission with acp profile`, () => {
      const f = fixture(source, transport);
      const before = JSON.stringify([...f.traces.values()]);
      const checked = inspect(f);
      assert.equal(checked.source, source);
      assert.equal(checked.profile, "acp");
      assert.equal(checked.admission, true);
      assert.equal(
        inspectCommandTrace(f.trace, f.expected).no_model_or_tools,
        true,
      );
      assert.equal(JSON.stringify([...f.traces.values()]), before);
    });

for (const [name, mutate] of [
  [
    "missing decision",
    (f) => f.trace.spans.splice(f.trace.spans.indexOf(f.decision), 1),
  ],
  [
    "duplicate decision",
    (f) =>
      f.trace.spans.push({
        ...structuredClone(f.decision),
        spanID: "duplicate",
      }),
  ],
  [
    "wrong workspace profile",
    (f) => setTag(f.decision, prefix + "profile", "workspace"),
  ],
  ["late admission", (f) => (f.decision.duration = 50000)],
  ["wrong actual request", (f) => (f.expected.requestId = "other")],
  ["wrong connection", (f) => (f.expected.connectionTraceID = "e".repeat(32))],
  ["wrong Agent", (f) => (f.expected.agentId = "other")],
  ["missing source archive", (f) => f.archivedTraceIDs.delete(sourceID)],
  ["source SQL missing", (f) => f.traces.get(sourceID).spans.pop()],
  ["source secret", (f) => (f.traces.get(sourceID).private = "PRIVATE")],
  [
    "source unknown attribute",
    (f) => setTag(f.traces.get(sourceID).spans[0], prefix + "private", "bad"),
  ],
  [
    "source content captured",
    (f) =>
      (f.traces.get(sourceID).spans[0].logs = [
        { fields: fields({ "antnest.payload.json": "{}" }) },
      ]),
  ],
])
  test(`ACP request admission rejects ${name}`, () => {
    const f = fixture("shared");
    inspect(f);
    mutate(f);
    assert.throws(() => inspect(f));
  });

function collection(t, source = "shared", transport = "websocket") {
  const f = fixture(source, transport);
  const directory = mkdtempSync(
    join(temporaryStorageRoot(), "workspace-request-"),
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const queries = [];
  const request = async (url) => {
    const path = new URL(url).pathname;
    queries.push(path);
    if (path === "/api/v3/trace-summaries")
      return Response.json({ summaries: [{ traceId: f.trace.traceID }] });
    return Response.json({ data: [f.traces.get(path.split("/").at(-1))] });
  };
  let inspections = 0;
  return Object.assign(f, {
    directory,
    queries,
    request,
    wait: async () => {},
    attempts: 4,
    getInspections: () => inspections,
    inspect: async (trace, expected, secrets, calls) => {
      await Promise.resolve();
      inspections++;
      return inspectCommandTrace(trace, expected, secrets, calls);
    },
  });
}
const collect = (f) => {
  assert.equal(typeof workspace.collectWorkspaceRequestTrace, "function");
  return workspace.collectWorkspaceRequestTrace(
    "http://jaeger",
    f.expected,
    ["PRIVATE"],
    [],
    f,
  );
};

for (const transport of ["websocket", "http"])
  test(`${transport} collector awaits owning gates and archives full source closure`, async (t) => {
    const f = collection(t, "shared", transport);
    const checked = await collect(f);
    assert.equal(checked.gateway_resolution.source, "shared");
    assert.equal(checked.no_model_or_tools, true);
    assert.equal(f.getInspections(), 3);
    assert.equal(
      f.queries.includes("/api/v3/trace-summaries"),
      transport === "websocket",
    );
    for (const [id, trace] of f.traces)
      assert.deepEqual(
        JSON.parse(readFileSync(join(f.directory, `${id}.json`))),
        trace,
      );
  });

test("ACP collector disambiguates repeated request IDs by the observed connection", async (t) => {
  const f = collection(t, "cache");
  const foreign = structuredClone(f.trace);
  foreign.traceID = "f".repeat(32);
  foreign.spans[0].references[0].traceID = "e".repeat(32);
  f.traces.set(foreign.traceID, foreign);
  const request = f.request;
  f.request = async (url, options) =>
    new URL(url).pathname === "/api/v3/trace-summaries"
      ? Response.json({
          summaries: [
            { traceId: foreign.traceID },
            { traceId: f.trace.traceID },
          ],
        })
      : request(url, options);
  assert.equal((await collect(f)).trace_id, f.trace.traceID);
});

test("ACP collector rejects ambiguous actual requests before owning admission", async (t) => {
  const f = collection(t, "cache");
  const duplicate = structuredClone(f.trace);
  duplicate.traceID = "f".repeat(32);
  f.traces.set(duplicate.traceID, duplicate);
  const request = f.request;
  f.request = async (url, options) =>
    new URL(url).pathname === "/api/v3/trace-summaries"
      ? Response.json({
          summaries: [
            { traceId: duplicate.traceID },
            { traceId: f.trace.traceID },
          ],
        })
      : request(url, options);
  await assert.rejects(collect(f), /ambiguous actual request trace/u);
  assert.equal(f.getInspections(), 0);
});

test("ACP collector preserves business failure and unknown source diagnostics", async (t) => {
  const f = collection(t);
  f.traces.get(triggerID).warnings = ["unknown source warning"];
  const inspect = f.inspect;
  f.inspect = async (...args) => ({
    ...(await inspect(...args)),
    strict_trace: "failed",
    warnings: ["business warning"],
  });
  const checked = await collect(f);
  assert.equal(checked.strict_trace, "failed");
  assert.deepEqual(checked.inspector_diagnostics.warnings, [
    "business warning",
  ]);
  assert.deepEqual(
    new Set(unreviewedWarnings(JSON.stringify(checked))),
    new Set(["business warning", "unknown source warning"]),
  );
});

test("ACP collector cannot replace a failing business gate with valid cache admission", async (t) => {
  const f = collection(t, "cache");
  f.inspect = async () => {
    throw new Error("durable Run closure missing");
  };
  await assert.rejects(collect(f), /durable Run closure missing/u);
});

test("ACP selection abort waits for the active response and never starts admission", async (t) => {
  const f = collection(t, "cache");
  const abort = new AbortController();
  f.signal = abort.signal;
  let completed = false;
  f.request = async () => ({
    ok: true,
    json: async () => {
      abort.abort(new Error("stop request collection"));
      await Promise.resolve();
      completed = true;
      return { summaries: [] };
    },
  });
  await assert.rejects(collect(f), /stop request collection/u);
  assert.equal(completed, true);
  assert.equal(f.getInspections(), 0);
});

test("failed source admission still reports the selected WebSocket message identity", async (t) => {
  const f = collection(t);
  delete f.expected.traceID;
  f.traces.get(sourceID).spans.pop();
  let selected;
  f.onSelected = (traceID) => {
    selected = traceID;
  };
  await assert.rejects(collect(f), /owning SERVER has zero PostgreSQL spans/u);
  assert.equal(selected, f.trace.traceID);
  assert.notEqual(selected, f.expected.connectionTraceID);
  assert.equal(
    JSON.parse(readFileSync(join(f.directory, `${selected}.json`))).traceID,
    selected,
  );
});
