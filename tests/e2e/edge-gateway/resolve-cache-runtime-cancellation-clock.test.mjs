import assert from "node:assert/strict";
import test from "node:test";
import { inspectRuntimeCancellationTiming } from "./resolve-cache-runtime-cancellation-clock.mjs";
import {
  fields,
  set,
  end,
  runtimeCancellationClockFixture as fixture,
} from "./resolve-cache-runtime-cancellation-clock-fixtures.mjs";

const inspect = (f) => inspectRuntimeCancellationTiming(f.trace, f.expected);

for (const offset of [70000, -7000000, 5000000])
  test(`Runtime cancellation clock accepts independent offset ${offset} without editing raw times`, () => {
    const f = fixture(offset),
      before = structuredClone(f.trace),
      result = inspect(f);
    assert.equal(result.clock_samples.length, 3);
    assert.equal(result.runtime_ends.length, 4);
    assert.deepEqual(result.offset_us, {
      lower: offset - 1801,
      upper: offset + 201,
    });
    assert(
      result.runtime_ends.every(
        (row) =>
          row.lower >= f.cancel.startTime + 1000 && row.upper <= end(f.cancel),
      ),
    );
    assert.equal(result.raw_server_client_end_delta_us, offset + 7000);
    assert.deepEqual(f.trace, before);
  });

test("Runtime cancellation clock permits its real early HTTP ACK and only bounds Run completion", () => {
  const f = fixture();
  assert(end(f.ack) < end(f.run));
  assert(f.run.startTime < f.cancel.startTime);
  inspect(f);
});

test("Runtime event one microsecond beyond the summed end is retained as representation ambiguity", () => {
  const f = fixture();
  f.operation.logs.push({
    timestamp: end(f.operation) + 1,
    fields: fields({ event: "completion" }),
  });
  const result = inspect(f);
  assert(
    result.representation_ambiguities.some(
      (row) => row.span_id === "operation" && row.raw_delta_us === 1,
    ),
  );
});

test("Node terminal SQL end quantization stays confined to the same ACP integer-ms anchors", () => {
  const f = fixture();
  f.finish.duration = end(f.run) - f.finish.startTime + 55;
  assert.deepEqual(inspect(f).node_end_quantization, [
    {
      parent_span_id: "run",
      child_span_id: "finish",
      raw_end_delta_us: 55,
      resolution_us: 1000,
    },
  ]);
});

const removeSample = (f, sample) => {
  const ids = new Set(Object.values(sample).map((s) => s.spanID));
  f.trace.spans = f.trace.spans.filter((s) => !ids.has(s.spanID));
};
for (const [name, change] of [
  ["no completed post-cancel RPC", (f) => removeSample(f, f.after)],
  [
    "no completed pre-cancel RPC",
    (f) => {
      removeSample(f, f.first);
      removeSample(f, f.second);
    },
  ],
  [
    "contradictory third sample cannot be skipped",
    (f) => {
      f.second.server.startTime += 10000;
      f.second.operation.startTime += 10000;
      for (const s of [f.second.server, f.second.operation])
        for (const e of s.logs) e.timestamp += 10000;
    },
  ],
  [
    "CLIENT cancelled before EOF",
    (f) => set(f.after.client, "antnest.outcome", "cancelled"),
  ],
  [
    "CLIENT cancellation event without tag",
    (f) =>
      f.after.client.logs.push({
        timestamp: end(f.after.client),
        fields: fields({ event: "antnest.cancelled" }),
      }),
  ],
  ["CLIENT failure", (f) => set(f.after.client, "error", true)],
  [
    "server protocol failure",
    (f) => set(f.after.server, "antnest.protocol.outcome", "error"),
  ],
  [
    "operation failed",
    (f) => set(f.after.operation, "mcp.operation.outcome", "error"),
  ],
  [
    "missing server completion",
    (f) => {
      f.after.server.logs = [];
    },
  ],
  ["wrong bytes", (f) => set(f.after.server, "http.response.body.size", 43)],
  [
    "zero bytes",
    (f) => {
      set(f.after.server, "http.response.body.size", 0);
      set(f.after.client, "http.response.body.size", 0);
    },
  ],
  [
    "wrong Runtime execution",
    (f) => set(f.after.server, "antnest.runtime.execution.id", "other"),
  ],
  [
    "wrong Runtime generation",
    (f) => set(f.after.operation, "antnest.runtime.generation", "2"),
  ],
  [
    "other Runtime process",
    (f) => {
      f.trace.processes.foreign = structuredClone(f.trace.processes.runtime);
      f.after.server.processID = "foreign";
    },
  ],
  [
    "different ACP instance across traces",
    (f) => {
      f.cancelTrace.processes.other.tags = fields({
        "host.name": "acp",
        "process.pid": 1,
        "service.instance.id": "new:1",
      });
    },
  ],
  [
    "early ACK used as cancel span",
    (f) => {
      f.expected.cancelSpanID = "ack";
    },
  ],
  ["other Agent cancel", (f) => set(f.cancel, "antnest.agent.id", "other")],
  ["other Session cancel", (f) => set(f.cancel, "antnest.session.id", "other")],
  [
    "model after tool start",
    (f) => {
      f.model.duration = f.tool.startTime - f.model.startTime + 1000;
    },
  ],
  [
    "tool ended before cancel",
    (f) => {
      f.tool.duration = f.cancel.startTime - f.tool.startTime - 1000;
    },
  ],
  [
    "terminal SQL before tool end",
    (f) => {
      f.finish.startTime = end(f.tool) - 1000;
    },
  ],
  [
    "terminal SQL exceeded Run by one ms",
    (f) => {
      f.finish.duration = end(f.run) - f.finish.startTime + 1000;
    },
  ],
  [
    "terminal SQL end inversion without integer-ms anchor",
    (f) => {
      f.finish.startTime++;
      f.finish.duration = end(f.run) - f.finish.startTime + 55;
    },
  ],
  [
    "Run completion past internal cancel",
    (f) => {
      f.run.duration = end(f.cancel) - f.run.startTime + 1000;
    },
  ],
  [
    "Runtime end before cancellation window",
    (f) => {
      f.executor.duration = f.cancel.startTime - f.executor.startTime - 10000;
    },
  ],
  [
    "Runtime late teardown",
    (f) => {
      for (const s of [f.server, f.operation, f.runtimeTool, f.executor])
        s.duration += 200000;
    },
  ],
  [
    "Runtime child outlived its parent",
    (f) => {
      f.executor.duration = end(f.runtimeTool) - f.executor.startTime + 2;
    },
  ],
  [
    "Runtime child began before parent",
    (f) => {
      f.executor.startTime = f.runtimeTool.startTime - 1;
    },
  ],
  [
    "Runtime event two microseconds after summed end",
    (f) =>
      f.operation.logs.push({
        timestamp: end(f.operation) + 2,
        fields: fields({ event: "completion" }),
      }),
  ],
  [
    "Runtime event before its span",
    (f) =>
      f.operation.logs.push({
        timestamp: f.operation.startTime - 1,
        fields: fields({ event: "completion" }),
      }),
  ],
  [
    "duplicate clock field",
    (f) =>
      f.after.server.tags.push({
        key: "antnest.runtime.generation",
        value: "1",
      }),
  ],
  [
    "duplicate event field",
    (f) =>
      f.after.server.logs[0].fields.push({
        key: "event",
        value: "Runtime HTTP request completed",
      }),
  ],
  [
    "unclassified CLIENT diagnostic",
    (f) => set(f.after.client, "antnest.error.code", "unexpected"),
  ],
  [
    "unclassified SERVER diagnostic",
    (f) => set(f.after.server, "exception.type", "UnexpectedError"),
  ],
  [
    "unclassified operation diagnostic",
    (f) => set(f.after.operation, "antnest.error.stage", "unexpected"),
  ],
  [
    "contradictory CLIENT outcome",
    (f) => set(f.after.client, "antnest.outcome", "error"),
  ],
  [
    "contradictory operation result",
    (f) => set(f.after.operation, "antnest.result", "failed"),
  ],
  [
    "model started before its Run",
    (f) => {
      f.model.startTime = f.run.startTime - 1000;
    },
  ],
  [
    "calibration EOF outlived its ACP parent",
    (f) => {
      f.after.client.duration = end(f.prompt) - f.after.client.startTime + 2000;
    },
  ],
  [
    "calibration began before its ACP parent",
    (f) => {
      for (const span of Object.values(f.second)) {
        span.startTime -= 8000;
        for (const event of span.logs) event.timestamp -= 8000;
      }
    },
  ],
  [
    "invalid common ACP process identity",
    (f) => {
      for (const process of [
        f.trace.processes.acp,
        f.cancelTrace.processes.other,
      ])
        set(process, "process.pid", 0);
    },
  ],
])
  test(`Runtime cancellation clock rejects ${name}`, () => {
    const f = fixture();
    inspect(f);
    change(f);
    assert.throws(() => inspect(f));
  });
