import assert from "node:assert/strict";
import test from "node:test";

const url = new URL("./warning-source.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (error.code === "ERR_MODULE_NOT_FOUND" && error.url === url.href)
    return {};
  throw error;
});
const inspect = (...args) => {
  assert.equal(typeof implementation.inspectCostWarningSources, "function");
  return implementation.inspectCostWarningSources(...args);
};
const warning =
  "clock skew adjustment disabled; not applying calculated delta of -517.433µs";
const tags = (values) =>
  Object.entries(values).map(([key, value]) => ({ key, value }));

function fixture(difference = 261) {
  const traceID = "a".repeat(32);
  const parent = {
    traceID,
    spanID: "1".repeat(16),
    processID: "node",
    operationName: "acp.session.prompt",
    startTime: 1000000,
    duration: 10000,
    references: [],
    tags: tags({ "span.kind": "server" }),
    warnings: [],
  };
  const child = {
    ...structuredClone(parent),
    spanID: "2".repeat(16),
    operationName: "acp.run",
    startTime: 1001000,
    duration: 9000 + difference,
    references: [{ refType: "CHILD_OF", traceID, spanID: parent.spanID }],
    warnings: [warning],
  };
  const trace = {
    traceID,
    warnings: [],
    processes: {
      node: {
        serviceName: "agent-acp-service",
        tags: tags({
          "host.name": "node-host",
          "process.pid": 41,
          "service.instance.id": "node-host:41",
          "process.runtime.name": "nodejs",
          "telemetry.sdk.name": "opentelemetry",
          "telemetry.sdk.language": "nodejs",
        }),
      },
    },
    spans: [parent, child],
  };
  const observation = {
    trace_id: traceID,
    span_id: child.spanID,
    parent_span_id: parent.spanID,
    process_id: child.processID,
    host_name: "node-host",
    process_pid: 41,
    service_instance_id: "node-host:41",
    boundary: "run-end",
    raw_left_us: child.startTime + child.duration,
    raw_right_us: parent.startTime + parent.duration,
    raw_difference_us: difference,
    raw_child_start_us: child.startTime,
    raw_parent_start_us: parent.startTime,
    reason: "deferred-same-node-sdk-sub-ms-endpoint",
  };
  return { trace, parent, child, observation };
}
const check = (f) => inspect([f.trace], [f.observation]);
const reject = (f) => {
  const result = check(f);
  assert.equal(result.eligible_for_deferral, false);
  assert(result.rejected_warning_count > 0);
  return result;
};

test("Cost warning review retains each original occurrence and never grants strict admission", () => {
  const f = fixture();
  const before = structuredClone(f);
  const result = check(f);
  assert.equal(result.warning_count, 1);
  assert.equal(result.deferred_warning_count, 1);
  assert.equal(result.rejected_warning_count, 0);
  assert.equal(result.eligible_for_deferral, true);
  assert.equal(result.inventory[0].trace_id, f.trace.traceID);
  assert.equal(result.inventory[0].span_id, f.child.spanID);
  assert.equal(result.inventory[0].warning_index, 0);
  assert.equal(result.inventory[0].warning, warning);
  assert.equal(result.sources[0].span_id, f.child.spanID);
  assert.equal(result.sources[0].parent_span_id, f.parent.spanID);
  assert.equal(result.sources[0].raw_end_beyond_parent_us, 261);
  assert.equal(result.sources[0].calculated_delta_us, -517.433);
  assert.equal(result.strict_trace, undefined);
  assert.equal(result.accepted, undefined);
  assert.deepEqual(f, before);
});

test("no warnings has an exact empty inventory", () => {
  const f = fixture();
  f.child.warnings = null;
  const result = check(f);
  assert.equal(result.warning_count, 0);
  assert.deepEqual(result.inventory, []);
  assert.deepEqual(result.sources, []);
});

for (const difference of [999, 1000, 1001])
  test(`Cost same-Node end difference ${difference}us respects the strict boundary`, () => {
    const result = check(fixture(difference));
    assert.equal(result.eligible_for_deferral, difference < 1000);
  });

test("the existing next-span observation shape binds the same direct parent", () => {
  const f = fixture();
  f.observation.next_span_id = f.observation.parent_span_id;
  f.observation.raw_span_start_us = f.observation.raw_child_start_us;
  f.observation.raw_next_start_us = f.observation.raw_parent_start_us;
  delete f.observation.parent_span_id;
  delete f.observation.raw_child_start_us;
  delete f.observation.raw_parent_start_us;
  assert.equal(check(f).eligible_for_deferral, true);
});

for (const [name, mutate] of [
  ["foreign Trace proof", (f) => (f.observation.trace_id = "b".repeat(32))],
  ["foreign span proof", (f) => (f.observation.span_id = "b".repeat(16))],
  [
    "foreign parent proof",
    (f) => (f.observation.parent_span_id = "b".repeat(16)),
  ],
  ["wrong difference", (f) => f.observation.raw_difference_us++],
  ["wrong endpoint", (f) => f.observation.raw_left_us++],
  ["wrong start", (f) => f.observation.raw_child_start_us++],
  ["foreign host proof", (f) => (f.observation.host_name = "other")],
  ["foreign PID proof", (f) => f.observation.process_pid++],
  [
    "foreign instance proof",
    (f) => (f.observation.service_instance_id = "other"),
  ],
  ["foreign process reference", (f) => (f.observation.process_id = "other")],
  [
    "integer-microsecond observation",
    (f) => (f.observation.reason = "jaeger-integer-microsecond-representation"),
  ],
  [
    "conflicting parent alias",
    (f) => (f.observation.next_span_id = "b".repeat(16)),
  ],
  ["conflicting start alias", (f) => (f.observation.raw_span_start_us = 5)],
  [
    "missing host",
    (f) =>
      (f.trace.processes.node.tags = f.trace.processes.node.tags.filter(
        (t) => t.key !== "host.name",
      )),
  ],
  [
    "duplicate identity tag",
    (f) =>
      f.trace.processes.node.tags.push({
        key: "host.name",
        value: "node-host",
      }),
  ],
  [
    "Go runtime",
    (f) => {
      for (const t of f.trace.processes.node.tags)
        if (["process.runtime.name", "telemetry.sdk.language"].includes(t.key))
          t.value = "go";
    },
  ],
  [
    "non-coarse start",
    (f) => {
      f.child.startTime++;
      f.child.duration--;
      f.observation.raw_child_start_us++;
    },
  ],
  [
    "calculated delta at one millisecond",
    (f) => (f.child.warnings = [warning.replace("-517.433µs", "1ms")]),
  ],
  ["unknown warning", (f) => (f.child.warnings = ["unknown warning"])],
  [
    "root warning without a parent",
    (f) => {
      f.parent.warnings = f.child.warnings;
      f.child.warnings = [];
    },
  ],
  [
    "trace-level warning",
    (f) => {
      f.trace.warnings = f.child.warnings;
      f.child.warnings = [];
    },
  ],
])
  test(`Cost warning cannot defer ${name}`, () => {
    const f = fixture();
    mutate(f);
    reject(f);
  });

test("missing or duplicate exact endpoint proofs cannot establish deferral", () => {
  const f = fixture();
  for (const observations of [[], [f.observation, f.observation]])
    assert.equal(inspect([f.trace], observations).eligible_for_deferral, false);
});

test("one Span's independent sibling-boundary observation is not a duplicate source proof", () => {
  const f = fixture();
  const sibling = {
    ...structuredClone(f.parent),
    spanID: "3".repeat(16),
    startTime: 1010000,
    duration: 500,
    references: [
      {
        refType: "CHILD_OF",
        traceID: f.trace.traceID,
        spanID: f.parent.spanID,
      },
    ],
  };
  f.trace.spans.push(sibling);
  const independent = {
    ...f.observation,
    boundary: "model-before-usage",
    next_span_id: sibling.spanID,
    raw_span_start_us: f.child.startTime,
    raw_next_start_us: sibling.startTime,
    raw_right_us: sibling.startTime,
    raw_difference_us: f.observation.raw_left_us - sibling.startTime,
  };
  delete independent.parent_span_id;
  delete independent.raw_child_start_us;
  delete independent.raw_parent_start_us;
  const result = inspect([f.trace], [f.observation, independent]);
  assert.equal(result.eligible_for_deferral, true);
  assert.equal(result.sources[0].parent_span_id, f.parent.spanID);
});

test("a contradictory observation for the actual source edge cannot accompany its proof", () => {
  const f = fixture();
  const conflicting = {
    ...f.observation,
    raw_right_us: f.observation.raw_right_us + 1,
  };
  assert.equal(
    inspect([f.trace], [f.observation, conflicting]).eligible_for_deferral,
    false,
  );
});

test("a matching end proof cannot defer a child that started before its parent", () => {
  const f = fixture();
  f.child.startTime = f.parent.startTime - 2000;
  f.child.duration = f.observation.raw_left_us - f.child.startTime;
  f.observation.raw_child_start_us = f.child.startTime;
  reject(f);
});

test("warning sources with identical text stay separate across Traces", () => {
  const first = fixture();
  const second = fixture(499);
  second.trace.traceID = "b".repeat(32);
  second.observation.trace_id = second.trace.traceID;
  for (const span of second.trace.spans) {
    span.traceID = second.trace.traceID;
    for (const reference of span.references)
      reference.traceID = second.trace.traceID;
  }
  const result = inspect(
    [first.trace, second.trace],
    [first.observation, second.observation],
  );
  assert.equal(result.warning_count, 2);
  assert.equal(result.sources.length, 2);
  assert.equal(result.eligible_for_deferral, true);
  assert.deepEqual(
    result.sources.map((source) => source.trace_id),
    [first.trace.traceID, second.trace.traceID],
  );
});

test("Go to Node warning propagation retains three occurrences on one cross-process edge", () => {
  const f = fixture();
  f.trace.processes.go = {
    serviceName: "agent-controller",
    tags: tags({
      "host.name": "go-host",
      "process.pid": 1,
      "service.instance.id": "controller:1",
      "process.runtime.name": "go",
      "telemetry.sdk.language": "go",
    }),
  };
  f.parent.processID = "go";
  f.parent.operationName = "HTTP POST agent-acp-service";
  f.child.operationName = "apply_execution_snapshot";
  for (const [index, operation] of ["SELECT", "UPDATE"].entries())
    f.trace.spans.push({
      ...structuredClone(f.child),
      spanID: String(index + 3).repeat(16),
      operationName: operation,
      startTime: 1002000 + index * 1000,
      duration: 200,
      references: [
        {
          refType: "CHILD_OF",
          traceID: f.trace.traceID,
          spanID: f.child.spanID,
        },
      ],
    });
  const result = reject(f);
  assert.equal(result.warning_count, 3);
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].classification, "cross-process");
  assert.equal(result.sources[0].occurrences.length, 3);
  assert.equal(new Set(result.inventory.map((r) => r.source_span_id)).size, 1);
  assert.equal(result.inventory[2].source_span_id, f.child.spanID);
});

test("same service name and PID cannot hide a different Node process", () => {
  const f = fixture();
  f.trace.processes.other = structuredClone(f.trace.processes.node);
  f.trace.processes.other.tags.find(
    (t) => t.key === "service.instance.id",
  ).value = "other-generation";
  f.parent.processID = "other";
  assert.equal(reject(f).sources[0].classification, "cross-process");
});

test("an added identical occurrence is retained and cannot borrow the original proof", () => {
  const f = fixture();
  f.child.warnings.push(warning);
  const result = reject(f);
  assert.equal(result.warning_count, 2);
  assert.deepEqual(
    result.inventory.map((r) => r.warning_index),
    [0, 1],
  );
  assert(
    result.inventory.every((r) => r.classification === "ambiguous-source"),
  );
});

for (const kind of ["second violated edge", "gap in propagation"])
  test(`same text with ${kind} cannot silently choose an origin`, () => {
    const f = fixture();
    const nested = {
      ...structuredClone(f.child),
      spanID: "3".repeat(16),
      startTime: 1002000,
      duration: kind === "second violated edge" ? 8500 : 100,
      references: [
        {
          refType: "CHILD_OF",
          traceID: f.trace.traceID,
          spanID: f.child.spanID,
        },
      ],
    };
    if (kind === "gap in propagation") {
      const middle = {
        ...structuredClone(nested),
        spanID: "4".repeat(16),
        duration: 1000,
        warnings: [],
      };
      nested.references[0].spanID = middle.spanID;
      f.trace.spans.push(middle);
    }
    f.trace.spans.push(nested);
    const result = reject(f);
    assert.equal(result.inventory.at(-1).classification, "ambiguous-source");
  });

test("a contained cross-process descendant cannot borrow its ancestor's proof", () => {
  const f = fixture();
  f.trace.processes.other = structuredClone(f.trace.processes.node);
  f.trace.processes.other.tags.find(
    (tag) => tag.key === "service.instance.id",
  ).value = "other-generation";
  f.trace.spans.push({
    ...structuredClone(f.child),
    spanID: "3".repeat(16),
    processID: "other",
    startTime: 1002000,
    duration: 100,
    references: [
      {
        refType: "CHILD_OF",
        traceID: f.trace.traceID,
        spanID: f.child.spanID,
      },
    ],
  });
  const result = reject(f);
  assert.equal(result.inventory.at(-1).classification, "ambiguous-source");
});

for (const [name, mutate] of [
  ["fractional start", (f) => (f.child.startTime += 0.5)],
  ["fractional duration", (f) => (f.child.duration += 0.5)],
  ["negative duration", (f) => (f.child.duration = -1)],
  ["unsafe start", (f) => (f.child.startTime = Number.MAX_SAFE_INTEGER + 1)],
  ["unsafe end", (f) => (f.child.startTime = Number.MAX_SAFE_INTEGER)],
  [
    "cycle",
    (f) =>
      f.parent.references.push({
        refType: "CHILD_OF",
        traceID: f.trace.traceID,
        spanID: f.child.spanID,
      }),
  ],
])
  test(`unsafe Cost warning source cannot establish a proof: ${name}`, () => {
    const f = fixture();
    mutate(f);
    assert.throws(() => check(f), /invalid Cost warning sources/u);
  });

test("a real WS root's external connection Link is not a synchronous parent", () => {
  const f = fixture();
  f.parent.references.push({
    refType: "FOLLOWS_FROM",
    traceID: "b".repeat(32),
    spanID: "4".repeat(16),
  });
  assert.equal(check(f).eligible_for_deferral, true);
});

test("an extra asynchronous Link does not replace a valid CHILD_OF edge", () => {
  const f = fixture();
  f.child.references.push({
    refType: "FOLLOWS_FROM",
    traceID: "b".repeat(32),
    spanID: "4".repeat(16),
  });
  assert.equal(check(f).eligible_for_deferral, true);
});

test("a FOLLOWS_FROM Link cannot prove a warning's synchronous source edge", () => {
  const f = fixture();
  f.child.references[0].refType = "FOLLOWS_FROM";
  const result = reject(f);
  assert.equal(result.inventory[0].classification, "unattributed-warning");
  assert.deepEqual(result.sources, []);
});

for (const [name, mutate] of [
  [
    "duplicate CHILD_OF",
    (f) => f.child.references.push({ ...f.child.references[0] }),
  ],
  ["foreign CHILD_OF", (f) => (f.child.references[0].traceID = "b".repeat(32))],
  [
    "unknown reference type",
    (f) => (f.child.references[0].refType = "UNKNOWN"),
  ],
  [
    "malformed asynchronous Link",
    (f) =>
      f.parent.references.push({
        refType: "FOLLOWS_FROM",
        traceID: "b".repeat(32),
        spanID: "invalid",
      }),
  ],
])
  test(`an invalid reference cannot establish a warning source: ${name}`, () => {
    const f = fixture();
    mutate(f);
    assert.throws(() => check(f), /invalid Cost warning sources/u);
  });

test("duplicate Trace IDs cannot share a source inventory", () => {
  const f = fixture();
  assert.throws(
    () => inspect([f.trace, structuredClone(f.trace)], [f.observation]),
    /invalid Cost warning sources/u,
  );
});

for (const kind of [
  "missing parent",
  "duplicate span",
  "invalid time",
  "malformed warning",
])
  test(`invalid Cost raw warning source fails safely: ${kind}`, () => {
    const f = fixture();
    if (kind === "missing parent") f.trace.spans.shift();
    if (kind === "duplicate span") f.trace.spans.push(f.child);
    if (kind === "invalid time") f.child.duration = NaN;
    if (kind === "malformed warning") f.child.warnings = { private: "SECRET" };
    assert.throws(() => check(f), /invalid Cost warning sources/u);
  });
