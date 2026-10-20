import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentBridgeOwner, type AcpBridgePort } from "../src/bridge/agent-owner.ts";
import { BridgeRegistry, type BridgeScope } from "../src/bridge/registry.ts";
import { HttpBodyCleanupError } from "../src/adapters/owned-http-response.ts";
import { CALLER_CONTEXT_HEADER } from "../src/adapters/caller-context.ts";
import { bindScopeContext, scopeHeaders } from "../src/http/trusted-identity.ts";
import { testContext } from "./support/auth-fixture.ts";

const scope = { organizationId: "org", principalId: "user", agentId: "agent" };
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
const cleanupFailure = () => new AggregateError(
  [new Error("ACP DELETE cleanup failed")], "ACP cleanup failed");

async function fixture(options: {
  qualified?: boolean; heldWatch?: boolean; watchFailure?: boolean;
  callbackFailure?: boolean; replacementFailure?: boolean; maxOwners?: number;
} = {}) {
  const disconnected = deferred(), cleanup = deferred(), watch = deferred();
  const seen: BridgeScope[] = [];
  let created = 0;
  const registry = new BridgeRegistry({
    now: () => 0, idleMs: 0, maxOwners: options.maxOwners,
    epoch: () => "epoch", incarnation: () => `incarnation-${created + 1}`,
    create: async (current, retainWork) => {
      seen.push(current);
      if (++created !== 1) {
        if (options.replacementFailure) throw new Error("fresh authorization denied");
        return AgentBridgeOwner.open({ scope: current, retainWork,
          connect: async () => ({ close() {} }) as AcpBridgePort });
      }
      return AgentBridgeOwner.open({ scope: current, retainWork,
        closed: () => { if (options.callbackFailure) throw new Error("owner callback failed"); },
        connect: async () => ({
          closed: disconnected.promise,
          canReplaceAfterPeerLoss: options.qualified ?? true,
          close: () => cleanup.promise,
          async watchAgentExecutionState(_changed: unknown, signal: AbortSignal) {
            if (!options.heldWatch && !options.watchFailure) return;
            await new Promise<void>((resolve) => {
              if (signal.aborted) resolve();
              else signal.addEventListener("abort", () => resolve(), { once: true });
            });
            await watch.promise;
            if (options.watchFailure) throw new HttpBodyCleanupError();
          },
        }) as AcpBridgePort,
      });
    },
  });
  const originalScope = { ...scope };
  bindScopeContext(originalScope, testContext({
    sub: scope.principalId, org: scope.organizationId, agt: scope.agentId,
  }));
  const first = await registry.observe(originalScope);
  first.release();
  return { registry, first, disconnected, cleanup, watch, seen,
    get created() { return created; },
    async dispose() {
      disconnected.resolve(); cleanup.reject(cleanupFailure()); watch.resolve();
      await registry.drain(0);
    },
  };
}

test("first concurrent observations replace a lost peer only after cleanup and watch join", async () => {
  const f = await fixture({ heldWatch: true });
  try {
    const oldToken = scopeHeaders(f.seen[0], "agent-acp-service")[CALLER_CONTEXT_HEADER];
    const current = { ...scope };
    const context = testContext({ sub: scope.principalId, org: scope.organizationId, agt: scope.agentId });
    assert.notEqual(context.token, oldToken);
    bindScopeContext(current, context);
    f.disconnected.resolve();
    await turn();
    const oldClose = f.first.owner.close();
    assert.equal(f.first.owner.canReplaceAfterPeerLoss, false);
    let settled = 0;
    const observing = [f.registry.observe(current), f.registry.observe(current)];
    for (const task of observing) void task.then(() => { settled++; }, () => { settled++; });
    const failure = cleanupFailure();
    f.cleanup.reject(failure);
    await turn();
    assert.equal(settled, 0, "transport cleanup alone does not join the watch");
    assert.equal(f.created, 1);
    f.watch.resolve();
    const leases = await Promise.all(observing);
    assert.equal(f.created, 2, "one replacement for concurrent original requests");
    assert.equal(leases[0].owner, leases[1].owner);
    assert.notEqual(leases[0].incarnation, f.first.incarnation);
    assert.equal(f.seen[1], current, "replacement uses the current authenticated scope");
    assert.equal(scopeHeaders(f.seen[1], "agent-acp-service")[CALLER_CONTEXT_HEADER],
      context.token, "the replacement must forward this original request's delegation");
    assert.equal(f.first.owner.canReplaceAfterPeerLoss, true);
    assert.equal(f.first.owner.close(), oldClose, "the original close failure remains stable");
    await assert.rejects(oldClose, (error: AggregateError) => error.errors.includes(failure));
    for (const lease of leases) lease.release();
  } finally { await f.dispose(); }
});

for (const kind of ["unqualified", "watch", "callback", "requested"] as const) {
  test(`a ${kind} cleanup failure cannot be bypassed by later observations or sweep`, async () => {
    const f = await fixture({ qualified: kind !== "unqualified",
      watchFailure: kind === "watch", callbackFailure: kind === "callback" });
    try {
      if (kind === "requested") void f.first.owner.close().catch(() => {});
      f.disconnected.resolve();
      f.cleanup.reject(cleanupFailure()); f.watch.resolve();
      await turn();
      await assert.rejects(f.first.owner.close(), /cleanup failed/);
      assert.equal(f.first.owner.canReplaceAfterPeerLoss, false);
      for (let attempt = 0; attempt < 2; attempt++)
        await assert.rejects(f.registry.observe(scope), /cleanup failed/);
      for (let attempt = 0; attempt < 2; attempt++)
        await assert.rejects(f.registry.sweep(), /sweep failed/);
      assert.equal(f.created, 1);
      assert.deepEqual(await f.registry.drain(0), { forced: true });
      assert.equal(f.registry.snapshotMetrics().owners, 0);
    } finally { await f.dispose(); }
  });
}

test("registry drain joins the original failure and never publishes a concurrent replacement", async () => {
  const f = await fixture({ heldWatch: true });
  try {
    f.disconnected.resolve(); await turn();
    const observation = f.registry.observe(scope).then(() => "published", () => "rejected");
    const draining = f.registry.drain(0);
    f.cleanup.reject(cleanupFailure()); f.watch.resolve();
    assert.equal(await observation, "rejected");
    assert.deepEqual(await draining, { forced: true });
    assert.equal(f.created, 1);
    assert.equal(f.registry.snapshotMetrics().owners, 0);
  } finally { await f.dispose(); }
});

test("a qualified cold peer can free capacity for another authenticated scope", async () => {
  const f = await fixture({ maxOwners: 1 });
  try {
    f.disconnected.resolve(); f.cleanup.reject(cleanupFailure()); await turn();
    await assert.rejects(f.registry.sweep(), /sweep failed/);
    const replacement = await f.registry.observe({ ...scope, agentId: "other-agent" });
    assert.equal(f.created, 2);
    assert.equal(f.registry.snapshotMetrics().owners, 1);
    replacement.release();
  } finally { await f.dispose(); }
});

test("a replacement initialization failure is returned without an internal retry", async () => {
  const f = await fixture({ replacementFailure: true });
  try {
    f.disconnected.resolve(); f.cleanup.reject(cleanupFailure()); await turn();
    await assert.rejects(f.registry.observe(scope), /fresh authorization denied/);
    assert.equal(f.created, 2);
  } finally { await f.dispose(); }
});

test("a quarantined cold owner does not prevent eviction of another eligible idle owner", async () => {
  const registry = new BridgeRegistry({
    now: () => 0, idleMs: 0, maxOwners: 2,
    epoch: () => "epoch", incarnation: () => "incarnation",
    create: (current) => ({
      isClosed: false,
      close() {
        this.isClosed = true;
        if (current.agentId === "agent") throw new Error("unknown cleanup failure");
      },
    }),
  });
  try {
    const bad = await registry.observe(scope);
    bad.release(); bad.owner.isClosed = true;
    await assert.rejects(registry.observe(scope), /unknown cleanup failure/);
    (await registry.observe({ ...scope, agentId: "idle" })).release();
    const next = await registry.observe({ ...scope, agentId: "new" });
    assert.equal(registry.snapshotMetrics().owners, 2);
    next.release();
    await assert.rejects(registry.observe(scope), /unknown cleanup failure/);
  } finally { await registry.drain(0); }
});

test("unfinished held work prevents peer replacement even without observers", async () => {
  const f = await fixture();
  const lease = await f.registry.observe(scope);
  const releaseWork = lease.retainWork();
  lease.release();
  try {
    f.disconnected.resolve(); f.cleanup.reject(cleanupFailure()); await turn();
    await assert.rejects(f.registry.observe(scope), /cleanup failed/);
    assert.equal(f.created, 1);
    assert.equal(f.registry.snapshotMetrics().observerLeases, 0);
    assert.equal(f.registry.snapshotMetrics().heldWork, 1);
    releaseWork();
    const replacement = await f.registry.observe(scope);
    assert.equal(f.created, 2);
    replacement.release();
  } finally { releaseWork(); lease.release(); await f.dispose(); }
});

test("an unreleased retired lease cannot retain new work", async () => {
  const f = await fixture();
  const lease = await f.registry.observe(scope);
  try {
    f.disconnected.resolve(); f.cleanup.reject(cleanupFailure()); await turn();
    assert.throws(() => lease.retainWork(), /retired/);
  } finally { lease.release(); await f.dispose(); }
});

test("cold eviction rechecks a candidate acquired while an earlier retirement was pending", async () => {
  const cleanup = deferred(), started = deferred();
  const closed: string[] = [];
  const registry = new BridgeRegistry({
    now: () => 0, idleMs: 0, maxOwners: 2,
    epoch: () => "epoch", incarnation: () => "incarnation",
    create: (current) => ({
      isClosed: false,
      close() {
        this.isClosed = true; closed.push(current.agentId);
        if (current.agentId === "agent") { started.resolve(); return cleanup.promise; }
      },
    }),
  });
  (await registry.observe(scope)).release();
  (await registry.observe({ ...scope, agentId: "second" })).release();
  let releaseWork: (() => void) | undefined;
  let releaseLease: (() => void) | undefined;
  let releaseNew: (() => void) | undefined;
  try {
    const observing = registry.observe({ ...scope, agentId: "new" }).then((lease) => {
      releaseNew = lease.release; return "created";
    }, () => "rejected");
    await started.promise;
    const active = await registry.observe({ ...scope, agentId: "second" });
    releaseLease = active.release;
    releaseWork = active.retainWork();
    cleanup.reject(new Error("first cleanup failed"));
    assert.equal(await observing, "rejected");
    assert.deepEqual(closed, ["agent"], "the newly active second owner must remain open");
    assert.equal(active.owner.isClosed, false);
  } finally {
    cleanup.reject(new Error("first cleanup failed"));
    releaseNew?.(); releaseWork?.(); releaseLease?.();
    await registry.drain(0);
  }
});
