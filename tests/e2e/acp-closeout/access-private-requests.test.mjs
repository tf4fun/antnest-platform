import assert from "node:assert/strict";
import test from "node:test";
import { closeoutRequestFixture } from "./access-private-requests.fixture.mjs";
const url = new URL("./access-private-requests.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
const index = (f) => {
  assert.equal(typeof implementation.indexCloseoutAccessRequests, "function");
  return implementation.indexCloseoutAccessRequests(f);
};
test("Closeout preserves 30 initialize, 86 original business requests and four separate zero-wire probes", () => {
  const f = closeoutRequestFixture(),
    before = structuredClone(f),
    r = index(f);
  assert.equal(r.initializations.length, 30);
  assert.equal(r.requests.length, 86);
  assert.equal(r.localProbes.length, 4);
  assert.equal(r.requests.filter((row) => row.kind === "ordinary").length, 8);
  assert.equal(
    r.requests.filter((row) => row.rejection === "session_access_denied")
      .length,
    40,
  );
  assert.equal(
    r.requests.filter((row) => row.rejection === "access_denied").length,
    8,
  );
  assert.equal(
    r.requests.filter((row) => row.method === "session/list").length,
    8,
  );
  assert.deepEqual(f, before);
});
for (const [label, change] of [
  ["missing connection", (f) => f.connections.pop()],
  [
    "duplicate connection",
    (f) => (f.connections[0] = structuredClone(f.connections[1])),
  ],
  ["unjoined connection", (f) => (f.connections[0].closed = false)],
  ["missing business observation", (f) => f.observations.pop()],
  [
    "duplicate observation",
    (f) => (f.observations[0] = structuredClone(f.observations[1])),
  ],
  ["rewritten original request", (f) => (f.observations[0].requestParams = {})],
  ["missing raw initialization", (f) => f.connections[0].raw_frames.shift()],
  [
    "foreign request Agent",
    (f) => (f.connections[0].evidence[0].agentId = "foreign"),
  ],
  [
    "foreign replay Session",
    (f) =>
      (f.connections.find((c) => c.purpose === "replay").evidence[0].sessionId =
        "foreign"),
  ],
  ["wrong protocol", (f) => (f.connections[0].version = 2)],
  [
    "wrong Run phase",
    (f) => (f.observations.find((o) => o.runId).phase = "v1-foreign"),
  ],
  [
    "missing durable Run",
    (f) => delete f.observations.find((o) => o.runId).runId,
  ],
  [
    "missing list observation",
    (f) => delete f.observations.find((o) => o.listSnapshot).listSnapshot,
  ],
  [
    "wrong denial scope",
    (f) =>
      (f.observations.find((o) => o.scope === "Agent").scope = "principal"),
  ],
  [
    "retriable denial",
    (f) => (f.connections[0].evidence[0].failureData.retryable = true),
  ],
  [
    "rewritten raw denial",
    (f) => (f.connections[0].raw_frames[1].error.code = -32603),
  ],
  ["missing local probe", (f) => f.localProbes.pop()],
  [
    "duplicate local probe",
    (f) => (f.localProbes[0] = structuredClone(f.localProbes[1])),
  ],
  [
    "foreign local probe",
    (f) =>
      (f.localProbes[0].connectionTraceID = f.connections[0].connectionTraceID),
  ],
  ["local probe before join", (f) => (f.localProbes[0].before.closed = false)],
  [
    "local probe dispatched request",
    (f) =>
      f.localProbes[0].after.requests.push({
        requestId: "foreign",
        method: "session/prompt",
      }),
  ],
  [
    "local probe added raw reply",
    (f) => f.localProbes[0].after.raw_frames.push({ id: 99, result: {} }),
  ],
  [
    "local probe became business evidence",
    (f) => f.localProbes[0].after.evidence.push({ method: "session/prompt" }),
  ],
  ["local probe succeeded", (f) => (f.localProbes[0].outcome = "succeeded")],
])
  test(`Closeout inventory rejects ${label}`, () => {
    const f = closeoutRequestFixture();
    index(f);
    change(f);
    assert.throws(() => index(f));
  });

for (const [label, change] of [
  [
    "cross-organization isolation",
    (f) => {
      const c = f.connections.find(
        (c) => c.phase === "v1-foreign" && c.purpose === "baseline",
      );
      c.principal.organization_id = "foreign-organization";
      for (const r of f.connections.filter(
        (r) => r.purpose === "replay" && r.phase === c.phase,
      ))
        r.principal.organization_id = c.principal.organization_id;
    },
  ],
  [
    "changed denial cwd",
    (f) =>
      (f.connections.find(
        (c) => c.phase === "v1-peer" && c.purpose === "baseline",
      ).evidence[3].requestParams.cwd = "/other"),
  ],
  [
    "changed denial prompt",
    (f) =>
      (f.connections
        .find((c) => c.phase === "v1-peer" && c.purpose === "baseline")
        .evidence.at(-1).requestParams.prompt[0].text = "other"),
  ],
  ["local probe wrong method", (f) => (f.localProbes[0].method = "list")],
  [
    "local probe wrong Session",
    (f) => (f.localProbes[0].params.sessionId = "foreign"),
  ],
  [
    "local probe wrong prompt",
    (f) => (f.localProbes[0].params.prompt[0].text = "other"),
  ],
])
  test(`Closeout inventory rejects ${label}`, () => {
    const f = closeoutRequestFixture();
    index(f);
    change(f);
    if (label.startsWith("changed denial"))
      for (const probe of f.localProbes) {
        probe.before = structuredClone(
          f.connections.find(
            (c) => c.connectionTraceID === probe.connectionTraceID,
          ),
        );
        probe.after = structuredClone(probe.before);
      }
    assert.throws(() => index(f));
  });

test("Closeout inventory rejects a different same-Agent Session substituted into the original isolation round", () => {
  const f = closeoutRequestFixture();
  index(f);
  const c = f.connections.find(
    (c) => c.purpose === "baseline" && c.phase === "v1-peer",
  );
  const wrong = f.connections.find(
    (c) => c.purpose === "baseline" && c.phase === "v1-restored",
  ).evidence[0].sessionId;
  for (const row of c.evidence.slice(3)) {
    row.sessionId = row.inputSessionID = row.requestParams.sessionId = wrong;
    c.requests.find((r) => r.requestId === row.requestId).sessionId = wrong;
  }
  const probe = f.localProbes.find(
    (p) => p.connectionTraceID === c.connectionTraceID,
  );
  probe.before = structuredClone(c);
  probe.after = structuredClone(c);
  assert.throws(() => index(f));
});
