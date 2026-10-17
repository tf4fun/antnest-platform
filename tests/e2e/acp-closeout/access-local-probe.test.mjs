import assert from "node:assert/strict";
import test from "node:test";
const url = new URL("./access-local-probe.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
const original = {
  connectionTraceID: "a".repeat(32),
  closed: true,
  requests: [{ method: "initialize", requestId: "1" }],
  raw_frames: [],
  evidence: [],
  updates: [],
  evidence_errors: [],
};
function fixture(
  effect = () => {
    throw new Error("original closed connection");
  },
) {
  const state = structuredClone(original),
    attempts = [];
  return {
    state,
    attempts,
    recorder: { snapshot: () => structuredClone(state) },
    raw: {
      async request(method, params) {
        attempts.push({ method, params: structuredClone(params) });
        return effect(state);
      },
    },
  };
}
async function probe(f) {
  assert.equal(typeof implementation.probeClosedPrompt, "function");
  return implementation.probeClosedPrompt(
    f.raw,
    f.recorder,
    "original-session",
  );
}
test("post-close probe calls the original SDK and archives its failure without creating a business record", async () => {
  const f = fixture(),
    row = await probe(f);
  assert.deepEqual(f.state, original);
  assert.deepEqual(row.before, original);
  assert.deepEqual(row.after, original);
  assert.deepEqual(f.attempts, [
    {
      method: "prompt",
      params: {
        sessionId: "original-session",
        prompt: [{ type: "text", text: "revoked-owner" }],
      },
    },
  ]);
  assert.match(row.failure, /original closed connection/u);
  assert.equal(row.outcome, "rejected");
});
test("post-close probe refuses an unjoined recorder before calling SDK", async () => {
  const f = fixture();
  f.state.closed = false;
  await assert.rejects(() => probe(f));
  assert.deepEqual(f.attempts, []);
});
test("post-close probe rejects a successful local request", async () => {
  await assert.rejects(() => probe(fixture(() => ({}))));
});
for (const field of [
  "requests",
  "raw_frames",
  "evidence",
  "updates",
  "evidence_errors",
])
  test("post-close probe rejects new " + field, async () => {
    await assert.rejects(() =>
      probe(
        fixture((state) => {
          state[field].push({ unexpected: true });
          throw new Error("closed");
        }),
      ),
    );
  });
