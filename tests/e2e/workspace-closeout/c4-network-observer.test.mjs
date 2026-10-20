import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { observeC4Network } from "./c4-network-observer.mjs";

const origin = "http://127.0.0.1:8123";
const path = "/api/app/workspace/v1/agents/agent-1/events";
const stream = {
  origin,
  path: path + "?sessionId=session-1",
  trace_id: "a".repeat(32),
};
function fixture() {
  const session = new EventEmitter(),
    calls = [];
  const state = {
    metrics: async () => ({
      metrics: [
        { name: "Timestamp", value: (performance.now() + 100000) / 1000 },
      ],
    }),
    detached: 0,
  };
  session.send = async (method) => {
    calls.push(method);
    if (method === "Page.getFrameTree")
      return { frameTree: { frame: { id: "main" } } };
    if (method === "Performance.getMetrics") return state.metrics();
    return {};
  };
  session.detach = async () => {
    state.detached++;
  };
  const page = {
    context: () => ({ newCDPSession: async () => session }),
    isClosed: () => false,
  };
  const emitRequest = (requestId = "r1", extra = {}) => {
    session.emit("Network.requestWillBeSent", {
      requestId,
      frameId: "main",
      loaderId: "document",
      type: "EventSource",
      timestamp: 101,
      wallTime: 1700000000,
      request: {
        url: origin + stream.path,
        method: "GET",
        headers: { Cookie: "PRIVATE-COOKIE-MUST-NOT-EXPORT" },
      },
      ...extra,
    });
  };
  const emitResponse = (requestId = "r1") => {
    session.emit("Network.responseReceived", {
      requestId,
      frameId: "main",
      loaderId: "document",
      type: "EventSource",
      timestamp: 101.1,
      response: {
        url: origin + stream.path,
        status: 200,
        headers: {
          "x-antnest-trace-id": stream.trace_id,
          "set-cookie": "PRIVATE-RESPONSE-MUST-NOT-EXPORT",
        },
      },
    });
  };
  return {
    session,
    state,
    page,
    calls,
    emitRequest,
    emitResponse,
    observer: observeC4Network(page, { origin, path }),
  };
}
test("C4 joins a late CDP attachment and detaches it exactly once during disposal", async () => {
  const attachment = Promise.withResolvers(),
    session = new EventEmitter();
  let detached = 0;
  session.detach = async () => {
    detached++;
  };
  const observer = observeC4Network(
    {
      context: () => ({ newCDPSession: () => attachment.promise }),
      isClosed: () => false,
    },
    { origin, path },
  );
  const closing = observer.closeAndWait();
  attachment.resolve(session);
  await closing;
  await observer.closeAndWait();
  assert.equal(detached, 1);
  assert.deepEqual(session.eventNames(), []);
});
test("C4 cleanup retains the original asynchronous calibration error after its caller observed failure", async () => {
  const f = fixture();
  await f.observer.ready;
  f.emitRequest();
  f.emitResponse();
  const pending = Promise.withResolvers(),
    started = Promise.withResolvers();
  const failure = new Error("original getMetrics failure");
  f.state.metrics = () => {
    started.resolve();
    return pending.promise;
  };
  const admission = f.observer.admission(stream);
  const rejected = assert.rejects(admission, (error) => error === failure);
  await started.promise;
  pending.reject(failure);
  await rejected;
  await assert.rejects(f.observer.closeAndWait(), (error) => error === failure);
  assert.equal(f.state.detached, 1);
  assert.deepEqual(f.session.eventNames(), []);
});
test("C4 preserves allowlisted original network and clock records even when admission validation fails", async () => {
  const f = fixture();
  await f.observer.ready;
  f.emitRequest();
  f.emitResponse();
  f.state.metrics = async () => ({ metrics: [] });
  await assert.rejects(f.observer.admission(stream), /Timestamp/);
  assert.equal(f.observer.records[0].request.request_id, "r1");
  assert.equal(f.observer.records[0].response.trace_id, stream.trace_id);
  assert.equal(f.observer.clockSamples.length, 2);
  assert.deepEqual(f.observer.clockSamples[1].timestamp_values, []);
  assert(!JSON.stringify(f.observer.records).includes("PRIVATE"));
  await assert.rejects(f.observer.closeAndWait(), /Timestamp/);
});
for (const kind of ["duplicate", "redirect"])
  test(`C4 retains ${kind} native request failure through cleanup`, async () => {
    const f = fixture();
    await f.observer.ready;
    f.emitRequest();
    f.emitRequest(
      "r1",
      kind === "redirect" ? { redirectResponse: { status: 302 } } : {},
    );
    assert.throws(() => f.observer.match(stream), /duplicate|redirect/);
    await assert.rejects(f.observer.closeAndWait(), /duplicate|redirect/);
    assert.equal(f.state.detached, 1);
  });
test("C4 rejects two native requests matching one original URL and response Trace", async () => {
  const f = fixture();
  await f.observer.ready;
  for (const id of ["r1", "r2"]) {
    f.emitRequest(id);
    f.emitResponse(id);
  }
  assert.throws(() => f.observer.match(stream), /ambiguous/);
  await f.observer.closeAndWait();
});
