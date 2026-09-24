import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DeliveryTracker,
  DeliveryProtocolError,
  parseDeliveryMark,
} from "../src/bridge/delivery.ts";

const part = (
  sequence: number,
  partIndex: number,
  partCount: number,
  messageId = `event-${sequence}`,
) => ({
  kind: "part" as const,
  sequence,
  partIndex,
  partCount,
  runId: "run-1",
  messageId,
});

test("a split event becomes visible only after every part arrives in index order", () => {
  const tracker = new DeliveryTracker<string>(0);
  assert.deepEqual(tracker.accept(part(1, 1, 2), "second"), []);
  assert.equal(tracker.watermark, 0);
  assert.deepEqual(tracker.accept(part(1, 0, 2), "first"), [
    {
      sequence: 1,
      runId: "run-1",
      messageId: "event-1",
      updates: ["first", "second"],
    },
  ]);
  assert.equal(tracker.watermark, 1);
});

test("checkpoint fills filtered gaps but never skips an incomplete durable event", () => {
  const tracker = new DeliveryTracker<string>(0);
  assert.deepEqual(tracker.accept(part(3, 0, 2), "first"), []);
  assert.deepEqual(tracker.accept({ kind: "checkpoint", sequence: 4 }), []);
  assert.equal(tracker.watermark, 2);
  assert.deepEqual(tracker.accept(part(3, 1, 2), "second"), [
    {
      sequence: 3,
      runId: "run-1",
      messageId: "event-3",
      updates: ["first", "second"],
    },
  ]);
  assert.equal(tracker.watermark, 4);
});

test("a sealed load cut fails closed when a split batch is incomplete", () => {
  const tracker = new DeliveryTracker<string>(0);
  tracker.accept(part(1, 0, 2), "first");
  tracker.accept({ kind: "checkpoint", sequence: 1 });
  assert.throws(() => tracker.seal(1), DeliveryProtocolError);
  tracker.accept(part(1, 1, 2), "second");
  assert.doesNotThrow(() => tracker.seal(1));
});

test("duplicate parts are idempotent but conflicting identity or payload rejects the stream", () => {
  const tracker = new DeliveryTracker<string>(0);
  tracker.accept(part(1, 0, 2), "first");
  assert.deepEqual(tracker.accept(part(1, 0, 2), "first"), []);
  assert.throws(
    () => tracker.accept(part(1, 0, 2), "changed"),
    DeliveryProtocolError,
  );
  assert.throws(
    () => tracker.accept(part(1, 1, 2, "other"), "second"),
    DeliveryProtocolError,
  );
});

test("wire metadata rejects unsafe indexes and unsupported shapes", () => {
  assert.deepEqual(parseDeliveryMark({ kind: "checkpoint", sequence: 0 }), {
    kind: "checkpoint",
    sequence: 0,
  });
  assert.equal(
    parseDeliveryMark({
      kind: "part",
      sequence: 1,
      partIndex: 2,
      partCount: 2,
      runId: "run-1",
      messageId: "event-1",
    }),
    null,
  );
  assert.equal(
    parseDeliveryMark({
      kind: "checkpoint",
      sequence: Number.MAX_SAFE_INTEGER + 1,
    }),
    null,
  );
  assert.equal(
    parseDeliveryMark({
      kind: "part",
      sequence: 1,
      partIndex: 0,
      partCount: 1,
      runId: "",
      messageId: "event-1",
    }),
    null,
  );
});

test("a large checkpoint advances without iterating through every omitted sequence", () => {
  const tracker = new DeliveryTracker<string>(0);
  const at = Number.MAX_SAFE_INTEGER - 1;
  assert.deepEqual(tracker.accept({ kind: "checkpoint", sequence: at }), []);
  assert.equal(tracker.watermark, at);
});

test("incomplete batches have explicit part and pending-event limits", () => {
  const tracker = new DeliveryTracker<string>(0);
  assert.throws(
    () => tracker.accept(part(1, 0, 4097), "oversized"),
    DeliveryProtocolError,
  );
  for (let sequence = 1; sequence <= 128; sequence++)
    tracker.accept(part(sequence, 0, 2), "pending");
  assert.throws(
    () => tracker.accept(part(129, 0, 2), "pending"),
    DeliveryProtocolError,
  );
});

test("summary mode bounds pending content while preserving complete delivery and duplicate checks", () => {
  const tracker = new DeliveryTracker<string>(0);
  tracker.accept(part(1, 0, 2), "old".repeat(1_000));
  tracker.enableSummaryMode((update) => update.slice(-4));
  assert.ok(tracker.bufferedBytes < 128);
  const huge = "x".repeat(17 * 1024 * 1024);
  assert.deepEqual(tracker.accept(part(1, 1, 2), huge), [{ sequence: 1,
    runId: "run-1", messageId: "event-1", updates: ["dold", "xxxx"] }]);
  assert.equal(tracker.watermark, 1);
  assert.equal(tracker.bufferedBytes, 0);
  assert.deepEqual(tracker.accept(part(1, 1, 2), huge), []);
  assert.throws(() => tracker.accept(part(1, 1, 2), "different"), DeliveryProtocolError);
});
