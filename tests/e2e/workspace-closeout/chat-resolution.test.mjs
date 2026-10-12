import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import * as chat from "./chat-trace.mjs";
import { workspaceChatFixture } from "./chat-fixtures.mjs";
import { temporaryStorageRoot } from "../../support/storage.mjs";
import { unreviewedWarnings } from "../../support/strict-findings.mjs";
import {
  sourceID,
  triggerID,
  resolvePrefix as prefix,
  setTag,
} from "../observability/gateway-resolution-fixtures.mjs";

const inspect = (f) => {
  assert.equal(typeof chat.inspectWorkspaceChatTrace, "function");
  return chat.inspectWorkspaceChatTrace(f.trace, f.expected, ["PRIVATE"], f);
};

for (const id of ["resolve-client", "resolve-server", "sql"])
  test(`HTTP Bridge admission rejects failed actual Resolve ${id} despite HTTP 200`, () => {
    const f = workspaceChatFixture("shared");
    inspect(f);
    setTag(
      f.traces.get(sourceID).spans.find((span) => span.spanID === id),
      "error",
      true,
    );
    assert.throws(() => inspect(f), /failed actual Resolve/u);
  });
for (const source of ["rpc", "cache", "shared"])
  test(`HTTP Bridge binds ${source} workspace admission to the observed model and durable Run`, () => {
    const f = workspaceChatFixture(source);
    const before = JSON.stringify([...f.traces.values()]);
    const checked = inspect(f);
    assert.equal(checked.gateway_resolution.source, source);
    assert.equal(checked.gateway_resolution.profile, "workspace");
    assert.equal(checked.run_id, "run-id");
    assert.equal(checked.provider_requests, 1);
    assert.equal(checked.persistence, true);
    assert.equal(JSON.stringify([...f.traces.values()]), before);
  });

test("HTTP Bridge retains both actual model requests around a real Runtime Tool", () => {
  const f = workspaceChatFixture("rpc");
  f.expected.requests[0].stage = "tool";
  f.add("second-model", "run", "model.complete");
  f.add("2222222222222222", "second-model", "HTTP POST model", {
    "span.kind": "client",
    "http.request.method": "POST",
  });
  f.expected.requests.push({
    ...f.expected.requests[0],
    stage: "reply",
    model_span_id: "2222222222222222",
  });
  f.add("tool-client", "run", "HTTP POST antnest-runtime", {
    "span.kind": "client",
  });
  f.add(
    "tool-server",
    "tool-client",
    "tools/call",
    { "span.kind": "server", "rpc.method": "tools/call" },
    "antnest-runtime",
  );
  const checked = inspect(f);
  assert.equal(checked.provider_requests, 2);
  assert.equal(checked.runtime_calls, 1);
});

test("successful Bridge chat cannot hide an unclassified error outcome", () => {
  const f = workspaceChatFixture();
  inspect(f);
  setTag(f.http, "antnest.outcome", "error");
  assert.throws(() => inspect(f), /error span in successful chat/u);
});

test("the declared held cancellation phase requires an observed Provider disconnect", () => {
  const f = workspaceChatFixture();
  inspect(f);
  f.expected.phase = f.expected.requests[0].phase = "c4-browser-hold-cancel";
  f.expected.runId = "run-id";
  assert.throws(() => inspect(f), /held model cancellation not observed/u);
});

for (const [name, change] of [
  ["wrong acp profile", (f) => setTag(f.decision, prefix + "profile", "acp")],
  [
    "duplicate decision",
    (f) =>
      f.trace.spans.push({
        ...structuredClone(f.decision),
        spanID: "duplicate",
      }),
  ],
  ["late admission", (f) => (f.decision.duration = 50000)],
  [
    "wrong model request",
    (f) => (f.expected.requests[0].model_span_id = "run"),
  ],
  ["foreign model trace", (f) => (f.expected.requests[0].trace_id = sourceID)],
  ["foreign phase", (f) => (f.expected.requests[0].phase = "other")],
  ["foreign Agent", (f) => (f.expected.agentId = "other")],
  [
    "missing Run SQL",
    (f) => (f.trace.spans = f.trace.spans.filter((s) => s.spanID !== "finish")),
  ],
  [
    "missing Bridge",
    (f) => (f.trace.spans = f.trace.spans.filter((s) => s.spanID !== "bridge")),
  ],
  ["missing source SQL", (f) => f.traces.get(sourceID).spans.pop()],
  ["missing source archive", (f) => f.archivedTraceIDs.delete(sourceID)],
  ["source private data", (f) => (f.traces.get(triggerID).private = "PRIVATE")],
  ["unexpected model", (f) => f.add("extra-model", "run", "model.complete")],
  ["missing Tool execution", (f) => (f.expected.requests[0].stage = "tool")],
])
  test(`HTTP Bridge rejects ${name}`, () => {
    const f = workspaceChatFixture("shared");
    inspect(f);
    change(f);
    assert.throws(() => inspect(f));
  });

test("held model cancellation keeps exact request, terminal SQL and strict failure", () => {
  const f = workspaceChatFixture("shared", true);
  f.root.duration = 30000; // The durable Run may finish after the HTTP response.
  const before = JSON.stringify([...f.traces.values()]);
  const checked = inspect(f);
  assert.equal(checked.expected_cancellation, true);
  assert.equal(checked.strict_trace, "failed");
  assert.equal(checked.errors, 2);
  assert.equal(checked.run_id, f.expected.runId);
  assert.equal(checked.persistence, true);
  assert.equal(JSON.stringify([...f.traces.values()]), before);
});

for (const [name, change] of [
  [
    "unrelated disconnected phase",
    (f) =>
      (f.expected.phase = f.expected.requests[0].phase =
        "c4-browser-hold-close"),
  ],
  [
    "duplicate provider request",
    (f) => f.expected.requests.push(structuredClone(f.expected.requests[0])),
  ],
  ["missing observed Run", (f) => delete f.expected.runId],
  ["wrong observed Run", (f) => (f.expected.runId = "other")],
  [
    "wrong origin",
    (f) => setTag(f.model, "antnest.error.origin_span_id", "run"),
  ],
  [
    "wrong origin trace",
    (f) => setTag(f.model, "antnest.error.origin_trace_id", sourceID),
  ],
  ["missing HTTP error event", (f) => delete f.http.logs],
  [
    "unrelated local model error event",
    (f) =>
      (f.model.logs = [
        ...(f.model.logs ?? []),
        {
          fields: [
            { key: "event", value: "antnest.error" },
            { key: "antnest.error.type", value: "SyntaxError" },
            { key: "antnest.error.code", value: "model_invalid_response" },
          ],
        },
      ]),
  ],
  [
    "wrong HTTP stage",
    (f) => setTag(f.http, "antnest.operation.phase", "other"),
  ],
  [
    "model returned 503",
    (f) => setTag(f.http, "http.response.status_code", 503),
  ],
  ["unresolved Run", (f) => setTag(f.run, "run.terminal_class", "unresolved")],
  ["live executor", (f) => setTag(f.run, "run.executor_state", "running")],
  ["unknown effects", (f) => setTag(f.run, "run.tool_effect_state", "unknown")],
  ["Run error", (f) => setTag(f.run, "error", true)],
  [
    "unrelated SQL error",
    (f) =>
      setTag(
        f.trace.spans.find((s) => s.spanID === "finish"),
        "error",
        true,
      ),
  ],
  ["unrelated Gateway error", (f) => setTag(f.root, "error", true)],
  ["extra Tool execution", (f) => f.add("tool", "run", "mcp.tools.call")],
])
  test(`held model cancellation rejects ${name}`, () => {
    const f = workspaceChatFixture("cache", true);
    inspect(f);
    change(f);
    assert.throws(() => inspect(f));
  });

function collection(t, cancelled = false) {
  const f = workspaceChatFixture("shared", cancelled);
  f.directory = mkdtempSync(join(temporaryStorageRoot(), "workspace-chat-"));
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));
  f.queries = [];
  f.request = async (url) => {
    const id = new URL(url).pathname.split("/").at(-1);
    f.queries.push(id);
    return Response.json({ data: [f.traces.get(id)] });
  };
  f.wait = async () => {};
  f.attempts = 4;
  return f;
}
const collect = (f) => {
  assert.equal(typeof chat.collectWorkspaceChatTrace, "function");
  return chat.collectWorkspaceChatTrace(
    "http://jaeger",
    f.expected,
    ["PRIVATE"],
    f,
  );
};

for (const cancelled of [false, true])
  test(`HTTP Bridge collector retains complete raw diagnostics, cancellation=${cancelled}`, async (t) => {
    const f = collection(t, cancelled);
    f.trace.warnings = ["current warning"];
    f.traces.get(triggerID).warnings = ["source warning"];
    const checked = await collect(f);
    assert.equal(checked.strict, "failed");
    assert.equal(checked.strict_trace, "failed");
    assert.equal(checked.warning_count, 2);
    assert.equal(checked.inspector_diagnostics.warnings, 1);
    assert.equal(checked.expected_cancellation === true, cancelled);
    assert.deepEqual(
      new Set(unreviewedWarnings(JSON.stringify(checked))),
      new Set(["current warning", "source warning"]),
    );
    assert.equal(f.queries.filter((id) => id === f.trace.traceID).length, 3);
    for (const [id, trace] of f.traces)
      assert.deepEqual(
        JSON.parse(readFileSync(join(f.directory, `${id}.json`))),
        trace,
      );
  });

test("HTTP Bridge owning inspector cannot be bypassed by a collector option", async (t) => {
  const f = collection(t);
  f.trace.spans = f.trace.spans.filter((s) => s.spanID !== "finish");
  f.inspect = () => ({ strict_trace: "passed" });
  await assert.rejects(collect(f), /durable Run closure/u);
});
