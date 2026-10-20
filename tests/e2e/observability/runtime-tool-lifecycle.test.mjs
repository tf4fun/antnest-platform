import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "../acp-commands/trace-fixtures.mjs";
import { inspectCommandTrace } from "../acp-commands/trace.mjs";
import { privateBoundaryFixture } from "../acp-plan/private-boundary.fixture.mjs";
import { execution as fileFixture } from "../acp-files/trace-fixtures.mjs";
import { inspectFileTrace } from "../acp-files/trace.mjs";
import { scaleReadFixtureTrace } from "./runtime-information-timing-fixture.mjs";
import { inspectRunInformationReads } from "./runtime-information-run.mjs";
import { addToolLifecycleReceipt } from "./runtime-information-run-fixtures.mjs";
import { setTag } from "./gateway-resolution-fixtures.mjs";
import { tag, traceTopology } from "./trace-tree.mjs";

const inspect = (f) =>
  inspectRunInformationReads(f.trace, {
    request: f.information.request,
    run: f.information.run,
  });
const make = (method = "tools/call", options) => {
  const f = fixture("ordinary");
  const owner = f.trace.spans.find(
    (span) =>
      span.operationName ===
      method.replace("/", ".").replace("tools.", "mcp.tools."),
  );
  const proof = addToolLifecycleReceipt(f.trace, owner, options);
  const invocation = proof.pairs.find(
    ({ server }) => tag(server, "rpc.method") === method,
  );
  const discovery = proof.pairs.find(
    ({ server }) => tag(server, "rpc.method") === "discover",
  );
  return { ...f, ...proof, invocation, discovery };
};
const event = (span, name) =>
  span.logs.find((row) => tag({ tags: row.fields }, "event") === name);
const field = (row, key, value) => {
  const span = { tags: row.fields };
  setTag(span, key, value);
  row.fields = span.tags;
};

for (const method of ["tools/list", "tools/call"])
  for (const cancelled of [false, true])
    test(`${method} accepts the production Rust Runtime resource shape (owned close=${cancelled})`, () => {
      const f = make(method, {
        cancelledClients: cancelled ? [method] : [],
        cancelledServers: cancelled ? [method] : [],
      });
      for (const resource of Object.values(f.trace.processes)) {
        if (resource.serviceName !== "antnest-runtime") continue;
        resource.tags = resource.tags.filter(
          ({ key }) =>
            !["host.name", "process.pid", "service.instance.id"].includes(key),
        );
        setTag(
          resource,
          "antnest.agent.id",
          tag(f.invocation.server, "antnest.agent.id"),
        );
        setTag(
          resource,
          "antnest.runtime.generation",
          tag(f.invocation.server, "antnest.runtime.generation"),
        );
      }
      const raw = structuredClone(f.trace);
      inspect(f);
      assert.deepEqual(f.trace, raw);
    });

for (const key of ["antnest.agent.id", "antnest.runtime.generation"])
  for (const value of [undefined, "foreign"])
    test(`tool Runtime resource rejects ${key}=${value}`, () => {
      const f = make();
      const resource = f.trace.processes[f.invocation.server.processID];
      if (value === undefined)
        resource.tags = resource.tags.filter((item) => item.key !== key);
      else setTag(resource, key, value);
      assert.throws(() => inspect(f));
    });

for (const method of ["tools/list", "tools/call"]) {
  test(`${method} dispatch uses readiness while discovery HTTP EOF is held`, () => {
    const f = make(method, { heldDiscovery: true });
    assert(
      f.discovery.client.startTime + f.discovery.client.duration >
        f.invocation.client.startTime,
    );
    const raw = structuredClone(f.trace);
    inspect(f);
    assert.deepEqual(f.trace, raw);
  });
  test(`${method} accepts backend event array order independently of original timestamps`, () => {
    const f = make(method);
    f.owner.logs.reverse();
    const raw = structuredClone(f.trace);
    inspect(f);
    assert.deepEqual(f.trace, raw);
  });
  for (const rpc of ["discover", method]) {
    for (const serverCancelled of [false, true])
      test(`${method} owns exact ${rpc} close cancellation (Runtime canceled=${serverCancelled})`, () => {
        const f = make(method, {
          heldDiscovery: true,
          cancelledClients: [rpc],
          cancelledServers: serverCancelled ? [rpc] : [],
        });
        const raw = structuredClone(f.trace);
        const result = inspect(f);
        assert.equal(result.neutralDiagnostics.length, serverCancelled ? 2 : 1);
        assert.deepEqual(f.trace, raw);
      });
  }
  for (const [name, mutate] of [
    ["missing readiness", (f) => f.owner.logs.splice(0, 1)],
    [
      "duplicate readiness",
      (f) => f.owner.logs.push(structuredClone(f.owner.logs[0])),
    ],
    ["missing parsed result", (f) => f.owner.logs.splice(2, 1)],
    [
      "resource receipt borrowed by tools",
      (f) => field(f.owner.logs[2], "event", "antnest.mcp.resource.validated"),
    ],
    [
      "dispatch before readiness",
      (f) => (f.owner.logs[1].timestamp = f.owner.logs[0].timestamp - 1),
    ],
    [
      "parsed before HTTP dispatch",
      (f) => (f.owner.logs[2].timestamp = f.invocation.client.startTime - 1),
    ],
    [
      "close before parsed",
      (f) => (f.owner.logs[3].timestamp = f.owner.logs[2].timestamp - 1),
    ],
    [
      "extra lifecycle content",
      (f) =>
        f.owner.logs[0].fields.push({ key: "arguments", value: "private" }),
    ],
    [
      "event outside owning span",
      (f) =>
        (f.owner.logs[4].timestamp = f.owner.startTime + f.owner.duration + 1),
    ],
    [
      "missing method",
      (f) =>
        (f.owner.tags = f.owner.tags.filter(
          ({ key }) => key !== "antnest.mcp.method",
        )),
    ],
    [
      "wrong method",
      (f) => setTag(f.owner, "antnest.mcp.method", "resources/read"),
    ],
    [
      "wrong pinned execution",
      (f) => setTag(f.owner, "antnest.runtime.execution.id", "foreign"),
    ],
    [
      "wrong client process",
      (f) => {
        f.trace.processes.foreign = structuredClone(
          f.trace.processes[f.owner.processID],
        );
        f.invocation.client.processID = "foreign";
      },
    ],
    [
      "missing actual ACP process identity",
      (f) => (f.trace.processes[f.owner.processID].tags = []),
    ],
    [
      "different Runtime process",
      (f) => {
        f.trace.processes.foreign = structuredClone(
          f.trace.processes[f.invocation.server.processID],
        );
        f.invocation.server.processID = "foreign";
      },
    ],
    [
      "different Runtime generation",
      (f) => setTag(f.invocation.server, "antnest.runtime.generation", "other"),
    ],
    [
      "incomplete response byte count",
      (f) => setTag(f.invocation.client, "http.response.body.size", 1),
    ],
    [
      "missing result outcome",
      (f) =>
        (f.owner.tags = f.owner.tags.filter(
          ({ key }) => key !== "antnest.mcp.tool_result.outcome",
        )),
    ],
    [
      "unparsed result",
      (f) => setTag(f.owner, "antnest.mcp.tool_result.outcome", "not_received"),
    ],
    [
      "failed close",
      (f) => setTag(f.owner, "antnest.mcp.connection.close.outcome", "failed"),
    ],
    [
      "caller cancellation",
      (f) => setTag(f.owner, "antnest.mcp.caller_cancelled", true),
    ],
    [
      "caller cancelled at close",
      (f) => field(f.owner.logs[3], "antnest.mcp.caller_cancelled", true),
    ],
    ["unknown owner error", (f) => setTag(f.owner, "error.type", "unknown")],
    [
      "duplicate HTTP status",
      (f) =>
        f.invocation.client.tags.unshift({
          key: "http.response.status_code",
          value: 503,
        }),
    ],
    [
      "HTTP conflicting legacy error",
      (f) => setTag(f.invocation.client, "http.status_code", 503),
    ],
    [
      "extra owner exception",
      (f) =>
        f.owner.logs.push({
          timestamp: f.owner.startTime,
          fields: [{ key: "event", value: "exception" }],
        }),
    ],
    [
      "unknown HTTP warning",
      (f) =>
        f.invocation.client.logs.push({
          timestamp: f.invocation.client.startTime,
          fields: [{ key: "level", value: "WARN" }],
        }),
    ],
    ["unjoined CLIENT", (f) => (f.invocation.client.duration += 5000)],
    [
      "dispatch after invocation start",
      (f) => (f.owner.logs[1].timestamp = f.invocation.client.startTime + 2000),
    ],
  ])
    test(`${method} rejects ${name}`, () => {
      const f = make(method);
      mutate(f);
      assert.throws(() => inspect(f));
    });
  for (const [name, mutate] of [
    [
      "cancel before close",
      (f) => (f.invocation.client.logs[0].timestamp = f.owner.startTime + 310),
    ],
    [
      "cancel after close",
      (f) => {
        const at = f.owner.logs[4].timestamp + 1;
        f.invocation.client.logs[0].timestamp = at;
        f.invocation.client.duration = at - f.invocation.client.startTime;
      },
    ],
    [
      "cancel after its own CLIENT",
      (f) =>
        (f.invocation.client.logs[0].timestamp =
          f.invocation.client.startTime + f.invocation.client.duration + 1),
    ],
    ["missing cancellation event", (f) => (f.invocation.client.logs = [])],
    [
      "unknown cancellation cause",
      (f) =>
        field(
          f.invocation.client.logs[0],
          "antnest.cancellation.type",
          "TimeoutError",
        ),
    ],
    [
      "extra cancellation error",
      (f) => setTag(f.invocation.client, "error", true),
    ],
    [
      "Runtime cancellation without successful operation",
      (f) =>
        setTag(
          f.trace.spans.find(
            (span) => span.spanID === f.invocation.server.spanID + "-operation",
          ),
          "mcp.operation.outcome",
          "error",
        ),
    ],
    [
      "Runtime cancellation before operation joined",
      (f) =>
        (f.invocation.server.logs[0].timestamp = f.invocation.server.startTime),
    ],
    [
      "unknown Runtime failure",
      (f) => setTag(f.invocation.server, "error", true),
    ],
  ])
    test(`${method} rejects ${name} despite an owned close`, () => {
      const f = make(method, {
        cancelledClients: [method],
        cancelledServers: [method],
      });
      mutate(f);
      assert.throws(() => inspect(f));
    });
}

for (const version of [1, 2])
  for (const boundary of ["gateway", "private"])
    test(`ordinary v${version} ${boundary} Run keeps exact tool close evidence`, () => {
      let f = fixture("ordinary");
      setTag(f.information.request, "antnest.protocol.version", `v${version}`);
      for (const owner of f.trace.spans.filter((span) =>
        ["mcp.tools.list", "mcp.tools.call"].includes(span.operationName),
      ))
        addToolLifecycleReceipt(f.trace, owner, {
          heldDiscovery: true,
          cancelledClients: [tag(owner, "antnest.mcp.method")],
        });
      if (boundary === "private") f = privateBoundaryFixture(f, { version });
      const raw = structuredClone(f.trace);
      const result = inspectCommandTrace(f.trace, f.expected, [], f.requests);
      assert.equal(result.neutral_diagnostics.length, 2);
      assert.deepEqual(f.trace, raw);
    });

test("a tool connection cannot borrow another owner's complete lifecycle", () => {
  const f = make("tools/call");
  const list = f.trace.spans.find(
    (span) => span.operationName === "mcp.tools.list",
  );
  f.owner.logs = structuredClone(list.logs);
  assert.throws(() => inspect(f));
});

test("tool inventory does not reject its separately owned revision SQL", () => {
  const f = make("tools/list");
  f.trace.spans.push({
    ...structuredClone(f.owner),
    spanID: "list-revision-sql",
    operationName: "SELECT",
    duration: 1,
    references: [
      { refType: "CHILD_OF", traceID: f.trace.traceID, spanID: f.owner.spanID },
    ],
    tags: [
      { key: "span.kind", value: "client" },
      { key: "db.system.name", value: "postgresql" },
    ],
    logs: [],
  });
  inspect(f);
});

for (const name of ["runtime.mcp.operation", "HTTP POST /mcp"])
  test(`Run inventory rejects an extra ${name} hidden under the proven tool operation`, () => {
    const f = make();
    const operation = f.trace.spans.find(
      (span) => span.spanID === f.invocation.server.spanID + "-operation",
    );
    const extra = structuredClone(
      name === "runtime.mcp.operation" ? operation : f.invocation.server,
    );
    extra.spanID = "extra-runtime-protocol";
    extra.references = [
      {
        refType: "CHILD_OF",
        traceID: f.trace.traceID,
        spanID: operation.spanID,
      },
    ];
    extra.startTime = operation.startTime + 1;
    extra.duration = 1;
    for (const log of extra.logs) {
      log.timestamp = extra.startTime;
      field(log, "span_id", extra.spanID);
    }
    f.trace.spans.push(extra);
    assert.throws(() => inspect(f));
  });

for (const location of [
  "server tags",
  "server completion",
  "operation tags",
  "operation completion",
])
  for (const cancelled of [false, true])
    test(`tool diagnostics reject failed executor classification in ${location} (owned close=${cancelled})`, () => {
      const f = make("tools/call", {
        cancelledClients: cancelled ? ["tools/call"] : [],
        cancelledServers: cancelled ? ["tools/call"] : [],
      });
      const span = location.startsWith("server")
        ? f.invocation.server
        : f.trace.spans.find(
            (item) => item.spanID === f.invocation.server.spanID + "-operation",
          );
      if (location.endsWith("tags"))
        setTag(span, "executor.exit.classification", "failed");
      else field(span.logs.at(-1), "executor.exit.classification", "failed");
      assert.throws(() => inspect(f));
    });

function parsedToolError(f) {
  const tree = traceTopology(f.trace);
  const owner = f.trace.spans.find(
    (span) => span.operationName === "mcp.tools.call",
  );
  const server = f.trace.spans.find(
    (span) =>
      tag(span, "rpc.method") === "tools/call" &&
      tree.service(span) === "antnest-runtime",
  );
  const operation = f.trace.spans.find((span) => tree.parent(span) === server);
  for (const [key, value] of Object.entries({
    "antnest.mcp.tool_result.outcome": "tool_error",
    "antnest.outcome": "tool_error",
    "error.type": "mcp_tool_error",
    "otel.status_code": "ERROR",
    error: true,
  }))
    setTag(owner, key, value);
  field(
    event(owner, "antnest.mcp.tool.result.parsed"),
    "outcome",
    "tool_error",
  );
  setTag(server, "antnest.protocol.outcome", "error");
  for (const span of [server, operation]) {
    setTag(span, "error.type", "invalid_path");
    setTag(span, "otel.status_code", "ERROR");
    setTag(span, "error", true);
  }
  setTag(operation, "mcp.operation.outcome", "error");
  setTag(operation, "antnest.operation.outcome", "rejected");
  field(operation.logs[0], "mcp.operation.outcome", "error");
  field(operation.logs[0], "error.type", "invalid_path");
  operation.logs.unshift({
    timestamp: operation.startTime + operation.duration - 2,
    fields: Object.entries({
      event: "antnest.error",
      "antnest.error.stage": "mcp.dispatch",
      "antnest.error.type": "invalid_path",
      "antnest.error.code": "invalid_path",
      "antnest.error.message": "Tool returned an unsuccessful protocol result",
    }).map(([key, value]) => ({ key, value })),
  });
  return owner;
}

test("parsed tool_error remains visible and only the deliberate failed-edit scenario accepts it", () => {
  const f = fileFixture("v2-failed-edit");
  const owner = parsedToolError(f);
  const raw = structuredClone(f.trace);
  const proof = inspect(f).toolLifecycles.find((item) => item.owner === owner);
  assert.equal(proof.parsedOutcome, "tool_error");
  assert.equal(proof.neutralDiagnostics.length, 0);
  assert.equal(
    inspectFileTrace(f.trace, f.requests).reviewed_error_spans.length,
    3,
  );
  assert.throws(() =>
    inspectFileTrace(f.trace, [{ ...f.requests[0], phase: "v2-create" }]),
  );
  assert.deepEqual(f.trace, raw);
  const ordinary = make();
  parsedToolError(ordinary);
  assert.throws(() =>
    inspectCommandTrace(
      ordinary.trace,
      ordinary.expected,
      [],
      ordinary.requests,
    ),
  );
});

test("parsed tool_error retains Runtime ERROR and disconnect WARN during owned close", () => {
  const f = make("tools/call", {
    cancelledClients: ["tools/call"],
    cancelledServers: ["tools/call"],
  });
  parsedToolError(f);
  // Runtime's protocol-failed branch keeps the HTTP warning without claiming
  // the success-only antnest.cancelled receipt.
  f.invocation.server.logs = f.invocation.server.logs.filter(
    (row) => tag({ tags: row.fields }, "event") !== "antnest.cancelled",
  );
  const raw = structuredClone(f.trace);
  const proof = inspect(f).toolLifecycles.find(
    (item) => item.owner === f.owner,
  );
  assert.equal(proof.parsedOutcome, "tool_error");
  assert.equal(proof.neutralDiagnostics.length, 1);
  assert.equal(proof.neutralDiagnostics[0].span_id, f.invocation.client.spanID);
  assert.equal(tag(f.invocation.server, "otel.status_code"), "ERROR");
  assert.equal(
    tag({ tags: f.invocation.server.logs[0].fields }, "level"),
    "WARN",
  );
  assert.throws(() => inspectCommandTrace(f.trace, f.expected, [], f.requests));
  assert.deepEqual(f.trace, raw);
});

for (const [name, mutate] of [
  ["missing ERROR status", (f) => setTag(f.owner, "otel.status_code", "OK")],
  [
    "unknown owner error",
    (f) => setTag(f.owner, "error.type", "dependency_failed"),
  ],
  [
    "unrelated Runtime exception",
    (f) =>
      f.invocation.server.logs.push({
        timestamp: f.invocation.server.startTime,
        fields: [{ key: "event", value: "exception" }],
      }),
  ],
  [
    "caller abort",
    (f) => setTag(f.owner, "antnest.mcp.caller_cancelled", true),
  ],
])
  test(`parsed tool_error does not conceal ${name}`, () => {
    const f = make();
    parsedToolError(f);
    mutate(f);
    assert.throws(() => inspect(f));
  });

test("tool endpoint observations keep original same-process values and strict own-span event bounds", () => {
  const f = make();
  scaleReadFixtureTrace(f.trace);
  const closed = event(f.owner, "antnest.mcp.connection.close.completed");
  f.invocation.client.duration =
    closed.timestamp + 1 - f.invocation.client.startTime;
  const raw = structuredClone(f.trace);
  const result = inspect(f);
  const observation = result.timeObservations.find(
    (row) => row.tool_span_id === f.owner.spanID,
  );
  assert.equal(observation.boundary, "client-joined-at-tool-close");
  assert.equal(observation.raw_difference_us, 1);
  assert.equal(
    observation.raw_left_us,
    f.invocation.client.startTime + f.invocation.client.duration,
  );
  assert.equal(observation.raw_right_us, closed.timestamp);
  assert.deepEqual(f.trace, raw);
  f.owner.logs[4].timestamp = f.owner.startTime + f.owner.duration + 1;
  assert.throws(() => inspect(f));
});
for (const [name, mutate] of [
  ["one millisecond", (f) => (f.invocation.client.duration += 999)],
  ["non-integer-ms anchor", (f) => (f.invocation.client.startTime += 1)],
  [
    "missing process identity",
    (f) => (f.trace.processes[f.owner.processID].tags = []),
  ],
])
  test(`tool endpoint observation rejects ${name}`, () => {
    const f = make();
    scaleReadFixtureTrace(f.trace);
    const closed = event(f.owner, "antnest.mcp.connection.close.completed");
    f.invocation.client.duration =
      closed.timestamp + 1 - f.invocation.client.startTime;
    mutate(f);
    assert.throws(() => inspect(f));
  });
