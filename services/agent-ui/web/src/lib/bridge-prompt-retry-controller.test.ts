import assert from "node:assert/strict";
import test from "node:test";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import { BridgeAgentController } from "./bridge-agent-controller.ts";
import type { BridgeAgentView } from "./bridge-stream.ts";
import type { PromptAdmission } from "./workspace-api-client.ts";
import { WorkspaceApiError } from "./workspace-api-client.ts";

type ControllerInput = ConstructorParameters<typeof BridgeAgentController>[0];
type ObserverInput = Parameters<NonNullable<ControllerInput["openObserver"]>>[0];
type Stage = "query" | "view";
type Outcome<T> = { status: "fulfilled"; value: T } | { status: "rejected"; reason: unknown };

const originalPrompt: ContentBlock[] = [
  { type: "text", text: "Original Prompt A" },
  { type: "resource", resource: {
    uri: "attachment:///original-a.txt", mimeType: "text/plain", text: "Original attachment A",
  } },
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

function unknownOperation() {
  return { operationId: "intent-a", sessionId: "session-a",
    phase: "uncertain" as const, acceptance: "unknown" as const };
}

function retryView(sessionId: string | null, fresh = false): BridgeAgentView {
  return {
    agentId: "agent", bridgeEpoch: "epoch", availability: "ready",
    promptCapabilities: { image: true, embeddedContext: true }, activeSessionId: null,
    selectedSessionId: sessionId, streamCursor: `${fresh ? "http" : "sse"}-cursor-${sessionId ?? "none"}`,
    operations: [], permissions: [],
    selectedView: sessionId === null ? null : {
      agentId: "agent", sessionId, bridgeEpoch: "epoch", incarnation: "incarnation",
      historyState: "ready", viewRevision: fresh ? 2 : 1,
      title: null, updatedAt: null, appendVersion: fresh ? 2 : 1,
      outputWatermark: fresh ? 2 : 1, historyToken: fresh ? "fresh-token-2" : "original-token-1",
      streamCursor: `${fresh ? "http" : "sse"}-session-cursor`,
      turns: [{ turnId: "saved-turn", outcome: "completed",
        prompt: [{ type: "text", text: "Saved question" }],
        finalResponse: [{ type: "text", text: fresh ? "HTTP candidate answer" : "SSE visible answer" }],
        contentCursor: null, contentSection: null, processVersion: 0, processCount: 0 }],
      olderTurnsCursor: null, operations: [], permissions: [], configOptions: [],
      configurationToken: null, usage: null,
    },
  };
}

function retryControllerFixture(options: {
  pause?: Stage;
  fresh?: unknown;
  queryError?: WorkspaceApiError;
  viewError?: WorkspaceApiError;
} = {}) {
  const releaseQuery = deferred<void>();
  const releaseView = deferred<void>();
  const queryStarted = deferred<void>();
  const viewStarted = deferred<void>();
  const secondObserverStarted = deferred<void>();
  const rawTasks: Promise<unknown>[] = [];
  const jobs: Promise<unknown>[] = [];
  const events: string[] = [];
  const promptCalls: Array<{ agentId: string; sessionId: string; admission: PromptAdmission;
    action: Parameters<ControllerInput["api"]["prompt"]>[4] }> = [];
  const queryCalls: Array<{ agentId: string; sessionId: string; intentId: string;
    signal?: AbortSignal; settled: boolean }> = [];
  const viewCalls: Array<{ agentId: string; sessionId: string | null; signal?: AbortSignal; settled: boolean }> = [];
  const observers: Array<{ input: ObserverInput; closed: boolean; close(): void }> = [];
  const track = <T,>(task: Promise<T>) => {
    rawTasks.push(task);
    void task.catch(() => {});
    return task;
  };
  const api: ControllerInput["api"] = {
    sessionCurrent: () => true,
    onSessionCancelled: () => () => {},
    agentView(agentId, sessionId = null, signal) {
      events.push("view");
      const row = { agentId, sessionId, signal, settled: false };
      viewCalls.push(row);
      return track((async () => {
        try {
          viewStarted.resolve();
          if (options.pause === "view") await releaseView.promise;
          if (options.viewError) throw options.viewError;
          return options.fresh === undefined ? retryView("session-a", true) : options.fresh;
        } finally { row.settled = true; }
      })());
    },
    eventsURL: () => "/events",
    turnContent: async () => ({}),
    turns: async () => ({}),
    prompt(agentId, sessionId, admission, _signal, action) {
      events.push(action === "retry" ? "retry-post" : "original-post");
      promptCalls.push({ agentId, sessionId, admission: structuredClone(admission), action });
      return track(Promise.resolve({ operationId: admission.intentId,
        acceptance: "bridge" as const, phase: "dispatching" as const }));
    },
    operation(agentId, sessionId, intentId, signal) {
      events.push("query");
      const row = { agentId, sessionId, intentId, signal, settled: false };
      queryCalls.push(row);
      return track((async () => {
        try {
          queryStarted.resolve();
          // Deliberately ignore abort: callers must reject this late result.
          if (options.pause === "query") await releaseQuery.promise;
          if (options.queryError) throw options.queryError;
          return unknownOperation();
        } finally { row.settled = true; }
      })());
    },
    cancel: async () => ({}),
    decidePermission: async () => ({}),
    configuration: async () => ({}),
  };
  const controller = new BridgeAgentController({
    agentId: "agent", api,
    openObserver: async (input) => {
      const row = { input, closed: false, close() { this.closed = true; } };
      observers.push(row);
      input.onView(retryView(input.sessionId));
      if (observers.length === 2) secondObserverStarted.resolve();
      return row.close.bind(row);
    },
  });
  const run = <T,>(task: Promise<T>): Promise<Outcome<T>> => {
    const outcome = task.then(
      value => ({ status: "fulfilled" as const, value }),
      reason => ({ status: "rejected" as const, reason: reason as unknown }),
    );
    jobs.push(outcome);
    return outcome;
  };
  return {
    controller, events, promptCalls, queryCalls, viewCalls, observers, run,
    releaseQuery, releaseView, queryStarted, viewStarted, secondObserverStarted,
    async seed() {
      await controller.select("session-a");
      await controller.submitPrompt("intent-a", structuredClone(originalPrompt));
      const shown = retryView("session-a");
      shown.operations = [unknownOperation()];
      shown.selectedView!.operations = [unknownOperation()];
      observers.at(-1)!.input.onView(shown);
    },
    async finish() {
      controller.close();
      releaseQuery.resolve();
      releaseView.resolve();
      await Promise.allSettled(jobs);
      await Promise.allSettled(rawTasks);
    },
    assertJoined() {
      assert.ok(queryCalls.every(row => row.settled));
      assert.ok(viewCalls.every(row => row.settled));
      assert.ok(observers.every(row => row.closed));
    },
  };
}

async function actualStageStarted(
  started: Promise<void>, pending: Promise<unknown>, signal: AbortSignal,
): Promise<void> {
  let abort!: () => void;
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => reject(new Error("Controller regression stopped before its actual held stage started"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    await Promise.race([started, interrupted, pending.then(() => {
      throw new Error("Actual retry settled before its expected held stage started");
    })]);
  } finally { signal.removeEventListener("abort", abort); }
}

test("Controller retries the immutable original CAS and attachment using only the fresh View token", async () => {
  const f = retryControllerFixture();
  let result;
  let shownBefore;
  let shownAfter;
  try {
    await f.seed();
    shownBefore = f.controller.snapshot;
    result = await f.run(f.controller.retryPrompt("intent-a"));
    shownAfter = f.controller.snapshot;
  } finally { await f.finish(); }
  f.assertJoined();
  assert.equal(result?.status, "fulfilled");
  assert.deepEqual(f.events, ["original-post", "query", "view", "retry-post"]);
  assert.deepEqual(f.queryCalls.map(({ agentId, sessionId, intentId }) => ({ agentId, sessionId, intentId })),
    [{ agentId: "agent", sessionId: "session-a", intentId: "intent-a" }]);
  assert.deepEqual(f.viewCalls.map(({ agentId, sessionId }) => ({ agentId, sessionId })),
    [{ agentId: "agent", sessionId: "session-a" }]);
  assert.equal(f.promptCalls.length, 2);
  assert.deepEqual(f.promptCalls[1], { agentId: "agent", sessionId: "session-a", action: "retry",
    admission: { intentId: "intent-a", expectedAppendVersion: 1,
      historyToken: "fresh-token-2", prompt: originalPrompt } });
  assert.equal(f.promptCalls[0]!.admission.historyToken, "original-token-1");
  assert.strictEqual(shownAfter?.view, shownBefore?.view);
  assert.strictEqual(shownAfter?.conversation, shownBefore?.conversation);
  assert.equal(shownAfter?.conversation?.messages[1]?.content, "SSE visible answer");
});

for (const location of ["agent", "selected-session"] as const) {
  test(`Controller adopts a durable ${location} receipt from fresh View without replacing the SSE projection`, async () => {
    const fresh = retryView("session-a", true);
    const receipt = { operationId: "intent-a", sessionId: "session-a", acceptance: "acp" as const,
      phase: location === "agent" ? "completed" as const : "uncertain" as const,
      runId: "durable-run-a", outputWatermark: 2 };
    if (location === "agent") fresh.operations = [receipt];
    else fresh.selectedView!.operations = [receipt];
    const f = retryControllerFixture({ fresh });
    let result;
    let shownBefore;
    let shownAfter;
    try {
      await f.seed();
      shownBefore = f.controller.snapshot;
      result = await f.run(f.controller.retryPrompt("intent-a"));
      shownAfter = f.controller.snapshot;
    } finally { await f.finish(); }
    f.assertJoined();
    assert.equal(result?.status, "fulfilled");
    if (result?.status === "fulfilled") {
      assert.equal(result.value.acceptance, "acp");
      assert.equal(result.value.runId, "durable-run-a");
      assert.equal(result.value.phase, receipt.phase);
      assert.equal(result.value.retryAvailable, undefined);
    }
    assert.deepEqual(f.events, ["original-post", "query", "view"]);
    assert.equal(f.promptCalls.length, 1);
    assert.strictEqual(shownAfter?.view, shownBefore?.view);
    assert.strictEqual(shownAfter?.conversation, shownBefore?.conversation);
    assert.equal(shownAfter?.operations.find(row => row.operationId === "intent-a")?.runId, "durable-run-a");
  });
}

for (const stage of ["query", "view"] as const) {
  for (const invalidation of ["release", "session-change", "close", "external-abort"] as const) {
    test(`Controller does not POST after ${invalidation} while the actual retry ${stage} is held`,
      { timeout: 2_000 }, async (t) => {
        const f = retryControllerFixture({ pause: stage });
        const external = new AbortController();
        let result;
        let signalAborted = false;
        let later;
        try {
          await f.seed();
          const pending = f.run(f.controller.retryPrompt("intent-a", external.signal));
          await actualStageStarted(stage === "query" ? f.queryStarted.promise : f.viewStarted.promise,
            pending, t.signal);
          if (invalidation === "release") f.controller.releasePromptRetry();
          else if (invalidation === "session-change") await f.controller.select("session-b");
          else if (invalidation === "close") f.controller.close();
          else external.abort();
          signalAborted = (stage === "query" ? f.queryCalls[0] : f.viewCalls[0])!.signal?.aborted === true;
          f.releaseQuery.resolve(); f.releaseView.resolve();
          result = await pending;
          if (invalidation === "release" || invalidation === "session-change") {
            await f.controller.select("session-a");
            // Navigating back can query the original operation, but its body is gone.
            later = await f.run(f.controller.retryPrompt("intent-a"));
          }
        } finally {
          external.abort();
          await f.finish();
        }
        f.assertJoined();
        assert.equal(signalAborted, true);
        assert.equal(result?.status, "rejected");
        assert.equal(f.promptCalls.length, 1);
        if (invalidation === "release" || invalidation === "session-change") {
          assert.equal(later?.status, "fulfilled");
          if (later?.status === "fulfilled") assert.equal(later.value.retryAvailable, undefined);
          assert.equal(f.queryCalls.length, 2);
          assert.equal(f.viewCalls.length, stage === "view" ? 1 : 0);
        }
      });
  }
}

for (const reselection of ["same-session-select", "observer-resync"] as const) {
  test(`Controller ${reselection} cancels its current attempt, retains input and waits for another explicit retry`,
    { timeout: 2_000 }, async (t) => {
      const f = retryControllerFixture({ pause: "query" });
      let cancelled;
      let retried;
      let availableAfterReselect;
      let postsAfterCancelled = 0;
      try {
        await f.seed();
        const pending = f.run(f.controller.retryPrompt("intent-a"));
        await actualStageStarted(f.queryStarted.promise, pending, t.signal);
        if (reselection === "same-session-select") await f.controller.select("session-a");
        else {
          f.observers.at(-1)!.input.onResync();
          await actualStageStarted(f.secondObserverStarted.promise, pending, t.signal);
        }
        availableAfterReselect = f.controller.snapshot.operations.find(row => row.operationId === "intent-a")?.retryAvailable;
        f.releaseQuery.resolve();
        cancelled = await pending;
        postsAfterCancelled = f.promptCalls.length;
        retried = await f.run(f.controller.retryPrompt("intent-a"));
      } finally { await f.finish(); }
      f.assertJoined();
      assert.equal(cancelled?.status, "rejected");
      assert.equal(availableAfterReselect, true);
      assert.equal(postsAfterCancelled, 1, "Resync must not queue a Prompt behind the cancelled decision");
      assert.equal(retried?.status, "fulfilled");
      assert.equal(f.promptCalls.length, 2);
      assert.equal(f.queryCalls.length, 2);
      assert.equal(f.viewCalls.length, 1);
      assert.equal(f.observers.length, 2);
      assert.deepEqual(f.promptCalls[1], { agentId: "agent", sessionId: "session-a", action: "retry",
        admission: { intentId: "intent-a", expectedAppendVersion: 1,
          historyToken: "fresh-token-2", prompt: originalPrompt } });
    });
}

for (const stage of ["query", "view"] as const) {
  for (const status of [401, 403] as const) {
    test(`Controller retires and clears retry state after ${status} from its ${stage}`, async () => {
      const denied = new WorkspaceApiError("Access no longer available", status,
        status === 401 ? "unauthorized" : "access_denied", status === 401 ? "login" : "none");
      const f = retryControllerFixture(stage === "query" ? { queryError: denied } : { viewError: denied });
      let result;
      let after;
      let repeated;
      let readsAfterDenied = 0;
      try {
        await f.seed();
        result = await f.run(f.controller.retryPrompt("intent-a"));
        after = f.controller.snapshot;
        readsAfterDenied = f.queryCalls.length;
        repeated = await f.run(f.controller.retryPrompt("intent-a"));
      } finally { await f.finish(); }
      f.assertJoined();
      assert.equal(result?.status, "rejected");
      if (result?.status === "rejected") assert.strictEqual(result.reason, denied);
      assert.equal(repeated?.status, "rejected");
      assert.equal(after?.connection, "offline");
      assert.equal(after?.view, null);
      assert.deepEqual(after?.operations, []);
      assert.equal(status === 401 ? after?.unauthenticated : after?.revoked, true);
      assert.equal(f.queryCalls.length, readsAfterDenied);
      assert.equal(f.promptCalls.length, 1);
      assert.equal(f.viewCalls.length, stage === "view" ? 1 : 0);
    });
  }
}

const invalidFreshViews: Array<[string, () => unknown]> = [
  ["another Agent", () => ({ ...retryView("session-a", true), agentId: "another-agent" })],
  ["another selected Session", () => retryView("session-b", true)],
  ["mismatched embedded Session", () => {
    const fresh = retryView("session-a", true);
    return { ...fresh, selectedView: { ...fresh.selectedView, sessionId: "session-b" } };
  }],
  ["blocked history", () => {
    const fresh = retryView("session-a", true);
    return { ...fresh, selectedView: { ...fresh.selectedView, historyState: "blocked", historyToken: null } };
  }],
  ["malformed View", () => ({ agentId: "agent", selectedSessionId: "session-a" })],
  ["null View", () => null],
  ["empty history token", () => {
    const fresh = retryView("session-a", true);
    return { ...fresh, selectedView: { ...fresh.selectedView, historyToken: "" } };
  }],
];

for (const [name, fresh] of invalidFreshViews) {
  test(`Controller refuses original Prompt retry with ${name}`, async () => {
    const f = retryControllerFixture({ fresh: fresh() });
    let result;
    let shownBefore;
    let shownAfter;
    try {
      await f.seed();
      shownBefore = f.controller.snapshot;
      result = await f.run(f.controller.retryPrompt("intent-a"));
      shownAfter = f.controller.snapshot;
    } finally { await f.finish(); }
    f.assertJoined();
    assert.equal(result?.status, "rejected");
    assert.deepEqual(f.events, ["original-post", "query", "view"]);
    assert.equal(f.promptCalls.length, 1);
    assert.strictEqual(shownAfter?.view, shownBefore?.view);
    assert.strictEqual(shownAfter?.conversation, shownBefore?.conversation);
  });
}

for (const source of ["fresh-view", "observer-during-view", "fresh-view-with-receipt"] as const) {
  test(`Controller original Prompt retry respects preparing from ${source}`,
    { timeout: 2_000 }, async (t) => {
      const fresh = retryView("session-a", true);
      const receipt = { operationId: "intent-a", sessionId: "session-a", acceptance: "acp" as const,
        phase: "completed" as const, runId: "durable-run-a", outputWatermark: 2 };
      if (source !== "observer-during-view") {
        fresh.availability = "offline";
        fresh.unavailableReason = "agent_preparing";
        fresh.activeSessionId = null;
      }
      if (source === "fresh-view-with-receipt") fresh.operations = [receipt];
      const f = retryControllerFixture(source === "observer-during-view"
        ? { pause: "view", fresh } : { fresh });
      let result;
      let shownBefore;
      let shownAfter;
      try {
        await f.seed();
        shownBefore = f.controller.snapshot;
        const pending = f.run(f.controller.retryPrompt("intent-a"));
        if (source === "observer-during-view") {
          await actualStageStarted(f.viewStarted.promise, pending, t.signal);
          const preparing = retryView("session-a");
          preparing.availability = "offline";
          preparing.unavailableReason = "agent_preparing";
          preparing.activeSessionId = null;
          preparing.operations = [unknownOperation()];
          preparing.selectedView!.operations = [unknownOperation()];
          f.observers.at(-1)!.input.onView(preparing);
          f.releaseView.resolve();
        }
        result = await pending;
        shownAfter = f.controller.snapshot;
      } finally { await f.finish(); }
      f.assertJoined();
      assert.equal(f.promptCalls.length, 1, "preparing must not dispatch another copy of the original Prompt");
      assert.deepEqual(f.events, ["original-post", "query", "view"]);
      assert.deepEqual(f.promptCalls[0], {
        agentId: "agent", sessionId: "session-a", action: undefined,
        admission: { intentId: "intent-a", expectedAppendVersion: 1,
          historyToken: "original-token-1", prompt: originalPrompt },
      });
      const originalBefore = shownBefore?.operations.find(row => row.operationId === "intent-a");
      const originalAfter = shownAfter?.operations.find(row => row.operationId === "intent-a");
      assert.equal(originalBefore?.retryAvailable, true);
      if (source === "fresh-view-with-receipt") {
        assert.equal(result?.status, "fulfilled");
        if (result?.status === "fulfilled") {
          assert.equal(result.value.acceptance, "acp");
          assert.equal(result.value.runId, receipt.runId);
          assert.equal(result.value.phase, receipt.phase);
          assert.equal(result.value.retryAvailable, undefined);
        }
        assert.equal(originalAfter?.runId, receipt.runId);
        assert.equal(originalAfter?.acceptance, "acp");
        assert.equal(originalAfter?.retryAvailable, undefined);
      } else {
        assert.ok(result, "the actual retry decision must settle");
        assert.equal(originalAfter?.phase, "uncertain");
        assert.equal(originalAfter?.acceptance, "unknown");
        assert.equal(originalAfter?.retryAvailable, true, "preparing retains the immutable original input for a later explicit action");
      }
      if (source === "observer-during-view") {
        assert.equal(shownAfter?.view?.availability, "offline");
        assert.equal(shownAfter?.view?.unavailableReason, "agent_preparing");
      } else {
        assert.strictEqual(shownAfter?.view, shownBefore?.view, "the HTTP candidate must not replace the observed SSE projection");
      }
    });
}
