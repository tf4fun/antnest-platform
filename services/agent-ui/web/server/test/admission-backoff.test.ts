import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test, type TestContext } from "node:test";
import { RequestError } from "@agentclientprotocol/sdk";
import {
  AcpPromptError,
  AgentAccessRevokedError,
  type IntentReceipt,
} from "../src/adapters/acp-http.ts";
import { OperationConflictError, OperationCoordinator, operationFromReceipt } from "../src/bridge/operations.ts";

type Input = Parameters<OperationCoordinator["submit"]>[0];
type Observation = { kind: "unknown" } | { kind: "receipt"; receipt: IntentReceipt };
type Reader = (sessionId: string, intentId: string, signal?: AbortSignal) => Promise<Observation>;
const catalog = JSON.parse(readFileSync(
  new URL("../../../../../contracts/agent-acp/errors.json", import.meta.url), "utf8",
)) as { errors: Record<string, {
  json_rpc_code: number; message: string; retryable: boolean; retry_after_ms?: number;
}> };

function refusal(code = "agent_busy", delay?: number): AcpPromptError {
  const entry = catalog.errors[code]!;
  return new AcpPromptError(new RequestError(entry.json_rpc_code, entry.message, {
    code,
    retryable: entry.retryable,
    ...(delay === undefined && entry.retry_after_ms === undefined ? {} : {
      retry_after_ms: delay ?? entry.retry_after_ms,
    }),
  }), 1);
}

function originalInput(): Input {
  return {
    sessionId: "session-backoff",
    intentId: "intent-original",
    expectedAppendVersion: 7,
    prompt: [
      { type: "text", text: "Original ordered Prompt" },
      { type: "image", mimeType: "image/png", data: "b3JpZ2luYWwtaW1hZ2U=" },
      { type: "resource", resource: {
        uri: "file:///original.txt", mimeType: "text/plain", text: "Original attachment 原件",
      } },
    ],
  };
}

function receipt(phase: "running" | "completed" | "unknown" = "completed"): IntentReceipt {
  return {
    intentId: "intent-original", sessionId: "session-backoff", runId: "run-original",
    phase, appendVersion: 8, outputWatermark: 4,
    stopReason: phase === "completed" ? "end_turn" : null,
    errorClass: phase === "unknown" ? "tool_outcome_unknown" : null,
  };
}

function deferred<T>() {
  const gate = Promise.withResolvers<T>();
  void gate.promise.catch(() => {});
  return gate;
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

function fixture(t: TestContext, reader: Reader = async () => ({ kind: "unknown" })) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const original = originalInput();
  const calls: Array<{
    input: Input; startedAt: number; finished: boolean;
    resolve(value: unknown): void; reject(reason?: unknown): void; task: Promise<unknown>;
  }> = [];
  const queries: Array<{
    sessionId: string; intentId: string; signal: AbortSignal | undefined;
    finished: boolean; task: Promise<Observation>;
  }> = [];
  const events: string[] = [];
  const releases: Array<{ count: number }> = [];
  const decisions: Promise<unknown>[] = [];
  const cleanupReleases: Array<() => void> = [];
  let now = 0, active = 0, closing = false;
  const operations = new OperationCoordinator({
    now: () => now,
    prompt(input) {
      const gate = deferred<unknown>();
      const index = calls.length;
      const call = {
        input: structuredClone(input), startedAt: now, finished: false,
        resolve: gate.resolve, reject: gate.reject, task: gate.promise,
      };
      events.push(`prompt:${index}`);
      call.task = gate.promise.then(
        (value) => { call.finished = true; events.push(`settled:${index}`); return value; },
        (error: unknown) => { call.finished = true; events.push(`settled:${index}`); throw error; },
      );
      void call.task.catch(() => {});
      calls.push(call);
      if (closing) gate.resolve(undefined);
      return call.task;
    },
    readIntent(sessionId, intentId, signal) {
      const index = queries.length;
      events.push(`query:${index}`);
      const task = Promise.resolve().then(() => reader(sessionId, intentId, signal));
      const query = { sessionId, intentId, signal, finished: false, task };
      query.task = task.then(
        (value) => { query.finished = true; events.push(`queried:${index}`); return value; },
        (error: unknown) => { query.finished = true; events.push(`queried:${index}`); throw error; },
      );
      void query.task.catch(() => {});
      queries.push(query);
      return query.task;
    },
    cancel: async () => {},
    retainWork() {
      active++;
      const release = { count: 0 };
      releases.push(release);
      return () => { release.count++; active--; };
    },
  });
  const flush = async () => { await turn(); await turn(); };
  const advance = async (milliseconds: number) => {
    now += milliseconds;
    t.mock.timers.tick(milliseconds);
    await flush();
  };
  return {
    original, operations, calls, queries, events, flush, advance,
    active: () => active,
    onCleanup: (release: () => void) => { cleanupReleases.push(release); },
    track<T>(task: Promise<T>): Promise<T> {
      decisions.push(task);
      void task.catch(() => {});
      return task;
    },
    async start() {
      const request = structuredClone(original);
      const prepared = await operations.prepare(request);
      assert.deepEqual(operations.submitPrepared(prepared), {
        operationId: original.intentId, acceptance: "bridge", phase: "dispatching",
      });
      // A later caller draft mutation must not replace the prepared snapshot.
      request.expectedAppendVersion++;
      request.prompt.reverse();
      await flush();
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0]!.input, original);
    },
    retry() {
      const task = (async () => operations.retryPrepared(
        await operations.prepare(structuredClone(original)),
      ))();
      decisions.push(task);
      void task.catch(() => {});
      return task;
    },
    async close() {
      closing = true;
      operations.beginDrain();
      for (const release of cleanupReleases) release();
      for (const call of calls) call.resolve(undefined);
      // Failure-only fallback progress belongs to cleanup, never to a passing
      // timing assertion. Drain must already have stopped new dispatches.
      await advance(120000);
      await Promise.allSettled([
        ...decisions, operations.joinRetryDecisions(),
        operations.settled(original.sessionId, original.intentId),
        ...queries.map((query) => query.task), ...calls.map((call) => call.task),
      ]);
      assert(calls.every((call) => call.finished), "actual Prompt dependencies must join");
      assert(queries.every((query) => query.finished), "actual receipt queries must join");
      assert.equal(active, 0, "all retained work must be released after join");
      assert(releases.every((release) => release.count === 1), "work leases release exactly once");
    },
  };
}

type Fixture = ReturnType<typeof fixture>;

async function usingFixture(
  t: TestContext,
  reader: Reader | undefined,
  work: (f: Fixture) => Promise<void>,
): Promise<void> {
  const f = fixture(t, reader);
  const failures: unknown[] = [];
  try { await work(f); } catch (error) { failures.push(error); }
  try { await f.close(); } catch (error) { failures.push(error); }
  finally { t.mock.timers.reset(); }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "backoff behavior and cleanup failed");
}

async function finishWithReceipt(f: Fixture): Promise<void> {
  const accepted = receipt();
  f.operations.observeReceipts(f.original.sessionId, [accepted]);
  for (const call of f.calls) call.resolve(undefined);
  await f.operations.settled(f.original.sessionId, f.original.intentId);
  await f.flush();
  assert.deepEqual(f.operations.snapshot(f.original.sessionId, []), [operationFromReceipt(accepted)]);
  assert.equal(f.active(), 0);
}

test("canonical busy and not-ready retry only after actual settlement and an authorized unknown read", async (t) => {
  for (const code of ["agent_busy", "configuration_not_ready"]) {
    await usingFixture(t, undefined, async (f) => {
      const failure = refusal(code);
      assert.equal(failure.classification.kind, "admission");
      assert.equal(failure.classification.code, code);
      assert.equal(failure.classification.retryDirective, "backoff");
      await f.start();
      await f.advance(5000);
      assert.equal(f.calls.length, 1);
      assert.equal(f.queries.length, 0, "an unsettled Prompt cannot authorize automatic recovery");
      f.calls[0]!.reject(failure);
      await f.flush();
      assert.equal(f.calls[0]!.finished, true);
      assert(f.active() > 0, "the pending automatic chain must retain work after the failed call");
      await f.advance(999);
      assert.equal(f.calls.length, 1);
      await f.advance(1);
      assert.equal(f.calls.length, 2, "canonical refusal plus typed unknown must retry the original Prompt");
      assert(f.queries.length > 0);
      assert(f.queries.every((query) => query.finished));
      assert.deepEqual(f.queries.map(({ sessionId, intentId }) => [sessionId, intentId]),
        f.queries.map(() => [f.original.sessionId, f.original.intentId]));
      assert(f.events.indexOf("settled:0") < f.events.indexOf("query:0"));
      assert(f.events.indexOf("queried:0") < f.events.indexOf("prompt:1"));
      assert.deepEqual(f.calls.map((call) => call.input), [f.original, f.original]);
      assert.equal(f.calls[1]!.startedAt, 6000);
      await finishWithReceipt(f);
    });
  }
});

test("one original operation waits 1, 2 and 4 seconds and shares its four-dispatch limit with explicit retry", async (t) => {
  await usingFixture(t, undefined, async (f) => {
    await f.start();
    for (const [index, delay] of [1000, 2000, 4000].entries()) {
      f.calls[index]!.reject(refusal());
      await f.flush();
      await f.advance(delay - 1);
      assert.equal(f.calls.length, index + 1, "backoff floor must elapse before dispatch");
      await f.advance(1);
      assert.equal(f.calls.length, index + 2);
      assert.deepEqual(f.calls[index + 1]!.input, f.original);
    }
    assert.deepEqual(f.calls.map((call) => call.startedAt), [0, 1000, 3000, 7000]);
    f.calls[3]!.reject(refusal());
    await f.flush();
    await f.advance(60000);
    assert.equal(f.calls.length, 4, "automatic refusal cannot create a fifth dispatch");
    const explicit = f.retry();
    await f.flush();
    await Promise.allSettled([explicit]);
    await f.advance(60000);
    assert.equal(f.calls.length, 4, "an explicit action cannot reset the original dispatch budget");
    await f.operations.settled(f.original.sessionId, f.original.intentId);
    assert.equal(f.active(), 0);
  });
});

test("a valid 60-second wire delay cannot be shortened into the 30-second wait budget", async (t) => {
  await usingFixture(t, undefined, async (f) => {
    await f.start();
    const failure = refusal("agent_busy", 60000);
    assert.equal(failure.classification.retryAfterMs, 60000);
    f.calls[0]!.reject(failure);
    await f.flush();
    await f.advance(29999);
    assert.equal(f.calls.length, 1);
    await f.advance(1);
    assert.equal(f.calls.length, 1, "the wire delay must not be clamped to the remaining budget");
    await f.advance(30000);
    assert.equal(f.calls.length, 1, "an over-budget wait must stop rather than dispatch at 60 seconds");
    await f.operations.settled(f.original.sessionId, f.original.intentId);
    assert.equal(f.active(), 0);
  });
});

test("every durable receipt including unknown phase is adopted instead of automatically retried", async (t) => {
  for (const phase of ["running", "completed", "unknown"] as const) {
    const durable = receipt(phase);
    await usingFixture(t, async () => ({ kind: "receipt", receipt: durable }), async (f) => {
      await f.start();
      f.calls[0]!.reject(refusal());
      await f.flush();
      await f.advance(1000);
      assert(f.queries.length > 0, "the receipt must be obtained from the actual query dependency");
      await f.advance(60000);
      assert.equal(f.calls.length, 1);
      assert.deepEqual(f.operations.snapshot(f.original.sessionId, []), [operationFromReceipt(durable)]);
      await f.operations.settled(f.original.sessionId, f.original.intentId);
      assert.equal(f.active(), 0);
    });
  }
});

test("query failure, denied access and unknown delivery cannot authorize an automatic dispatch", async (t) => {
  for (const kind of ["query failure", "access denied", "unknown delivery"] as const) {
    const reader: Reader = kind === "query failure"
      ? async () => { throw new Error("fixture authorized lookup unavailable"); }
      : kind === "access denied"
        ? async () => { throw new AgentAccessRevokedError(); }
        : async () => ({ kind: "unknown" });
    await usingFixture(t, reader, async (f) => {
      await f.start();
      f.calls[0]!.reject(kind === "unknown delivery"
        ? new AcpPromptError(new Error("fixture original delivery is unknown"), 1)
        : refusal());
      await f.flush();
      for (const delay of [1000, 2000, 4000, 60000]) await f.advance(delay);
      assert.equal(f.calls.length, 1, kind);
      if (kind !== "unknown delivery") assert(f.queries.length > 0, "the failed lookup must actually execute");
      if (kind === "unknown delivery") {
        // Explicit recovery stays available, but cannot re-enable automation
        // for an original intent that once had an unknown delivery outcome.
        await f.retry();
        await f.flush();
        assert.equal(f.calls.length, 2);
        assert.deepEqual(f.calls[1]!.input, f.original);
        f.calls[1]!.reject(refusal());
        await f.flush();
        for (const delay of [1000, 2000, 4000, 60000]) await f.advance(delay);
        assert.equal(f.calls.length, 2, "later explicit refusal must not re-enable original automatic replay");
      }
      await f.operations.settled(f.original.sessionId, f.original.intentId);
      assert.equal(f.active(), 0);
    });
  }
});

test("a late durable receipt wins over a held unknown read or an outstanding backoff wait", async (t) => {
  for (const stage of ["query", "wait"] as const) {
    const held = deferred<Observation>();
    const reader: Reader = stage === "query" ? async () => held.promise : async () => ({ kind: "unknown" });
    await usingFixture(t, reader, async (f) => {
      f.onCleanup(() => held.resolve({ kind: "unknown" }));
      await f.start();
      f.calls[0]!.reject(refusal());
      await f.flush();
      await f.advance(stage === "query" ? 1000 : 999);
      if (stage === "query") {
        assert.equal(f.queries.length, 1);
        assert.equal(f.queries[0]!.finished, false);
      }
      const durable = receipt();
      f.operations.observeReceipts(f.original.sessionId, [durable]);
      held.resolve({ kind: "unknown" });
      await f.flush();
      for (const delay of [1, 1000, 2000, 4000, 60000]) await f.advance(delay);
      assert.equal(f.calls.length, 1);
      assert.deepEqual(f.operations.snapshot(f.original.sessionId, []), [operationFromReceipt(durable)]);
      await f.operations.settled(f.original.sessionId, f.original.intentId);
      assert(f.queries.every((query) => query.finished));
      assert.equal(f.active(), 0);
    });
  }
});

test("beginDrain stops a pending backoff timer and joins its retained work before returning", async (t) => {
  await usingFixture(t, undefined, async (f) => {
    await f.start();
    f.calls[0]!.reject(refusal());
    await f.flush();
    await f.advance(999);
    assert.equal(f.calls.length, 1);
    assert(f.active() > 0, "the pending wait must remain owned before drain");
    f.operations.beginDrain();
    await f.operations.joinRetryDecisions();
    await f.operations.settled(f.original.sessionId, f.original.intentId);
    assert.equal(f.active(), 0, "drain must actually join the cancelled wait");
    await f.advance(60000);
    assert.equal(f.calls.length, 1);
  });
});

test("beginDrain aborts a held automatic query but still waits for its actual settlement", async (t) => {
  const held = deferred<Observation>();
  await usingFixture(t, async () => held.promise, async (f) => {
    f.onCleanup(() => held.resolve({ kind: "unknown" }));
    await f.start();
    f.calls[0]!.reject(refusal());
    await f.flush();
    await f.advance(1000);
    assert.equal(f.queries.length, 1, "automatic recovery must enter the actual held query");
    assert.equal(f.queries[0]!.finished, false);
    assert(f.queries[0]!.signal instanceof AbortSignal);
    f.operations.beginDrain();
    assert.equal(f.queries[0]!.signal!.aborted, true);
    let joined = false;
    const joining = f.operations.joinRetryDecisions().then(() => { joined = true; });
    await f.flush();
    assert.equal(joined, false, "an abort event cannot stand in for actual query join");
    assert.equal(f.queries[0]!.finished, false);
    held.resolve({ kind: "unknown" });
    await joining;
    await f.operations.settled(f.original.sessionId, f.original.intentId);
    assert.equal(f.queries[0]!.finished, true);
    assert.equal(f.active(), 0);
    await f.advance(60000);
    assert.equal(f.calls.length, 1);
  });
});

test("explicit retries join a held automatic query and permit only one additional original dispatch", async (t) => {
  const held = deferred<Observation>();
  let reads = 0;
  await usingFixture(t, async () => {
    reads++;
    return reads === 1 ? held.promise : { kind: "unknown" };
  }, async (f) => {
    f.onCleanup(() => held.resolve({ kind: "unknown" }));
    await f.start();
    f.calls[0]!.reject(refusal());
    await f.flush();
    await f.advance(1000);
    assert.equal(f.queries.length, 1);
    assert.equal(f.queries[0]!.finished, false);
    const first = f.retry();
    const second = f.retry();
    let decisionsSettled = 0;
    void first.then(() => { decisionsSettled++; }, () => { decisionsSettled++; });
    void second.then(() => { decisionsSettled++; }, () => { decisionsSettled++; });
    await f.flush();
    assert.equal(f.queries.length, 1, "explicit actions must share the automatic query decision");
    assert.equal(f.calls.length, 1, "a click cannot dispatch while the automatic query is held");
    assert.equal(decisionsSettled, 0, "joining the decision must await its real held query");
    held.resolve({ kind: "unknown" });
    await f.flush();
    assert.equal(f.queries[0]!.finished, true);
    assert.equal(f.queries.length, 1);
    assert.equal(f.calls.length, 2);
    assert.equal(decisionsSettled, 2, "the joined Bridge decisions must not wait for the new held ACP call");
    await Promise.all([first, second]);
    assert.deepEqual(f.calls.map((call) => call.input), [f.original, f.original]);
    await finishWithReceipt(f);
    await f.advance(60000);
    assert.equal(f.calls.length, 2, "concurrent explicit actions cannot enqueue a later third dispatch");
  });
});

test("actual monotonic waiting beyond the remaining budget stops and an explicit action cannot refresh it", async (t) => {
  await usingFixture(t, undefined, async (f) => {
    await f.start();
    f.calls[0]!.reject(refusal("agent_busy", 10000));
    await f.flush();
    await f.advance(10000);
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[1]!.startedAt, 10000);
    assert.deepEqual(f.calls[1]!.input, f.original);
    f.calls[1]!.reject(refusal());
    await f.flush();
    // The next nominal delay is short, but its callback is not resumed until
    // 20,001 monotonic milliseconds have actually passed: total wait 30,001.
    await f.advance(20001);
    assert.equal(f.calls.length, 2, "elapsed waiting, not the requested timer delay, consumes the budget");
    assert.equal(f.active(), 0);
    await f.operations.settled(f.original.sessionId, f.original.intentId);
    const explicit = f.retry();
    let explicitSettled = false;
    void explicit.then(() => { explicitSettled = true; }, () => { explicitSettled = true; });
    await f.flush();
    assert.equal(f.calls.length, 2);
    assert.equal(explicitSettled, true, "an exhausted explicit decision remains query-only");
    await explicit;
    await f.advance(60000);
    assert.equal(f.calls.length, 2, "an explicit action cannot reset an exhausted elapsed-wait budget");
  });
});

test("cancel aborts a held automatic query and joins it even when no Run receipt exists", async (t) => {
  const held = deferred<Observation>();
  let reads = 0;
  await usingFixture(t, async () => {
    reads++;
    return reads === 1 ? held.promise : { kind: "unknown" };
  }, async (f) => {
    f.onCleanup(() => held.resolve({ kind: "unknown" }));
    await f.start();
    f.calls[0]!.reject(refusal());
    await f.flush();
    await f.advance(1000);
    assert.equal(f.queries.length, 1);
    assert.equal(f.queries[0]!.finished, false);
    assert(f.queries[0]!.signal instanceof AbortSignal);
    const cancelling = f.track(f.operations.cancel(
      f.original.sessionId, f.original.intentId, "run-not-observed",
    ));
    let completed = false;
    const outcome = f.track(cancelling.then(
      (value) => { completed = true; return { status: "fulfilled" as const, value }; },
      (reason: unknown) => { completed = true; return { status: "rejected" as const, reason }; },
    ));
    await f.flush();
    assert.equal(f.queries[0]!.signal!.aborted, true);
    assert.equal(f.queries[0]!.finished, false);
    assert.equal(completed, false, "cancel must not return on abort before its actual query joins");
    assert.equal(f.calls.length, 1);
    held.resolve({ kind: "unknown" });
    await f.flush();
    assert.equal(f.queries[0]!.finished, true);
    assert.equal(f.calls.length, 1);
    assert.equal(completed, true, "cancel must finish after the held query actually joins");
    const result = await outcome;
    assert.equal(result.status, "rejected", "no durable Run exists to cancel");
    if (result.status === "rejected") assert(result.reason instanceof OperationConflictError);
    assert.equal(f.queries[0]!.finished, true);
    await f.operations.settled(f.original.sessionId, f.original.intentId);
    assert.equal(f.active(), 0);
    await f.advance(60000);
    assert.equal(f.calls.length, 1, "cancelled automatic recovery must not dispatch a Prompt later");
  });
});

test("successive legal 20-second wire delays share one 30-second wait budget including explicit actions", async (t) => {
  await usingFixture(t, undefined, async (f) => {
    await f.start();
    f.calls[0]!.reject(refusal("configuration_not_ready", 20000));
    await f.flush();
    await f.advance(19999);
    assert.equal(f.calls.length, 1);
    await f.advance(1);
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[1]!.startedAt, 20000);
    assert.deepEqual(f.calls[1]!.input, f.original);
    f.calls[1]!.reject(refusal("configuration_not_ready", 20000));
    await f.flush();
    assert.equal(f.active(), 0, "the second wire delay cannot fit the remaining ten seconds");
    await f.operations.settled(f.original.sessionId, f.original.intentId);
    await f.advance(10000);
    assert.equal(f.calls.length, 2, "the remaining budget cannot shorten the second wire delay");
    await f.advance(10000);
    assert.equal(f.calls.length, 2, "a fresh twenty-second allowance must not be created for each refusal");
    const explicit = f.retry();
    let explicitSettled = false;
    void explicit.then(() => { explicitSettled = true; }, () => { explicitSettled = true; });
    await f.flush();
    assert.equal(f.calls.length, 2);
    assert.equal(explicitSettled, true, "exhaustion cannot enqueue an explicit wait");
    await explicit;
    await f.advance(60000);
    assert.equal(f.calls.length, 2, "explicit retry cannot bypass cumulative wire-delay exhaustion");
  });
});

for (const code of ["agent_busy", "configuration_not_ready"]) {
  test(`canonical ${code} without wire retry_after_ms never enters automatic admission`, async (t) => {
    await usingFixture(t, undefined, async (f) => {
      const definition = catalog.errors[code]!;
      const failure = new AcpPromptError(new RequestError(
        definition.json_rpc_code, definition.message,
        { code, retryable: definition.retryable },
      ), 1);
      // Classification remains compatible; an absent wire delay is not
      // permission to synthesize the catalog default for automatic dispatch.
      assert.equal(failure.classification.kind, "admission");
      assert.equal(failure.classification.code, code);
      assert.equal(failure.classification.retryAfterMs, undefined);
      await f.start();
      f.calls[0]!.reject(failure);
      const first = (await Promise.allSettled([f.calls[0]!.task]))[0]!;
      assert.equal(first.status, "rejected");
      if (first.status === "rejected") assert.equal(first.reason, failure);
      await f.flush();
      assert.equal(f.calls[0]!.finished, true);
      assert.equal(f.active(), 0, "missing wire delay must not retain an automatic wait");
      assert.equal(f.queries.length, 0);
      assert.equal(f.calls.length, 1);
      await f.advance(60000);
      assert.equal(f.queries.length, 0, "missing wire metadata cannot authorize an automatic intent query");
      assert.equal(f.calls.length, 1, "missing wire delay cannot authorize another Prompt");

      // Explicit recovery still queries and may dispatch the same settled
      // original input; this exception does not tighten the global classifier.
      const explicit = f.retry();
      await f.flush();
      assert.equal(f.queries.length, 1);
      assert.equal(f.queries[0]!.finished, true);
      assert.equal(f.calls.length, 2);
      assert.deepEqual(f.calls[1]!.input, f.original);
      await explicit;
      f.calls[1]!.reject(failure);
      await Promise.allSettled([f.calls[1]!.task]);
      await f.flush();
      assert.equal(f.active(), 0);
      await f.advance(60000);
      assert.equal(f.queries.length, 1);
      assert.equal(f.calls.length, 2);
      await f.operations.settled(f.original.sessionId, f.original.intentId);
    });
  });
}

for (const action of ["beginDrain", "cancel"] as const) {
  test(`a late automatic-query receipt is adopted after ${action} only after actual join`, async (t) => {
    const held = deferred<Observation>();
    const durable = receipt("completed");
    let reads = 0;
    await usingFixture(t, async () => {
      reads++;
      // A later control read cannot supply the receipt that this test expects
      // the original, already cancelled automatic query to preserve.
      return reads === 1 ? held.promise : { kind: "unknown" };
    }, async (f) => {
      f.onCleanup(() => held.resolve({ kind: "receipt", receipt: durable }));
      let resourcesTaken = 0, resourcesReleased = 0;
      const prepared = await f.operations.prepare(structuredClone(f.original));
      f.operations.submitPrepared(prepared, () => {
        resourcesTaken++;
        return () => { resourcesReleased++; };
      });
      await f.flush();
      assert.equal(resourcesTaken, 1);
      assert.equal(f.calls.length, 1);
      f.calls[0]!.reject(refusal());
      await f.flush();
      assert.equal(f.calls[0]!.finished, true);
      await f.advance(1000);
      assert.equal(f.queries.length, 1);
      assert.equal(f.queries[0]!.finished, false);

      let cancelFinished = false;
      const cancellation = action === "cancel" ? f.track(f.operations.cancel(
        f.original.sessionId, f.original.intentId, durable.runId,
      ).then(
        (value) => { cancelFinished = true; return { status: "fulfilled" as const, value }; },
        (reason: unknown) => { cancelFinished = true; return { status: "rejected" as const, reason }; },
      )) : undefined;
      if (action === "beginDrain") f.operations.beginDrain();
      let joined = false;
      const joining = f.track(f.operations.joinRetryDecisions().then(() => { joined = true; }));
      await f.flush();
      assert.equal(f.queries[0]!.signal?.aborted, true);
      assert.equal(f.queries[0]!.finished, false);
      assert.equal(joined, false, "an aborted signal must not stand in for the actual query result");
      if (cancellation) assert.equal(cancelFinished, false);
      assert(f.active() > 0);
      assert.equal(resourcesReleased, 0, "the original input lease must survive until the held query joins");
      assert.equal(f.calls.length, 1);

      held.resolve({ kind: "receipt", receipt: durable });
      await joining;
      if (cancellation) {
        const outcome = await cancellation;
        assert.equal(outcome.status, "rejected", "the late completed Run is no longer cancellable");
        if (outcome.status === "rejected") assert(outcome.reason instanceof OperationConflictError);
      }
      await f.operations.settled(f.original.sessionId, f.original.intentId);
      assert.equal(f.queries[0]!.finished, true);
      assert(f.queries.every((query) => query.finished));
      assert.deepEqual(f.operations.snapshot(f.original.sessionId, []), [operationFromReceipt(durable)]);
      assert.equal(resourcesReleased, 1);
      assert.equal(f.active(), 0);
      await f.advance(60000);
      assert.equal(f.calls.length, 1, "adopting a late receipt must never redispatch the original Prompt");
    });
  });
}

test("an observed completed receipt wins over an older running receipt returned by the held automatic query", async (t) => {
  const held = deferred<Observation>();
  const completed = receipt("completed");
  const older = receipt("running");
  await usingFixture(t, async () => held.promise, async (f) => {
    f.onCleanup(() => held.resolve({ kind: "receipt", receipt: older }));
    let resourcesReleased = 0;
    const prepared = await f.operations.prepare(structuredClone(f.original));
    f.operations.submitPrepared(prepared, () => () => { resourcesReleased++; });
    await f.flush();
    assert.equal(f.calls.length, 1);
    f.calls[0]!.reject(refusal());
    await f.flush();
    await f.advance(1000);
    assert.equal(f.queries.length, 1);
    assert.equal(f.queries[0]!.finished, false);
    f.operations.observeReceipts(f.original.sessionId, [completed]);
    await f.flush();
    assert.equal(f.queries[0]!.signal?.aborted, true);
    assert.equal(f.queries[0]!.finished, false);
    assert.deepEqual(f.operations.snapshot(f.original.sessionId, []), [operationFromReceipt(completed)]);
    assert(f.active() > 0);
    assert.equal(resourcesReleased, 0);
    held.resolve({ kind: "receipt", receipt: older });
    await f.operations.joinRetryDecisions();
    await f.operations.settled(f.original.sessionId, f.original.intentId);
    assert.equal(f.queries[0]!.finished, true);
    assert.deepEqual(f.operations.snapshot(f.original.sessionId, []), [operationFromReceipt(completed)]);
    assert.equal(resourcesReleased, 1);
    assert.equal(f.active(), 0);
    await f.advance(60000);
    assert.equal(f.calls.length, 1);
  });
});
