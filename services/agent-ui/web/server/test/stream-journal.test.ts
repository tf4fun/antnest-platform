import assert from "node:assert/strict";
import { test } from "node:test";
import {
  StreamJournal,
  StreamCapacityError,
} from "../src/bridge/stream-journal.ts";

const scope = {
  organizationId: "org-1",
  principalId: "user-1",
  agentId: "agent-1",
};
const key = Buffer.alloc(32, 3);

function journal(overrides?: {
  principalId?: string;
  epoch?: string;
  maxRetained?: number;
  maxRetainedBytes?: number;
  maxSubscriberBytes?: number;
  maxSubscribers?: number;
}) {
  return new StreamJournal({
    scope: {
      ...scope,
      ...(overrides?.principalId ? { principalId: overrides.principalId } : {}),
    },
    sessionId: "session-1",
    epoch: overrides?.epoch ?? "epoch-1",
    projectionId: "projection-1",
    key,
    maxRetained: overrides?.maxRetained ?? 3,
    maxRetainedBytes: overrides?.maxRetainedBytes,
    maxSubscriberBytes: overrides?.maxSubscriberBytes ?? 1024 * 1024,
    maxSubscribers: overrides?.maxSubscribers,
  });
}

test("subscriber admission is bounded and releases capacity on disconnect", async () => {
  const stream = journal({ maxSubscribers: 2 });
  const first = stream.subscribe(null, (cursor) => ({ streamCursor: cursor }));
  const second = stream.subscribe(null, (cursor) => ({ streamCursor: cursor }));
  assert.equal(stream.subscriberCount, 2);
  assert.throws(
    () => stream.subscribe(null, (cursor) => ({ streamCursor: cursor })),
    StreamCapacityError,
  );
  assert.equal(stream.subscriberCount, 2);
  await first.return();
  const third = stream.subscribe(null, (cursor) => ({ streamCursor: cursor }));
  assert.equal(stream.subscriberCount, 2);
  await second.return();
  await third.return();
  assert.equal(stream.subscriberCount, 0);
});

test("snapshot cursor hands off a contiguous retained suffix", async () => {
  const stream = journal();
  const snapshot = stream.snapshot((cursor) => ({
    streamCursor: cursor,
    turns: [],
  }));
  stream.publish({ type: "operation", operation: { operationId: "intent-1" } });
  const observer = stream.subscribe(snapshot.cursor, (cursor) => ({
    streamCursor: cursor,
    turns: [],
  }));
  const first = await observer.next();
  assert.equal(first.value?.type, "operation");
  assert.equal(first.value?.fromStreamRevision, snapshot.toStreamRevision);
  assert.equal(first.value?.toStreamRevision, snapshot.toStreamRevision + 1);
  stream.publish({
    type: "permission",
    permission: { permissionId: "permission-1" },
  });
  const second = await observer.next();
  assert.equal(second.value?.fromStreamRevision, first.value?.toStreamRevision);
  await observer.return();
});

test("one published event is encoded once for one, four or eight observers", async () => {
  for (const count of [1, 4, 8]) {
    const stream = journal({ maxSubscribers: count });
    const cut = stream.snapshot((cursor) => ({ streamCursor: cursor }));
    const observers = Array.from({ length: count }, () => stream.subscribe(cut.cursor,
      (cursor) => ({ streamCursor: cursor })));
    const stringify = JSON.stringify;
    let encodings = 0;
    JSON.stringify = ((value: unknown, ...options: unknown[]) => {
      if (value && typeof value === "object" && "operation" in value &&
        "toStreamRevision" in value) encodings++;
      return (stringify as (...args: unknown[]) => string | undefined)(value, ...options);
    }) as typeof JSON.stringify;
    try {
      const published = stream.publish({ type: "operation",
        operation: { operationId: "intent-1" } });
      for (const observer of observers) {
        assert.equal((await observer.next()).value, published);
        await observer.return();
      }
      assert.equal(encodings, 1, `${count} observers must share one encoding`);
    } finally { JSON.stringify = stringify; stream.close(); }
  }
});

test("oversized snapshots fail before issuing an unusable SSE cursor", () => {
  const stream = journal({ maxSubscriberBytes: 700 });
  assert.throws(
    () =>
      stream.snapshot((cursor) => ({
        streamCursor: cursor,
        payload: "x".repeat(900),
      })),
    StreamCapacityError,
  );
  assert.equal(stream.revision, 0);
  assert.throws(
    () =>
      stream.subscribe(null, (cursor) => ({
        streamCursor: cursor,
        payload: "x".repeat(900),
      })),
    StreamCapacityError,
  );
  assert.equal(stream.subscriberCount, 0);
});

test("oversized live reset closes stale observers and forces a later reset", async () => {
  const stream = journal({ maxSubscriberBytes: 700 });
  const cut = stream.snapshot((cursor) => ({ streamCursor: cursor }));
  const observer = stream.subscribe(cut.cursor, (cursor) => ({
    streamCursor: cursor,
  }));
  assert.throws(
    () =>
      stream.publishReset((cursor) => ({
        streamCursor: cursor,
        payload: "x".repeat(900),
      })),
    StreamCapacityError,
  );
  assert.equal((await observer.next()).done, true);
  const resumed = stream.subscribe(cut.cursor, (cursor) => ({
    streamCursor: cursor,
  }));
  assert.equal((await resumed.next()).value?.type, "reset");
  await resumed.return();
});

test("retained suffix also obeys a byte cap", async () => {
  const stream = journal({ maxRetained: 10, maxRetainedBytes: 700 });
  const cut = stream.snapshot((cursor) => ({ streamCursor: cursor }));
  for (let index = 0; index < 4; index++)
    stream.publish({
      type: "operation",
      operation: { operationId: String(index), note: "x".repeat(220) },
    });
  const observer = stream.subscribe(cut.cursor, (cursor) => ({
    streamCursor: cursor,
  }));
  assert.equal((await observer.next()).value?.type, "reset");
  await observer.return();
});

test("foreign identity, old epoch and expired suffix reset to a fresh snapshot", async () => {
  const original = journal({ maxRetained: 1 });
  const cut = original.snapshot((cursor) => ({ streamCursor: cursor }));
  original.publish({ type: "operation", operation: { operationId: "one" } });
  original.publish({ type: "operation", operation: { operationId: "two" } });
  const expired = original.subscribe(cut.cursor, (cursor) => ({
    streamCursor: cursor,
  }));
  assert.equal((await expired.next()).value?.type, "reset");
  await expired.return();
  const foreign = journal({ principalId: "user-2" });
  const observer = foreign.subscribe(cut.cursor, (cursor) => ({
    streamCursor: cursor,
  }));
  assert.equal((await observer.next()).value?.type, "reset");
  await observer.return();
  const restarted = journal({ epoch: "epoch-2" });
  const afterRestart = restarted.subscribe(cut.cursor, (cursor) => ({
    streamCursor: cursor,
  }));
  assert.equal((await afterRestart.next()).value?.type, "reset");
  await afterRestart.return();
});

test("a slow observer is reset within its byte budget without blocking publication", async () => {
  const stream = journal({ maxSubscriberBytes: 800 });
  const cut = stream.snapshot((cursor) => ({ streamCursor: cursor }));
  const observer = stream.subscribe(cut.cursor, (cursor) => ({
    streamCursor: cursor,
  }));
  assert.deepEqual(stream.snapshotMetrics(), {
    subscribers: 1,
    queuedBytes: 0,
    retainedBytes: 0,
  });
  for (let index = 0; index < 20; index++)
    stream.publish({
      type: "operation",
      operation: { operationId: String(index), value: "x".repeat(50) },
    });
  assert.equal(stream.snapshotMetrics().subscribers, 1);
  assert.equal(
    stream.snapshotMetrics().queuedBytes,
    0,
    "An unread reset is represented by one pending marker, not a queued View",
  );
  assert.ok(stream.snapshotMetrics().queuedBytes <= 800);
  assert.ok(stream.snapshotMetrics().retainedBytes > 0);
  const next = await observer.next();
  assert.equal(next.value?.type, "reset");
  assert.equal(stream.snapshotMetrics().queuedBytes, 0);
  await observer.return();
  assert.equal(stream.snapshotMetrics().subscribers, 0);
  assert.equal(stream.snapshotMetrics().queuedBytes, 0);
  stream.close();
  assert.equal(stream.snapshotMetrics().retainedBytes, 0);
  assert.equal(stream.revision, 20);
});

test("an unread slow-observer reset is materialized once at the latest revision", async () => {
  const stream = journal({ maxSubscriberBytes: 800 });
  const cut = stream.snapshot((cursor) => ({ streamCursor: cursor }));
  let projections = 0;
  const observer = stream.subscribe(cut.cursor, (cursor) => {
    projections++;
    return { streamCursor: cursor };
  });
  for (let index = 0; index < 100; index++)
    stream.publish({
      type: "operation",
      operation: {
        operationId: String(index),
        value: "x".repeat(50),
      },
    });
  assert.equal(
    projections,
    0,
    "Unread resets must not repeatedly project views",
  );
  const reset = (await observer.next()).value;
  assert.equal(reset?.type, "reset");
  assert.equal(reset?.toStreamRevision, 100);
  assert.equal(projections, 1);
  await observer.return();
});

test("default retained byte budget resets an old cursor after sustained output", async () => {
  const stream = journal({ maxRetained: 128 });
  const cut = stream.snapshot((cursor) => ({ streamCursor: cursor }));
  for (let index = 0; index < 20; index++)
    stream.publish({
      type: "operation",
      operation: {
        operationId: String(index),
        value: "x".repeat(16 * 1024),
      },
    });
  const observer = stream.subscribe(cut.cursor, (cursor) => ({
    streamCursor: cursor,
  }));
  assert.equal((await observer.next()).value?.type, "reset");
  await observer.return();
});

test("a published reset advances the suffix and carries the new snapshot cursor", async () => {
  const stream = journal();
  const cut = stream.snapshot((cursor) => ({
    streamCursor: cursor,
    turns: [],
  }));
  const observer = stream.subscribe(cut.cursor, (cursor) => ({
    streamCursor: cursor,
    turns: [],
  }));
  const reset = stream.publishReset((cursor) => ({
    streamCursor: cursor,
    turns: [{ turnId: "run-1" }],
  }));
  assert.equal(reset.type, "reset");
  assert.equal(reset.fromStreamRevision, cut.toStreamRevision);
  assert.equal(reset.toStreamRevision, cut.toStreamRevision + 1);
  assert.equal(reset.view?.streamCursor, reset.cursor);
  assert.deepEqual((await observer.next()).value, reset);
  await observer.return();
});
