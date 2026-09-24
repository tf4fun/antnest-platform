import assert from "node:assert/strict";
import { test } from "node:test";
import { BridgeCapacityError, BridgeRegistry } from "../src/bridge/registry.ts";

const scope = {
  organizationId: "org-1",
  principalId: "user-1",
  agentId: "agent-1",
};

test("owner capacity evicts cold scopes but preserves observed and working scopes", async () => {
  const closed = [];
  let incarnation = 0;
  const registry = new BridgeRegistry({
    create: (identity) => ({ close() { closed.push(identity.principalId); } }),
    now: () => 0,
    idleMs: 300_000,
    maxOwners: 2,
    epoch: () => "epoch",
    incarnation: () => String(++incarnation),
  });
  const first = await registry.observe(scope);
  const secondScope = { ...scope, principalId: "user-2" };
  const second = await registry.observe(secondScope);
  const heldWork = second.retainWork();
  second.release();
  await assert.rejects(
    registry.observe({ ...scope, principalId: "user-3" }),
    BridgeCapacityError,
  );
  const firstIncarnation = first.incarnation;
  first.release();
  const third = await registry.observe({ ...scope, principalId: "user-3" });
  assert.deepEqual(closed, ["user-1"]);
  assert.notEqual(third.incarnation, firstIncarnation);
  const stillWorking = await registry.observe(secondScope);
  assert.equal(stillWorking.incarnation, second.incarnation);
  stillWorking.release();
  heldWork();
  third.release();
  await registry.drain(1_000);
});

test("registry reports aggregate owners, observers and retained work without scope labels", async () => {
  const registry = new BridgeRegistry({
    create: () => ({ close() {} }), now: () => 0, idleMs: 0,
    epoch: () => "epoch", incarnation: () => "incarnation",
  });
  const first = await registry.observe(scope);
  const second = await registry.observe({ ...scope, principalId: "user-2" });
  assert.deepEqual(registry.snapshotMetrics(), { owners: 2, observerLeases: 2, heldWork: 0 });
  const done = second.retainWork();
  first.release();
  second.release();
  assert.deepEqual(registry.snapshotMetrics(), { owners: 2, observerLeases: 0, heldWork: 1 });
  done();
  await registry.sweep();
  assert.deepEqual(registry.snapshotMetrics(), { owners: 0, observerLeases: 0, heldWork: 0 });
});

test("one owner is joined by concurrent observers of the same authorized scope", async () => {
  let creations = 0;
  let completeCreation!: (value: { close(): void }) => void;
  const pending = new Promise<{ close(): void }>((resolve) => {
    completeCreation = resolve;
  });
  const registry = new BridgeRegistry({
    create: () => {
      creations += 1;
      return pending;
    },
    now: () => 0,
    idleMs: 300_000,
    epoch: () => "epoch-1",
    incarnation: () => "incarnation-1",
  });
  const first = registry.observe(scope);
  const second = registry.observe(scope);
  assert.equal(creations, 1);
  completeCreation({ close() {} });
  const [left, right] = await Promise.all([first, second]);
  assert.equal(left.owner, right.owner);
  assert.equal(left.epoch, "epoch-1");
  assert.equal(left.incarnation, "incarnation-1");
  left.release();
  right.release();
});

test("owners never cross organization, principal or Agent boundaries", async () => {
  let creations = 0;
  const registry = new BridgeRegistry({
    create: () => Promise.resolve({ id: ++creations, close() {} }),
    now: () => 0,
    idleMs: 300_000,
    epoch: () => "epoch",
    incarnation: () => String(creations),
  });
  const leases = await Promise.all([
    registry.observe(scope),
    registry.observe({ ...scope, organizationId: "org-2" }),
    registry.observe({ ...scope, principalId: "user-2" }),
    registry.observe({ ...scope, agentId: "agent-2" }),
  ]);
  assert.deepEqual(
    leases.map(({ owner }) => owner.id),
    [1, 2, 3, 4],
  );
  for (const lease of leases) lease.release();
});

test("active work survives the last observer and prevents idle eviction", async () => {
  let time = 0;
  let closed = 0;
  let incarnation = 0;
  const registry = new BridgeRegistry({
    create: () =>
      Promise.resolve({
        close() {
          closed += 1;
        },
      }),
    now: () => time,
    idleMs: 300_000,
    epoch: () => "epoch-1",
    incarnation: () => `incarnation-${++incarnation}`,
  });
  const observer = await registry.observe(scope);
  const work = observer.retainWork();
  observer.release();
  time = 300_001;
  await registry.sweep();
  assert.equal(closed, 0);
  const joined = await registry.observe(scope);
  assert.equal(joined.incarnation, "incarnation-1");
  joined.release();
  work();
  time = 600_002;
  await registry.sweep();
  assert.equal(closed, 1);
  const recreated = await registry.observe(scope);
  assert.equal(recreated.incarnation, "incarnation-2");
  recreated.release();
});

test("failed owner creation is removed so a later request can recover", async () => {
  let attempts = 0;
  const registry = new BridgeRegistry({
    create: () =>
      ++attempts === 1
        ? Promise.reject(new Error("ACP unavailable"))
        : Promise.resolve({ close() {} }),
    now: () => 0,
    idleMs: 300_000,
    epoch: () => "epoch",
    incarnation: () => "incarnation",
  });
  await assert.rejects(registry.observe(scope), /ACP unavailable/);
  const recovered = await registry.observe(scope);
  assert.equal(attempts, 2);
  recovered.release();
});

test("a disconnected ACP owner is replaced on the next observation", async () => {
  let created = 0;
  const registry = new BridgeRegistry({
    create: () => {
      const id = ++created;
      return { id, isClosed: false, close() { this.isClosed = true; } };
    },
    now: () => 0,
    idleMs: 300_000,
    epoch: () => "epoch",
    incarnation: () => String(created + 1),
  });
  const first = await registry.observe(scope);
  first.release();
  first.owner.isClosed = true;
  const second = await registry.observe(scope);
  assert.equal(second.owner.id, 2);
  assert.notEqual(second.incarnation, first.incarnation);
  second.release();
});

test("owner-held permission work outlives every observer and prevents eviction", async () => {
  let time = 0;
  let closed = 0;
  let retain!: () => () => void;
  const registry = new BridgeRegistry({
    create: (_scope, retainWork) => {
      retain = retainWork;
      return {
        close() {
          closed += 1;
        },
      };
    },
    now: () => time,
    idleMs: 300_000,
    epoch: () => "epoch",
    incarnation: () => "incarnation",
  });
  const observer = await registry.observe(scope);
  const finished = retain();
  observer.release();
  time = 300_001;
  await registry.sweep();
  assert.equal(closed, 0);
  finished();
  time = 600_002;
  await registry.sweep();
  assert.equal(closed, 1);
});

test("owner may retain work during synchronous initialization", async () => {
  let finished!: () => void;
  const registry = new BridgeRegistry({
    create: (_scope, retainWork) => {
      finished = retainWork();
      return { close() {} };
    },
    now: () => 0,
    idleMs: 300_000,
    epoch: () => "epoch",
    incarnation: () => "incarnation",
  });
  const lease = await registry.observe(scope);
  lease.release();
  finished();
});

test("owner creation receives its epoch and incarnation before connecting", async () => {
  let identity: { epoch: string; incarnation: string } | undefined;
  const registry = new BridgeRegistry({
    create: (_scope, _retain, value) => {
      identity = value;
      return { close() {} };
    },
    now: () => 0,
    idleMs: 300_000,
    epoch: () => "epoch-1",
    incarnation: () => "incarnation-1",
  });
  const lease = await registry.observe(scope);
  assert.deepEqual(identity, {
    epoch: lease.epoch,
    incarnation: lease.incarnation,
  });
  lease.release();
});

test("drain rejects new observers, closes streams, and waits for accepted work", async () => {
  const events: string[] = [];
  const registry = new BridgeRegistry({
    create: () => ({
      beginDrain() {
        events.push("streams-closed");
      },
      close() {
        events.push("owner-closed");
      },
    }),
    now: () => 0,
    idleMs: 300_000,
    epoch: () => "epoch",
    incarnation: () => "incarnation",
  });
  const observer = await registry.observe(scope);
  const releaseWork = observer.retainWork();
  observer.release();
  const drained = registry.drain(1_000);
  await Promise.resolve();
  assert.deepEqual(events, ["streams-closed"]);
  await assert.rejects(registry.observe(scope), /draining/i);
  releaseWork();
  assert.deepEqual(await drained, { forced: false });
  assert.deepEqual(events, ["streams-closed", "owner-closed"]);
});

test("drain deadline closes a still-working owner and reports forced handoff", async () => {
  let closed = 0;
  const registry = new BridgeRegistry({
    create: () => ({
      close() {
        closed += 1;
      },
    }),
    now: () => 0,
    idleMs: 300_000,
    epoch: () => "epoch",
    incarnation: () => "incarnation",
  });
  const observer = await registry.observe(scope);
  const releaseWork = observer.retainWork();
  observer.release();
  assert.deepEqual(await registry.drain(1), { forced: true });
  assert.equal(closed, 1);
  releaseWork();
});

test("drain reports a failed owner close instead of claiming a clean handoff", async () => {
  const registry = new BridgeRegistry({
    create: () => ({
      close() {
        throw new Error("ACP connection did not close");
      },
    }),
    now: () => 0,
    idleMs: 300_000,
    epoch: () => "epoch",
    incarnation: () => "incarnation",
  });
  const observer = await registry.observe(scope);
  observer.release();
  assert.deepEqual(await registry.drain(1_000), { forced: true });
});
