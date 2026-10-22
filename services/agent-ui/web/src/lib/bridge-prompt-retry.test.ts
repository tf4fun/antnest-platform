import assert from "node:assert/strict";
import test from "node:test";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import { BridgeOperationTracker, type BridgeOperation } from "./bridge-operations.ts";
import { WorkspaceApiError, type PromptAccepted, type PromptAdmission } from "./workspace-api-client.ts";

const sessionId = "session-original";
const intentId = "intent-original";
const freshHistory = "history-current-authority";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function admission(id = intentId, prompt: ContentBlock[] = [
  { type: "text", text: "Original question" },
  { type: "image", mimeType: "image/png", data: "AQIDBA==" },
  { type: "resource", resource: {
    uri: "attachment:///original.pdf", mimeType: "application/pdf", blob: "JVBERi0xCg==",
  } },
  { type: "text", text: "Final ordered instruction" },
]): PromptAdmission {
  return { intentId: id, expectedAppendVersion: 7, prompt, historyToken: "history-original" };
}

function unknownOperation(session = sessionId, intent = intentId) {
  return { operationId: intent, sessionId: session, phase: "uncertain", acceptance: "unknown" };
}

function receipt(phase: BridgeOperation["phase"] = "running", session = sessionId, intent = intentId) {
  return { operationId: intent, sessionId: session, phase, acceptance: "acp" as const,
    runId: `run-${session}-${intent}`, outputWatermark: 9 };
}

function acknowledgement(intent: string): PromptAccepted {
  return { operationId: intent, acceptance: "bridge", phase: "dispatching" };
}

function body(input: PromptAdmission) {
  return { intentId: input.intentId, expectedAppendVersion: input.expectedAppendVersion, prompt: input.prompt };
}

function operationWire(operation: BridgeOperation | undefined): BridgeOperation | undefined {
  if (operation === undefined) return undefined;
  const wire = { ...operation };
  delete wire.retryAvailable;
  return wire;
}

type PromptCall = {
  agentId: string; sessionId: string; admission: PromptAdmission;
  signal?: AbortSignal; action?: "retry"; argumentsCount: number;
};
type ReadCall = { agentId: string; sessionId: string; intentId: string; signal?: AbortSignal };

function fixture(options: {
  agentId?: string;
  prompt?: (call: PromptCall) => PromptAccepted | Promise<PromptAccepted>;
  read?: (call: ReadCall) => unknown | Promise<unknown>;
  refresh?: () => string | Promise<string>;
} = {}) {
  let current = true;
  let refreshes = 0;
  let cancelled = 0;
  const prompts: PromptCall[] = [];
  const reads: ReadCall[] = [];
  const changes: BridgeOperation[] = [];
  const pending: Promise<unknown>[] = [];
  const releases: Array<() => void> = [];
  const events: string[] = [];
  function track<T>(promise: Promise<T>): Promise<T> {
    pending.push(promise);
    void promise.catch(() => {});
    return promise;
  }
  const tracker = new BridgeOperationTracker({
    agentId: options.agentId ?? "agent-original",
    api: {
      sessionCurrent: () => current,
      async prompt(agentId, session, input, signal, action?: "retry") {
        const call: PromptCall = { agentId, sessionId: session, admission: structuredClone(input),
          signal, action, argumentsCount: arguments.length };
        prompts.push(call);
        events.push(action === "retry" ? "retry-post" : "ordinary-post");
        return track(Promise.resolve().then(() => options.prompt?.(call) ?? acknowledgement(input.intentId)));
      },
      async operation(agentId, session, intent, signal) {
        const call = { agentId, sessionId: session, intentId: intent, signal };
        reads.push(call);
        events.push("query");
        return track(Promise.resolve().then(() => options.read === undefined
          ? unknownOperation(session, intent) : options.read(call)));
      },
      async cancel() { cancelled++; return assert.fail("Retry must not cancel an ACP Run"); },
    },
    changed: value => changes.push(structuredClone(value)),
  });
  const refreshHistory = async () => {
    refreshes++;
    events.push("refresh-history");
    return track(Promise.resolve().then(() => options.refresh?.() ?? freshHistory));
  };
  function gate<T>(fallback: T) {
    const entered = deferred<void>();
    const response = deferred<T>();
    let joined = false;
    releases.push(() => response.resolve(fallback));
    return {
      entered: entered.promise,
      resolve: response.resolve,
      reject: response.reject,
      get joined() { return joined; },
      async wait(): Promise<T> {
        entered.resolve();
        try { return await response.promise; }
        finally { joined = true; }
      },
    };
  }
  function retry(session = sessionId, intent = intentId, signal?: AbortSignal) {
    try { return track(tracker.retry(session, intent, refreshHistory, signal)); }
    catch (cause) { return track(Promise.reject(cause)); }
  }
  async function seed(input = admission(), session = sessionId) {
    await track(tracker.submit(session, input));
    tracker.observe([unknownOperation(session, input.intentId)]);
    return input;
  }
  async function cleanup() {
    tracker.close();
    for (const release of releases) release();
    let joined = 0;
    while (joined < pending.length) {
      const batch = pending.slice(joined);
      joined = pending.length;
      await Promise.allSettled(batch);
    }
  }
  return { tracker, prompts, reads, changes, events, track, gate, retry, seed, cleanup,
    refreshHistory, setCurrent(value: boolean) { current = value; },
    get refreshes() { return refreshes; }, get cancelled() { return cancelled; } };
}

async function reached(entered: Promise<void>, pending: Promise<unknown>) {
  const actual = await Promise.race([
    entered.then(() => true), pending.then(() => false, () => false),
  ]);
  assert.equal(actual, true, "Retry must actually enter the held boundary before completing");
}

test("explicit retry preserves the complete pre-await input and refreshes only its history token", async () => {
  const f = fixture({ prompt: call => call.action === "retry"
    ? acknowledgement(call.admission.intentId) : original.wait() });
  const original = f.gate(acknowledgement(intentId));
  const input = admission();
  const expected = structuredClone(body(input));
  const submitting = f.track(f.tracker.submit(sessionId, input));
  try {
    await reached(original.entered, submitting);
    const text = input.prompt[0];
    assert.equal(text.type, "text");
    if (text.type === "text") text.text = "Edited current draft";
    const image = input.prompt[1];
    assert.equal(image.type, "image");
    if (image.type === "image") image.data = "DIFFERENT";
    const attachment = input.prompt[2];
    assert.equal(attachment.type, "resource");
    if (attachment.type === "resource" && "blob" in attachment.resource)
      attachment.resource.blob = "REPLACED";
    original.resolve(acknowledgement(intentId));
    await submitting;
    assert.equal(f.tracker.hasRetry(sessionId, intentId), false);
    input.intentId = "new-draft-intent";
    input.expectedAppendVersion = 999;
    input.historyToken = "edited-old-token";
    f.tracker.observe([unknownOperation()]);
    assert.equal(f.tracker.hasRetry(sessionId, intentId), true);
    await f.retry();
    assert.deepEqual(f.events, ["ordinary-post", "query", "refresh-history", "retry-post"]);
    assert.equal(f.prompts.length, 2);
    assert.equal(f.prompts[0].argumentsCount, 4);
    assert.equal(f.prompts[0].action, undefined);
    const retried = f.prompts[1];
    assert.deepEqual(body(retried.admission), expected);
    assert.equal(retried.admission.intentId, intentId);
    assert.equal(retried.admission.historyToken, freshHistory);
    assert.equal(retried.argumentsCount, 5);
    assert.equal(retried.action, "retry");
    assert.deepEqual(f.reads.map(({ agentId, sessionId: session, intentId: intent }) =>
      [agentId, session, intent]), [["agent-original", sessionId, intentId]]);
    assert.deepEqual(operationWire(f.tracker.get(sessionId, intentId)), unknownOperation());
    assert.equal(f.cancelled, 0);
    assert.equal(original.joined, true);
  } finally { await f.cleanup(); }
});

test("concurrent clicks share the complete held query, history refresh and retry POST", async () => {
  const f = fixture({ read: () => query.wait(), refresh: () => view.wait(),
    prompt: call => call.action === "retry" ? post.wait() : acknowledgement(call.admission.intentId) });
  const query = f.gate<unknown>(unknownOperation());
  const view = f.gate(freshHistory);
  const post = f.gate(acknowledgement(intentId));
  const clicks: Promise<unknown>[] = [];
  try {
    await f.seed();
    clicks.push(f.retry());
    await reached(query.entered, clicks[0]);
    clicks.push(f.retry());
    assert.equal(f.reads.length, 1);
    assert.equal(f.refreshes, 0);
    assert.equal(f.prompts.length, 1);
    query.resolve(unknownOperation());
    await reached(view.entered, clicks[0]);
    clicks.push(f.retry());
    assert.equal(f.reads.length, 1);
    assert.equal(f.refreshes, 1);
    assert.equal(f.prompts.length, 1);
    view.resolve(freshHistory);
    await reached(post.entered, clicks[0]);
    clicks.push(f.retry());
    assert.equal(f.reads.length, 1);
    assert.equal(f.refreshes, 1);
    assert.equal(f.prompts.length, 2);
    post.resolve(acknowledgement(intentId));
    await Promise.all(clicks);
    assert.equal(f.prompts.filter(call => call.action === "retry").length, 1);
    assert.deepEqual(f.events, ["ordinary-post", "query", "refresh-history", "retry-post"]);
    assert.equal(query.joined && view.joined && post.joined, true);
  } finally { await f.cleanup(); }
});

test("an unknown observation cannot retry an original browser POST whose actual Promise is still held", async () => {
  const f = fixture({ prompt: call => f.prompts.length === 1
    ? original.wait() : acknowledgement(call.admission.intentId) });
  const original = f.gate(acknowledgement(intentId));
  const submitting = f.track(f.tracker.submit(sessionId, admission()));
  try {
    await reached(original.entered, submitting);
    f.tracker.observe([unknownOperation()]);
    const retrying = f.retry();
    await retrying;
    assert.ok(f.reads.length <= 1);
    assert.equal(f.refreshes, 0);
    assert.equal(f.prompts.length, 1);
    assert.equal(f.tracker.hasRetry(sessionId, intentId), false);
    assert.equal(original.joined, false);
    original.resolve(acknowledgement(intentId));
    await submitting;
    await retrying;
    assert.equal(original.joined, true);
    assert.equal(f.refreshes, 0);
    assert.equal(f.prompts.length, 1);
    assert.deepEqual(operationWire(f.tracker.get(sessionId, intentId)), unknownOperation());
  } finally { await f.cleanup(); }
});

for (const phase of ["uncertain", "running", "completed"] as const) {
  test(`a queried durable ${phase} Run is adopted without retrying its Prompt`, async () => {
    const durable = receipt(phase);
    const f = fixture({ read: () => durable });
    try {
      await f.seed();
      await f.retry();
      assert.deepEqual(operationWire(f.tracker.get(sessionId, intentId)), durable);
      assert.equal(f.tracker.hasRetry(sessionId, intentId), false);
      assert.equal(f.reads.length, 1);
      assert.equal(f.refreshes, 0);
      assert.equal(f.prompts.length, 1);
    } finally { await f.cleanup(); }
  });
}

test("an unknown acceptance carrying an existing Run never authorizes another POST", async () => {
  const f = fixture({ read: () => ({ ...receipt("uncertain"), acceptance: "unknown" }) });
  try {
    await f.seed();
    await Promise.allSettled([f.retry()]);
    assert.equal(f.reads.length, 1);
    assert.equal(f.refreshes, 0);
    assert.equal(f.prompts.length, 1);
  } finally { await f.cleanup(); }
});

const invalidQueries: Array<[string, unknown]> = [
  ["null", null],
  ["array", []],
  ["missing operation", {}],
  ["another Session", unknownOperation("session-other")],
  ["another intent", unknownOperation(sessionId, "intent-other")],
  ["invalid phase", { ...unknownOperation(), phase: "unknown" }],
  ["invalid acceptance", { ...unknownOperation(), acceptance: "missing" }],
  ["ACP acceptance without a Run", { ...unknownOperation(), acceptance: "acp" }],
  ["ACP acceptance with invalid watermark", { ...receipt("uncertain"), outputWatermark: -1 }],
];
for (const [label, value] of [...invalidQueries,
  ...[123, null, "", {}].map(runId => ["malformed Run identifier", { ...unknownOperation(), runId }] as const),
  ...[-1, null, "1", 1.5].map(outputWatermark => ["malformed watermark", { ...unknownOperation(), outputWatermark }] as const),
  ["unexpected field", { ...unknownOperation(), run_id: "hidden-run" }] as const,
]) {
  test(`a ${label} operation query is rejected without refreshing or posting`, async () => {
    const f = fixture({ read: () => value });
    try {
      await f.seed();
      await assert.rejects(f.retry());
      assert.equal(f.reads.length, 1);
      assert.equal(f.refreshes, 0);
      assert.equal(f.prompts.length, 1);
      assert.deepEqual(operationWire(f.tracker.get(sessionId, intentId)), unknownOperation());
    } finally { await f.cleanup(); }
  });
}

test("a failed operation query is not absence and never queues a later retry", async () => {
  const failure = new WorkspaceApiError("Query unavailable", 503, "upstream_unavailable", "retry_read");
  const f = fixture({ read: () => { throw failure; } });
  try {
    await f.seed();
    await assert.rejects(f.retry(), cause => cause === failure);
    f.tracker.observe([unknownOperation()]);
    assert.equal(f.reads.length, 1);
    assert.equal(f.refreshes, 0);
    assert.equal(f.prompts.length, 1);
    assert.deepEqual(operationWire(f.tracker.get(sessionId, intentId)), unknownOperation());
  } finally { await f.cleanup(); }
});

for (const outcome of ["failure", "empty", "blank"] as const) {
  test(`a ${outcome} history refresh cannot dispatch the retained Prompt`, async () => {
    const f = fixture({ refresh: () => {
      if (outcome === "failure") throw new Error("History authority unavailable");
      return outcome === "empty" ? "" : "   ";
    } });
    try {
      await f.seed();
      await assert.rejects(f.retry());
      assert.equal(f.reads.length, 1);
      assert.equal(f.refreshes, 1);
      assert.equal(f.prompts.length, 1);
      assert.deepEqual(operationWire(f.tracker.get(sessionId, intentId)), unknownOperation());
    } finally { await f.cleanup(); }
  });
}

for (const returned of ["unknown", "durable"] as const) {
  test(`a reload without original input queries the ${returned} operation and never reconstructs a Prompt`, async () => {
    const result = returned === "unknown" ? unknownOperation() : receipt();
    const f = fixture({ read: () => result });
    try {
      f.tracker.observe([unknownOperation()]);
      assert.equal(f.tracker.hasRetry(sessionId, intentId), false);
      await f.retry();
      assert.equal(f.reads.length, 1);
      assert.equal(f.refreshes, 0);
      assert.equal(f.prompts.length, 0);
      assert.deepEqual(operationWire(f.tracker.get(sessionId, intentId)), result);
    } finally { await f.cleanup(); }
  });
}

test("retry input for the same intent cannot migrate into another Session", async () => {
  const f = fixture();
  try {
    const original = await f.seed();
    f.tracker.observe([unknownOperation("session-other")]);
    assert.equal(f.tracker.hasRetry("session-other", intentId), false);
    await f.retry("session-other");
    assert.equal(f.prompts.length, 1);
    assert.equal(f.refreshes, 0);
    assert.equal(f.reads[0].sessionId, "session-other");
    await f.retry();
    assert.equal(f.prompts.length, 2);
    assert.equal(f.prompts[1].sessionId, sessionId);
    assert.deepEqual(body(f.prompts[1].admission), body(original));
  } finally { await f.cleanup(); }
});

test("a separate Agent owner cannot reuse another owner's retained input", async () => {
  const original = fixture();
  const replacement = fixture({ agentId: "agent-other" });
  try {
    await original.seed();
    replacement.tracker.observe([unknownOperation()]);
    assert.equal(replacement.tracker.hasRetry(sessionId, intentId), false);
    await replacement.retry();
    assert.equal(replacement.prompts.length, 0);
    assert.equal(replacement.refreshes, 0);
    assert.equal(replacement.reads[0].agentId, "agent-other");
    assert.equal(original.prompts.length, 1);
  } finally { await Promise.all([original.cleanup(), replacement.cleanup()]); }
});

test("an already aborted retry cannot start a query, refresh or POST", async () => {
  const f = fixture();
  const request = new AbortController();
  try {
    await f.seed();
    request.abort(new Error("Original action cancelled"));
    await assert.rejects(f.retry(sessionId, intentId, request.signal));
    assert.equal(f.reads.length, 0);
    assert.equal(f.refreshes, 0);
    assert.equal(f.prompts.length, 1);
  } finally { await f.cleanup(); }
});

for (const boundary of ["query", "history"] as const) {
  for (const invalidation of ["abort", "clear", "close", "session replacement"] as const) {
    test(`${invalidation} during the held ${boundary} forbids a later POST and joins the actual await`, async () => {
      const f = fixture({ read: () => boundary === "query" ? query.wait() : unknownOperation(),
        refresh: () => view.wait() });
      const query = f.gate<unknown>(unknownOperation());
      const view = f.gate(freshHistory);
      const request = new AbortController();
      try {
        await f.seed();
        const pending = f.retry(sessionId, intentId, request.signal);
        const held = boundary === "query" ? query : view;
        await reached(held.entered, pending);
        if (invalidation === "abort") request.abort(new Error("Action cancelled at await boundary"));
        else if (invalidation === "clear") f.tracker.clearRetryInputs();
        else if (invalidation === "close") f.tracker.close();
        else f.setCurrent(false);
        const previousChanges = f.changes.length;
        if (invalidation === "clear" || invalidation === "close") {
          assert.equal(f.tracker.hasRetry(sessionId, intentId), false);
          assert.ok(f.tracker.snapshot.every(operation => operation.retryAvailable !== true));
        }
        if (invalidation === "clear")
          assert.notEqual(f.changes.at(-1)?.retryAvailable, true);
        query.resolve(unknownOperation());
        view.resolve(freshHistory);
        await Promise.allSettled([pending]);
        assert.equal(held.joined, true);
        assert.equal(f.reads.length, 1);
        assert.equal(f.refreshes, boundary === "history" ? 1 : 0);
        assert.equal(f.prompts.length, 1);
        assert.equal(f.changes.length, previousChanges);
        if (invalidation === "close") assert.deepEqual(f.tracker.snapshot, []);
        if (invalidation === "clear" || invalidation === "close")
          assert.equal(f.tracker.hasRetry(sessionId, intentId), false);
        assert.equal(f.cancelled, 0);
      } finally { await f.cleanup(); }
    });
  }
}

for (const boundary of ["query", "history"] as const) {
  for (const outcome of ["success", "failure"] as const) {
    test(`an SSE receipt during ${boundary} wins over its late ${outcome} without another POST`, async () => {
      const f = fixture({ read: () => boundary === "query" ? query.wait() : unknownOperation(),
        refresh: () => view.wait() });
      const query = f.gate<unknown>(unknownOperation());
      const view = f.gate(freshHistory);
      const durable = receipt("completed");
      try {
        await f.seed();
        const pending = f.retry();
        await reached((boundary === "query" ? query : view).entered, pending);
        f.tracker.observe([durable]);
        const receiptIndex = f.changes.length - 1;
        if (outcome === "failure") {
          const cause = new Error("Stale read failed after durable receipt");
          if (boundary === "query") query.reject(cause);
          else view.reject(cause);
        } else {
          query.resolve(unknownOperation());
          view.resolve(freshHistory);
        }
        await pending;
        assert.deepEqual(operationWire(f.tracker.get(sessionId, intentId)), durable);
        assert.deepEqual(f.changes.slice(receiptIndex).map(operationWire), [durable]);
        assert.equal(f.tracker.hasRetry(sessionId, intentId), false);
        assert.equal(f.prompts.length, 1);
        assert.equal(f.refreshes, boundary === "history" ? 1 : 0);
        assert.equal((boundary === "query" ? query : view).joined, true);
      } finally { await f.cleanup(); }
    });
  }
}

for (const outcome of ["ACK", "failure"] as const) {
  test(`a durable SSE receipt also wins over a late retry POST ${outcome}`, async () => {
    const f = fixture({ prompt: call => call.action === "retry"
      ? post.wait() : acknowledgement(call.admission.intentId) });
    const post = f.gate(acknowledgement(intentId));
    const durable = receipt("completed");
    try {
      await f.seed();
      const pending = f.retry();
      await reached(post.entered, pending);
      f.tracker.observe([durable]);
      const receiptIndex = f.changes.length - 1;
      if (outcome === "ACK") post.resolve(acknowledgement(intentId));
      else post.reject(new WorkspaceApiError("Retry response lost", undefined,
        "workspace_network_error", "query_operation", intentId));
      await pending;
      assert.deepEqual(operationWire(f.tracker.get(sessionId, intentId)), durable);
      assert.deepEqual(f.changes.slice(receiptIndex).map(operationWire), [durable]);
      assert.equal(f.prompts.length, 2);
      assert.equal(post.joined, true);
      assert.equal(f.tracker.hasRetry(sessionId, intentId), false);
    } finally { await f.cleanup(); }
  });
}

test("retained input count is bounded to four and evicted inputs permit queries only", async () => {
  const f = fixture();
  const ids = Array.from({ length: 5 }, (_, index) => `intent-count-${index}`);
  try {
    for (const id of ids) await f.seed(admission(id));
    assert.equal(f.tracker.hasRetry(sessionId, ids[0]), false);
    assert.deepEqual(ids.slice(1).map(id => f.tracker.hasRetry(sessionId, id)), [true, true, true, true]);
    await f.retry(sessionId, ids[0]);
    assert.equal(f.prompts.length, 5);
    assert.equal(f.refreshes, 0);
    assert.deepEqual(f.reads.map(call => call.intentId), [ids[0]]);
    await f.retry(sessionId, ids[4]);
    assert.equal(f.prompts.length, 6);
    assert.equal(f.prompts[5].admission.intentId, ids[4]);
    assert.equal(f.prompts[5].action, "retry");
  } finally { await f.cleanup(); }
});

test("retained original bodies share a 64 MiB budget independently of their count", async () => {
  const f = fixture();
  const ids = ["intent-bytes-0", "intent-bytes-1", "intent-bytes-2"];
  const text = "x".repeat(24 * 1024 * 1024);
  try {
    for (const id of ids) await f.seed(admission(id, [{ type: "text", text }]));
    assert.equal(f.tracker.hasRetry(sessionId, ids[0]), false);
    assert.equal(f.tracker.hasRetry(sessionId, ids[1]), true);
    assert.equal(f.tracker.hasRetry(sessionId, ids[2]), true);
    await f.retry(sessionId, ids[0]);
    assert.equal(f.prompts.length, 3);
    assert.equal(f.refreshes, 0);
    assert.deepEqual(f.reads.map(call => call.intentId), [ids[0]]);
  } finally { await f.cleanup(); }
});

for (const phase of ["completed", "failed", "cancelled"] as const) {
  test(`a terminal ${phase} observation releases its original input capacity`, async () => {
    const f = fixture();
    const ids = Array.from({ length: 4 }, (_, index) => `intent-release-${index}`);
    try {
      for (const id of ids) await f.seed(admission(id));
      f.tracker.observe([receipt(phase, sessionId, ids[0])]);
      assert.equal(f.tracker.hasRetry(sessionId, ids[0]), false);
      await f.seed(admission("intent-after-terminal"));
      assert.equal(f.tracker.hasRetry(sessionId, "intent-after-terminal"), true);
      assert.deepEqual(ids.slice(1).map(id => f.tracker.hasRetry(sessionId, id)), [true, true, true]);
      assert.equal(f.prompts.length, 5);
      assert.equal(f.reads.length, 0);
    } finally { await f.cleanup(); }
  });
}

test("clearing inputs preserves operation observations and releases every retry body", async () => {
  const f = fixture();
  try {
    await f.seed();
    const before = f.tracker.snapshot.map(operationWire);
    assert.equal(f.tracker.snapshot[0].retryAvailable, true);
    const previousChanges = f.changes.length;
    f.tracker.clearRetryInputs();
    assert.equal(f.tracker.hasRetry(sessionId, intentId), false);
    assert.ok(f.tracker.snapshot.every(operation => operation.retryAvailable !== true));
    assert.ok(f.changes.length > previousChanges, "Clearing retry input must synchronously remove its UI capability");
    assert.notEqual(f.changes.at(-1)?.retryAvailable, true);
    assert.deepEqual(operationWire(f.changes.at(-1)), before[0]);
    assert.deepEqual(f.tracker.snapshot.map(operationWire), before);
    await f.retry();
    assert.equal(f.reads.length, 1);
    assert.equal(f.refreshes, 0);
    assert.equal(f.prompts.length, 1);
    assert.deepEqual(f.tracker.snapshot.map(operationWire), before);
    assert.ok(f.tracker.snapshot.every(operation => operation.retryAvailable !== true));
    assert.equal(f.cancelled, 0);
  } finally { await f.cleanup(); }
});

test("clearing inputs during original admission cannot resurrect them after its ACK", async () => {
  const f = fixture({ prompt: () => original.wait() });
  const original = f.gate(acknowledgement(intentId));
  const submitting = f.track(f.tracker.submit(sessionId, admission()));
  try {
    await reached(original.entered, submitting);
    f.tracker.clearRetryInputs();
    original.resolve(acknowledgement(intentId));
    await submitting;
    f.tracker.observe([unknownOperation()]);
    assert.equal(f.tracker.hasRetry(sessionId, intentId), false);
    assert.ok(f.tracker.snapshot.every(operation => operation.retryAvailable !== true));
    await f.retry();
    assert.equal(f.reads.length, 1);
    assert.equal(f.refreshes, 0);
    assert.equal(f.prompts.length, 1);
    assert.equal(original.joined, true);
  } finally { await f.cleanup(); }
});
