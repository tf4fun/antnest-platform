import assert from "node:assert/strict";
import test from "node:test";
import { progressClientFixture } from "./client-evidence.fixture.mjs";

const url = new URL("./client-evidence.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
function index(f) {
  assert.equal(typeof implementation.indexProgressRequests, "function");
  return implementation.indexProgressRequests(f);
}
test("Progress indexes all 12 paths, 72 real request identities and four original notifications", () => {
  const f = progressClientFixture(),
    before = structuredClone(f);
  const result = index(f);
  assert.equal(result.requests.length, 44);
  assert.equal(result.initializations.length, 28);
  assert.equal(result.notifications.length, 4);
  assert.equal(
    result.requests.filter((row) => row.kind === "execution").length,
    12,
  );
  assert.equal(
    result.requests.filter((row) => row.rejection !== undefined).length,
    4,
  );
  for (const item of result.notifications)
    assert.strictEqual(
      item.receipt,
      f.connections.find(
        (row) => row.phase === item.phase && row.role === "prompt",
      ).notifications[0],
    );
  assert.deepEqual(f, before);
  assert.equal(
    new Set(
      [...result.requests, ...result.initializations].map((row) => row.label),
    ).size,
    72,
  );
});
for (const [name, mutate] of [
  ["missing Agent", (f) => f.agents.pop()],
  [
    "duplicated Agent",
    (f) => {
      f.agents[3] = f.agents[2];
    },
  ],
  ["missing connection", (f) => f.connections.pop()],
  [
    "duplicated connection",
    (f) => {
      f.connections[1] = f.connections[0];
    },
  ],
  [
    "foreign role",
    (f) => {
      f.connections[0].role = "foreign";
    },
  ],
  ["wire request missing", (f) => f.connections[0].requests.pop()],
  [
    "extra wire request",
    (f) =>
      f.connections[0].requests.push({
        requestId: "999",
        method: "session/list",
      }),
  ],
  [
    "wire request method mismatch",
    (f) => {
      f.connections[0].requests[1].method = "session/fork";
    },
  ],
  [
    "wire Session mismatch",
    (f) => {
      f.connections[0].requests[2].sessionId = "foreign";
    },
  ],
  [
    "request Agent mismatch",
    (f) => {
      f.connections[0].evidence[0].agentId = "foreign";
    },
  ],
  [
    "request version mismatch",
    (f) => {
      f.connections[0].evidence[0].protocolVersion = 2;
    },
  ],
  [
    "request connection mismatch",
    (f) => {
      f.connections[0].evidence[0].connectionTraceID = "f".repeat(32);
    },
  ],
  [
    "request CLIENT mismatch",
    (f) => {
      f.connections[0].evidence[0].clientSpanID = "f".repeat(16);
    },
  ],
  [
    "unowned RPC failure",
    (f) => {
      f.connections[0].evidence[0].outcome = "failed";
    },
  ],
  [
    "missing actual replay disconnect",
    (f) => {
      delete f.connections[0].evidence[1].closedBeforeResponse;
    },
  ],
  [
    "foreign scenario Session",
    (f) => {
      f.scenarios[0].sessionId = "foreign";
    },
  ],
  [
    "duplicate Tool identity",
    (f) => {
      f.scenarios[1].toolCallId = f.scenarios[0].toolCallId;
    },
  ],
  [
    "duplicate Session identity",
    (f) => {
      f.scenarios[1].sessionId = f.scenarios[0].sessionId;
    },
  ],
  [
    "missing actual stop",
    (f) => {
      delete f.outcomes[2].actual_execution_stopped;
    },
  ],
  [
    "foreign terminal status",
    (f) => {
      f.outcomes[2].terminal = "completed";
    },
  ],
  [
    "missing notification",
    (f) => {
      f.connections.find((row) => row.notifications.length).notifications = [];
    },
  ],
  [
    "extra notification",
    (f) => {
      f.connections[0].notifications = [{ method: "session/cancel" }];
    },
  ],
  [
    "foreign notification Session",
    (f) => {
      const c = f.connections.find((row) => row.notifications.length);
      c.notifications = [{ ...c.notifications[0], sessionId: "foreign" }];
    },
  ],
  [
    "foreign Provider phase",
    (f) => {
      f.models[0].phase = "foreign";
    },
  ],
  ["missing Provider request", (f) => f.models.pop()],
  [
    "Provider final on foreign Trace",
    (f) => {
      f.models[1].trace_id = "f".repeat(32);
    },
  ],
  [
    "two phases share one Provider Trace",
    (f) => {
      f.models[2].trace_id = f.models[3].trace_id = f.models[0].trace_id;
    },
  ],
])
  test(`Progress rejects ${name} in final client inventory`, () => {
    assert.equal(typeof implementation.indexProgressRequests, "function");
    const f = progressClientFixture();
    mutate(f);
    assert.throws(() => index(f));
  });
