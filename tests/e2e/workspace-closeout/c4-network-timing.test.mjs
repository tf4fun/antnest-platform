import assert from "node:assert/strict";
import test from "node:test";
import { addC4NetworkTiming } from "./c4-network-timing.fixture.mjs";
const moduleURL = new URL("./c4-network-timing.mjs", import.meta.url);
const { inspectC4NetworkTiming } = await import(moduleURL).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(moduleURL.pathname)
  )
    throw error;
  return {};
});
function fixture() {
  return addC4NetworkTiming({
    checkpoint: {
      at: 2000,
      stream: {
        origin: "http://127.0.0.1:8123",
        path: "/api/app/workspace/v1/agents/agent-1/events?sessionId=session-1",
        trace_id: "a".repeat(32),
        status: 200,
        started_at: 1000.5,
        started_at_ms: 1700000000000,
        headers_at: 1200,
      },
    },
    closure: { kind: "remote-end", at: 4000 },
  });
}
function inspect(f) {
  assert.equal(typeof inspectC4NetworkTiming, "function");
  return inspectC4NetworkTiming(f);
}
test("native dispatch uses the whole independently bracketed CDP clock interval, never the callback timestamp", () => {
  const f = fixture();
  f.checkpoint.stream.started_at = 1190;
  const raw = structuredClone(f);
  const result = inspect(f);
  assert(result.dispatch.lower <= 999 && result.dispatch.upper >= 1001);
  assert(result.dispatch.upper < f.checkpoint.stream.started_at);
  assert.deepEqual(f, raw);
});
test("all original clock samples retain their uncertainty and observed drift", () => {
  const f = fixture();
  f.networkEnd.calibration.timestamp += 0.003;
  const result = inspect(f);
  assert(result.dispatch.lower <= 996 && result.dispatch.upper >= 1001);
});
for (const [name, change] of [
  ["missing native record", (f) => delete f.checkpoint.stream.network],
  [
    "missing calibration",
    (f) => delete f.checkpoint.stream.network.calibration,
  ],
  ["missing final sample", (f) => delete f.networkEnd.calibration],
  [
    "foreign frame",
    (f) => (f.checkpoint.stream.network.request.frame_id = "iframe"),
  ],
  [
    "foreign response frame",
    (f) => (f.checkpoint.stream.network.response.frame_id = "iframe"),
  ],
  [
    "foreign response request",
    (f) => (f.checkpoint.stream.network.response.request_id = "other"),
  ],
  ["foreign end request", (f) => (f.networkEnd.event.request_id = "other")],
  [
    "different loader",
    (f) => (f.checkpoint.stream.network.response.loader_id = "other"),
  ],
  [
    "different URL",
    (f) => (f.checkpoint.stream.network.response.url += "&other=1"),
  ],
  [
    "different Session",
    (f) => (f.checkpoint.stream.network.request.url += "other"),
  ],
  [
    "different Trace",
    (f) => (f.checkpoint.stream.network.response.trace_id = "b".repeat(32)),
  ],
  [
    "different status",
    (f) => (f.checkpoint.stream.network.response.status = 503),
  ],
  [
    "different method",
    (f) => (f.checkpoint.stream.network.request.method = "POST"),
  ],
  [
    "different type",
    (f) => (f.checkpoint.stream.network.request.type = "Fetch"),
  ],
  [
    "missing browser timestamp",
    (f) => delete f.checkpoint.stream.network.request.timestamp,
  ],
  [
    "inverted calibration",
    (f) => (f.checkpoint.stream.network.calibration.before.started_at = 960),
  ],
  [
    "calibration after dispatch",
    (f) => (f.checkpoint.stream.network.calibration.before.timestamp = 102),
  ],
  [
    "response before dispatch",
    (f) => (f.checkpoint.stream.network.response.timestamp = 100),
  ],
  ["end before response", (f) => (f.networkEnd.event.timestamp = 101)],
  [
    "native EOF before trigger with a delayed callback",
    (f) => (f.networkEnd.event.timestamp = 101.25),
  ],
  ["calibration before end", (f) => (f.networkEnd.calibration.timestamp = 103)],
  [
    "post-checkpoint admission sample",
    (f) =>
      (f.checkpoint.stream.network.calibration.admission.completed_at = 2001),
  ],
  ["missing native EOF", (f) => delete f.networkEnd],
  [
    "local cancellation",
    (f) =>
      Object.assign(f.networkEnd.event, {
        kind: "loadingFailed",
        error_text: "net::ERR_ABORTED",
        canceled: true,
      }),
  ],
])
  test("native timing rejects " + name, () => {
    const f = fixture();
    inspect(f);
    change(f);
    assert.throws(() => inspect(f));
  });
