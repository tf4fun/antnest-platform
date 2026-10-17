import assert from "node:assert/strict";
import test from "node:test";
import { completePermissionRuntimeFixture as fixture } from "./trace.fixture.mjs";
import { tag } from "../observability/trace-tree.mjs";
const url = new URL("./runtime-trace.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
const inspect = (f) => {
  assert.equal(
    typeof implementation.inspectPermissionRuntime,
    "function",
    "owning complete Runtime proof required",
  );
  return implementation.inspectPermissionRuntime(
    f.trace,
    f.expected,
    f.request,
    f.run,
  );
};
const phases = [
  "once",
  "once-again",
  "deny",
  "always",
  "follow",
  "reject",
  "reject-follow",
  "chat",
  "read-hint",
  "judge-safe",
  "judge-ask",
  "cancel",
  "reconnect",
];
for (const version of [1, 2])
  for (const phase of phases)
    test(`v${version}-${phase}: complete Runtime read/list/work inventory without changing raw evidence`, () => {
      const f = fixture(`v${version}-${phase}`);
      const before = structuredClone(f.trace);
      const result = inspect(f);
      assert.equal(result.informationReads, 1);
      assert.equal(result.postPromptInformationReads, 0);
      assert.equal(result.catalogReads, phase === "chat" ? 0 : 1);
      assert.equal(
        result.toolCalls,
        /deny|reject|cancel|chat/.test(phase) ? 0 : 1,
      );
      for (const span of f.trace.spans.filter(
        (row) =>
          f.trace.processes[row.processID].serviceName === "antnest-runtime",
      ))
        assert(
          result.spans.has(span),
          "Runtime span omitted from original inventory",
        );
      assert.deepEqual(f.trace, before);
    });

for (const phase of ["v1-once", "v1-chat", "v1-cancel", "v1-reconnect"])
  test(`${phase}: separate current-directory refresh with completed cleanup`, () => {
    const f = fixture(phase, { refresh: true, cleanup: true });
    const start = f.post.read.startTime;
    for (const span of f.trace.spans.filter((row) => row.startTime >= start))
      if (tag(span, "antnest.runtime.execution.id") !== undefined)
        f.field(span, "antnest.runtime.execution.id", "current-execution");
    const before = structuredClone(f.trace),
      result = inspect(f);
    assert.equal(result.informationReads, 2);
    assert.equal(result.postPromptInformationReads, 1);
    assert(result.neutralDiagnostics.length >= 2);
    assert.deepEqual(f.trace, before);
  });

const negative = [
  [
    "missing parsed information receipt",
    (f) => f.removeTree(f.information.read),
  ],
  [
    "Run read borrowed by list",
    (f) => {
      f.information.read.references[0].spanID = f.information.list.spanID;
    },
  ],
  [
    "read from foreign Agent",
    (f) => f.field(f.request, "antnest.agent.id", "foreign"),
  ],
  [
    "read from different pinned execution",
    (f) => f.field(f.run, "antnest.runtime.execution_id", "foreign"),
  ],
  [
    "preparation in a different ACP process",
    (f) => {
      f.trace.processes.other = structuredClone(
        f.trace.processes[f.information.info.processID],
      );
      f.information.info.processID = "other";
    },
  ],
  ["missing tool catalogue", (f) => f.removeTree(f.information.list)],
  [
    "failed parsed tool result",
    (f) => f.field(f.call, "antnest.mcp.tool_result.outcome", "tool_error"),
  ],
  [
    "failed connection close",
    (f) => f.field(f.call, "antnest.mcp.connection.close.outcome", "failed"),
  ],
  [
    "truncated Runtime response",
    (f) => {
      const client = f.trace.spans.find((s) => s.spanID === "call-http");
      f.field(client, "http.response.body.size", 1);
    },
  ],
  [
    "foreign Runtime generation",
    (f) => f.field(f.work, "antnest.runtime.generation", "other"),
  ],
  ["missing executor", (f) => f.removeTree(f.work)],
  ["wrong executor Tool", (f) => f.field(f.work, "executor.tool.name", "bash")],
  [
    "missing actual process PID",
    (f) => f.field(f.work, "executor.child.pid", "0"),
  ],
  ["failed executor exit", (f) => f.field(f.work, "process.exit.code", 1)],
  [
    "unfinished executor",
    (f) => f.field(f.work, "executor.exit.classification", "running"),
  ],
  [
    "lost Tool completion",
    (f) => {
      f.tool.logs = [];
    },
  ],
  [
    "lost executor completion",
    (f) => {
      f.work.logs = [];
    },
  ],
  [
    "hidden Runtime child",
    (f) => {
      f.trace.spans.push({
        ...structuredClone(f.work),
        spanID: "hidden",
        references: [
          {
            refType: "CHILD_OF",
            traceID: f.trace.traceID,
            spanID: f.work.spanID,
          },
        ],
      });
    },
  ],
  [
    "unowned Runtime HTTP client",
    (f) => {
      const span = structuredClone(f.information.client);
      span.spanID = "unowned";
      span.references[0].spanID = f.run.spanID;
      f.trace.spans.push(span);
    },
  ],
  [
    "hidden internal warning",
    (f) => {
      f.work.logs[0].fields.push({
        key: "exception.type",
        value: "InternalFailure",
      });
    },
  ],
];
for (const [name, mutate] of negative)
  test(`Runtime rejects ${name}`, () => {
    const f = fixture();
    inspect(f);
    mutate(f);
    assert.throws(() => inspect(f));
  });

test("Chat rejects a catalogue while an approval cancellation rejects an actual tool effect", () => {
  for (const phase of ["v2-chat", "v2-cancel"]) {
    const f = fixture(phase),
      source = fixture();
    inspect(f);
    const id = phase.endsWith("chat") ? "list" : "call";
    const selected = new Set([id]);
    for (let size = -1; size !== selected.size;) {
      size = selected.size;
      for (const span of source.trace.spans)
        if (
          span.references.some(
            (r) => r.refType === "CHILD_OF" && selected.has(r.spanID),
          )
        )
          selected.add(span.spanID);
    }
    f.trace.spans.push(
      ...source.trace.spans
        .filter((s) => selected.has(s.spanID))
        .map((s) => structuredClone(s)),
    );
    assert.throws(() => inspect(f));
  }
});
test("v2 cannot borrow a post-prompt v1 refresh", () => {
  inspect(fixture("v2-once"));
  const f = fixture("v2-once", { refresh: true });
  assert.throws(() => inspect(f));
});
test("v1 refresh cannot begin before the original Run's final internal operations", () => {
  const f = fixture("v1-once", { refresh: true });
  inspect(f);
  const delta = f.post.read.startTime - f.run.startTime;
  for (const span of f.trace.spans.filter((row) =>
    row.spanID.startsWith("post-"),
  )) {
    span.startTime -= delta;
    for (const entry of span.logs ?? []) entry.timestamp -= delta;
  }
  assert.throws(() => inspect(f));
});
test("v1 refresh accepts raw Run end overlap after all internal operation starts", () => {
  const f = fixture("v1-once", { refresh: true });
  f.run.duration = f.post.read.startTime - f.run.startTime + 200;
  const original = structuredClone(f.trace);
  assert.equal(inspect(f).postPromptInformationReads, 1);
  assert.deepEqual(f.trace, original);
});
test("managed echo requires its actual stdio result and published tool identity", () => {
  for (const mutate of [
    (f) => f.field(f.work, "mcp.tool.name", "mcp__foreign__echo"),
    (f) => f.field(f.work, "antnest.protocol.outcome", "error"),
    (f) => {
      f.tool.logs[0].fields.find((row) => row.key === "mcp.server.tool").value =
        "other";
    },
  ]) {
    const f = fixture("v2-judge-ask");
    inspect(f);
    mutate(f);
    assert.throws(() => inspect(f));
  }
});

for (const [key, value] of [
  ["process.exit.code", 7],
  ["executor.exit.classification", "canceled"],
])
  test(`successful Runtime Span cannot hide contradictory ${key} in its completion`, () => {
    const f = fixture();
    inspect(f);
    f.work.logs[0].fields.push({ key, value });
    assert.throws(() => inspect(f));
  });
