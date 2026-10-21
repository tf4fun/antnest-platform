import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as turn } from "node:timers/promises";
import { acpPromptRequestBytes } from "../src/adapters/acp-http.ts";
import { OperationCoordinator, OperationConflictError, type PromptIntent } from "../src/bridge/operations.ts";

const input = (text = "original"): PromptIntent => ({ sessionId: "session", intentId: "intent",
  expectedAppendVersion: 3, prompt: [{ type: "text", text }] });

function fixture() {
  const dispatched: PromptIntent[] = [], reuse: string[] = [];
  const finish = Promise.withResolvers<void>();
  let retained = 0;
  const operations = new OperationCoordinator({
    async prompt(value) { dispatched.push(value); await finish.promise; },
    async readIntent() { return { kind: "unknown" }; },
    async cancel() { assert.fail("Preparation must not cancel another operation"); },
    retainWork() { retained++; return () => { retained--; }; },
    recordLocalIntentReuse(value) { reuse.push(value); },
  });
  return { operations, dispatched, reuse, retained: () => retained,
    async close() { finish.resolve(); await Promise.resolve();
      await Promise.all(dispatched.map((value) => operations.settled(value.sessionId, value.intentId)));
      assert.equal(retained, 0);
    },
  };
}

for (const [name, prompt] of [
  ["text", [{ type: "text", text: "hello" }]],
  ["Unicode and escapes", [{ type: "text", text: '😀 中文\n\\"\u0000\ud800' }]],
  ["numeric keys and nested values", [{ type: "resource", resource: { uri: "file:///test", "10": "ten", "2": "two",
    a: [null, false, -0, Number.NaN, Infinity], z: { nested: "value" } } }]],
  ["own proto key", JSON.parse('[{"type":"text","text":"value","__proto__":{"retained":true}}]')],
  ["surrogate at chunk boundary", [{ text: "x".repeat(65_525) + "😀tail", type: "text" }]],
] as const) {
  test(`prepared input preserves wire bytes and synchronous digest for ${name}`, async () => {
    const f = fixture();
    try {
      const request = { ...input(), prompt: prompt as PromptIntent["prompt"] };
      // The old synchronous entry point remains the compatibility oracle.
      f.operations.submit(request);
      const prepared = await f.operations.prepare(request);
      assert.equal(prepared.requestBytes, acpPromptRequestBytes(request));
      assert.ok(Object.isFrozen(prepared));
      assert.equal(f.operations.submitPrepared(prepared).operationId, "intent");
      await Promise.resolve();
      assert.equal(f.dispatched.length, 1);
      assert.deepEqual(f.reuse, ["hit"]);
    } finally { await f.close(); }
  });
}

test("preparation lets control I/O run during a large digest without retaining work", async () => {
  const f = fixture(), events: string[] = [];
  try {
    const preparing = f.operations.prepare(input("a".repeat(2 * 1024 * 1024))).then((value) => {
      events.push("prepared"); return value;
    });
    const control = (async () => { await turn(); await turn(); events.push("control"); })();
    const [prepared] = await Promise.all([preparing, control]);
    assert.deepEqual(events, ["control", "prepared"]);
    assert.equal(f.retained(), 0); assert.deepEqual(f.dispatched, []);
    f.operations.submitPrepared(prepared);
    assert.equal(f.retained(), 1);
  } finally { await f.close(); }
});

test("preparation captures metadata and nested content before yielding", async () => {
  const f = fixture();
  const request = input("a".repeat(1024 * 1024));
  request.prompt.push({ type: "resource", resource: { uri: "file:///original", text: "before" } });
  const expected = structuredClone(request);
  try {
    const preparing = f.operations.prepare(request);
    request.intentId = "replacement"; request.sessionId = "replacement"; request.expectedAppendVersion = 9;
    (request.prompt[1] as any).resource.text = "changed"; request.prompt.length = 0;
    const prepared = await preparing;
    assert.equal(prepared.requestBytes, acpPromptRequestBytes(expected));
    f.operations.submitPrepared(prepared);
    await Promise.resolve();
    assert.deepEqual(f.dispatched, [expected]);
    f.operations.submit(expected);
    assert.deepEqual(f.reuse, ["hit"]);
  } finally { await f.close(); }
});

test("prepared tokens are bound to one coordinator and consumed once", async () => {
  const f = fixture(), foreign = fixture();
  try {
    const prepared = await f.operations.prepare(input());
    assert.throws(() => f.operations.submitPrepared({ requestBytes: prepared.requestBytes }), /prepared/i);
    assert.throws(() => foreign.operations.submitPrepared(prepared), /prepared/i);
    f.operations.submitPrepared(prepared);
    assert.throws(() => f.operations.submitPrepared(prepared), /prepared/i);
    assert.equal(f.retained(), 1); assert.equal(foreign.retained(), 0);
  } finally { await f.close(); await foreign.close(); }
});

test("prepared commits recheck concurrent intent reuse and content conflicts atomically", async () => {
  const f = fixture();
  try {
    const first = await f.operations.prepare(input());
    const same = await f.operations.prepare(input());
    const changed = await f.operations.prepare(input("changed"));
    f.operations.submitPrepared(first);
    f.operations.submitPrepared(same);
    assert.throws(() => f.operations.submitPrepared(changed), OperationConflictError);
    await Promise.resolve();
    assert.equal(f.dispatched.length, 1); assert.equal(f.retained(), 1);
    assert.deepEqual(f.reuse, ["hit", "conflict"]);
  } finally { await f.close(); }
});

test("prepared commits check capacity at commit rather than preparation time", async () => {
  const f = fixture();
  try {
    const prepared = await f.operations.prepare(input());
    for (let i = 0; i < 256; i++) f.operations.submit({ ...input(), intentId: `occupied-${i}` });
    assert.throws(() => f.operations.submitPrepared(prepared), /capacity/i);
    assert.equal(f.retained(), 256);
    await Promise.resolve(); assert.equal(f.dispatched.length, 256);
  } finally { await f.close(); }
});

for (const stage of ["before", "during", "after"] as const) {
  test(`abort ${stage} preparation retains the reason and has no operation effects`, async () => {
    const f = fixture(), abort = new AbortController(), reason = new Error("original disconnect");
    try {
      if (stage === "before") abort.abort(reason);
      const preparing = f.operations.prepare(input("a".repeat(2 * 1024 * 1024)), abort.signal);
      if (stage === "during") { await turn(); abort.abort(reason); }
      if (stage === "after") {
        const prepared = await preparing; abort.abort(reason);
        assert.throws(() => f.operations.submitPrepared(prepared), (cause) => cause === reason);
      } else await assert.rejects(preparing, (cause) => cause === reason);
      assert.equal(f.retained(), 0); assert.deepEqual(f.dispatched, []);
      assert.deepEqual(f.operations.trackedSessionIds(), []);
    } finally { await f.close(); }
  });
}
