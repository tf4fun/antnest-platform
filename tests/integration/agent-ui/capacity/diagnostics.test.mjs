import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import { inspect } from "node:util";
import { test } from "node:test";
import { observeFixtureProcess } from "./process.mjs";
import { parseCapacityResponse } from "./response.mjs";

function childDouble() {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.connected = true;
  child.send = () => {};
  child.kill = () => {
    throw new Error("Unexpected forced kill in orderly-exit case");
  };
  return child;
}

test("capacity cleanup waits for stdio close after process exit", async () => {
  const child = childDouble();
  const observed = observeFixtureProcess(child);
  let settled = false;
  const completion = observed.stop().then(() => {
    settled = true;
  });
  child.emit("exit", 0, null);
  try {
    await nextTurn();
    assert.equal(settled, false, "exit is not stdio completion");
  } finally {
    child.emit("close", 0, null);
    await completion;
  }
});

test("capacity cleanup sees stderr delivered between exit and close without hashing after finalization", async () => {
  const child = childDouble();
  const observed = observeFixtureProcess(child);
  const completion = observed.stop().then(
    () => undefined,
    (error) => error,
  );
  child.emit("exit", 0, null);
  await nextTurn();
  let writingError;
  try {
    child.stderr.emit("data", Buffer.from("late-private-canary"));
  } catch (error) {
    writingError = error;
  }
  child.emit("close", 0, null);
  const result = await completion;
  assert.equal(writingError, undefined);
  assert.match(result?.message ?? "", /capacity fixture stderr sha256=/u);
  assert.equal(inspect(result).includes("late-private-canary"), false);
});

test("capacity receipts retain their actual parent observation time without rewriting child evidence", async () => {
  const child = childDouble();
  const observed = observeFixtureProcess(child);
  const receipt = {
    kind: "body-eof",
    uploadId: "upload-a",
    ns: "1",
    observedAt: "forged-child-time",
  };
  const original = structuredClone(receipt);
  const pending = observed.wait("body-eof");
  const before = process.hrtime.bigint();
  child.emit("message", receipt);
  const after = process.hrtime.bigint();
  assert.strictEqual(await pending, receipt);
  assert.equal(typeof observed.observedAt, "function");
  const actual = observed.observedAt(receipt);
  assert.equal(typeof actual, "bigint");
  assert.ok(before <= actual && actual <= after);
  await nextTurn();
  child.emit("message", {
    kind: "handler-enter",
    uploadId: "upload-a",
    ns: "2",
  });
  assert.strictEqual(await observed.wait("body-eof"), receipt);
  assert.equal(observed.observedAt(receipt), actual);
  assert.deepEqual(receipt, original);
});

test("capacity observation time cannot be borrowed by a cloned or foreign receipt", async () => {
  const firstChild = childDouble();
  const secondChild = childDouble();
  const first = observeFixtureProcess(firstChild);
  const second = observeFixtureProcess(secondChild);
  const receipt = { kind: "body-eof", uploadId: "upload-a", ns: "1" };
  firstChild.emit("message", receipt);
  assert.equal(typeof first.observedAt, "function");
  assert.equal(typeof second.observedAt, "function");
  assert.throws(
    () => first.observedAt(structuredClone(receipt)),
    /not observed/u,
  );
  assert.throws(() => second.observedAt(receipt), /not observed/u);
  assert.strictEqual(await first.wait("body-eof"), receipt);
});

for (const [name, overrides, accepted] of [
  ["actual local receipt precedes cancellation", {}, true],
  ["cancellation before receipt observation", { observedAt: 102n }, false],
  ["cancellation at completion", { completedAt: 504n }, false],
  ["cancellation after completion", { completedAt: 503n }, false],
]) {
  test(`capacity overlap ${accepted ? "accepts" : "rejects"} ${name}`, async () => {
    const { assertUploadOverlap } = await import("./process.mjs");
    assert.equal(typeof assertUploadOverlap, "function");
    const input = {
      observedAt: 100n,
      cancelSent: 101n,
      cancelLatest: 504n,
      completedAt: 600n,
      ...overrides,
    };
    if (accepted) assert.doesNotThrow(() => assertUploadOverlap(input));
    else assert.throws(() => assertUploadOverlap(input), /cancel must/u);
  });
}

const secret = "private-response-canary-9d3af";
for (const [name, bytes] of [
  ["malformed JSON", `{"message":"${secret}`],
  ["unexpected response field", JSON.stringify({ phase: secret })],
  [
    "escaped response value",
    `{"nested":{"phase":"${secret.replaceAll("a", "\\u0061")}"}}`,
  ],
]) {
  test(`capacity ${name} cannot expose credentials through diagnostics`, () => {
    let failure;
    try {
      parseCapacityResponse(Buffer.from(bytes), new Set([secret]));
    } catch (error) {
      failure = error;
    }
    assert.ok(
      failure,
      "credential-bearing responses must be rejected before field assertions",
    );
    assert.equal(inspect(failure, { depth: 10 }).includes(secret), false);
    assert.equal(failure.cause, undefined);
    assert.match(
      failure.message,
      /^Capacity response (contains private test credentials|JSON is invalid)$/u,
    );
  });
}
test("capacity parser preserves ordinary response fields", () => {
  assert.deepEqual(
    parseCapacityResponse(
      Buffer.from('{"phase":"cancelled","runId":"run-b"}'),
      new Set([secret]),
    ),
    { phase: "cancelled", runId: "run-b" },
  );
});
