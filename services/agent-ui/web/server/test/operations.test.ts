import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { RequestError } from "@agentclientprotocol/sdk";
import { AcpPromptError, type IntentReceipt } from "../src/adapters/acp-http.ts";
import {
  OperationCoordinator,
  OperationConflictError,
  OperationReconciliationTimeoutError,
  operationFromReceipt,
} from "../src/bridge/operations.ts";

test("failed durable receipt preserves its public failure class", () => {
  assert.equal(operationFromReceipt({
    intentId: "intent-1", sessionId: "session-1", runId: "run-1",
    phase: "failed", appendVersion: 2, outputWatermark: 4,
    stopReason: null, errorClass: "model_unsupported_content",
  }).errorClass, "model_unsupported_content");
});

const prompt = [{ type: "text" as const, text: "continue" }];
const intent = {
  sessionId: "session-1",
  intentId: "intent-1",
  expectedAppendVersion: 2,
  prompt,
};

test("submission returns Bridge acceptance while ACP prompt continues independently", async () => {
  let finish!: () => void;
  const completion = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let dispatches = 0;
  let work = 0;
  const operations = new OperationCoordinator({
    prompt: async () => {
      dispatches += 1;
      await completion;
    },
    readIntent: () => Promise.resolve({ kind: "unknown" }),
    cancel: () => Promise.resolve(),
    retainWork: () => {
      work += 1;
      return () => {
        work -= 1;
      };
    },
  });
  assert.deepEqual(operations.submit(intent), {
    operationId: "intent-1",
    acceptance: "bridge",
    phase: "dispatching",
  });
  assert.equal(work, 1);
  await Promise.resolve();
  assert.equal(dispatches, 1);
  assert.deepEqual(await operations.read("session-1", "intent-1"), {
    operationId: "intent-1",
    sessionId: "session-1",
    acceptance: "bridge",
    phase: "dispatching",
  });
  finish();
  await operations.settled("session-1", "intent-1");
  assert.equal(work, 0);
});

test("same intent and canonical input joins once; changed input conflicts", async () => {
  let dispatches = 0;
  const reuse: string[] = [];
  const operations = new OperationCoordinator({
    prompt: () => {
      dispatches += 1;
      return Promise.resolve();
    },
    readIntent: () => Promise.resolve({ kind: "unknown" }),
    cancel: () => Promise.resolve(),
    retainWork: () => () => {},
    recordLocalIntentReuse: (outcome) => reuse.push(outcome),
  });
  operations.submit(intent);
  operations.submit({
    ...intent,
    prompt: [{ text: "continue", type: "text" }],
  });
  await operations.settled("session-1", "intent-1");
  assert.equal(dispatches, 1);
  assert.throws(
    () =>
      operations.submit({
        ...intent,
        prompt: [{ type: "text", text: "changed" }],
      }),
    OperationConflictError,
  );
  assert.deepEqual(reuse, ["hit", "conflict"]);
});

test("uncertain operation count and oldest age end when a receipt resolves it", async () => {
  let now = 1_000;
  const operations = new OperationCoordinator({
    prompt: () => Promise.resolve(),
    readIntent: () => Promise.resolve({ kind: "unknown" }),
    cancel: () => Promise.resolve(),
    retainWork: () => () => {},
    now: () => now,
  });
  operations.submit(intent);
  await operations.settled("session-1", "intent-1");
  now = 3_500;
  assert.deepEqual(operations.snapshotMetrics(), {
    uncertainOperations: 1, oldestUncertainMs: 2_500,
  });
  operations.observeReceipts("session-1", [{
    intentId: "intent-1", sessionId: "session-1", runId: "run-1",
    phase: "running", appendVersion: 3, outputWatermark: 0, stopReason: null, errorClass: null,
  }]);
  assert.deepEqual(operations.snapshotMetrics(), {
    uncertainOperations: 0, oldestUncertainMs: 0,
  });
});

test("read-only recovery after a Bridge restart uses the durable receipt without resubmission", async () => {
  let dispatches = 0;
  const operations = new OperationCoordinator({
    prompt: () => {
      dispatches += 1;
      return Promise.resolve();
    },
    readIntent: () =>
      Promise.resolve({
        kind: "receipt" as const,
        receipt: {
          intentId: "intent-1",
          sessionId: "session-1",
          runId: "run-1",
          phase: "completed" as const,
          appendVersion: 3,
          outputWatermark: 8,
          stopReason: "end_turn",
          errorClass: null,
        },
      }),
    cancel: () => Promise.resolve(),
    retainWork: () => () => {},
  });
  assert.deepEqual(await operations.read("session-1", "intent-1"), {
    operationId: "intent-1",
    sessionId: "session-1",
    acceptance: "acp",
    phase: "completed",
    runId: "run-1",
    outputWatermark: 8,
    stopReason: "end_turn",
    errorClass: null,
  });
  assert.equal(dispatches, 0);
});

test("an absent receipt after a possible dispatch stays uncertain", async () => {
  const operations = new OperationCoordinator({
    prompt: () => Promise.resolve(),
    readIntent: () => Promise.resolve({ kind: "unknown" }),
    cancel: () => Promise.resolve(),
    retainWork: () => () => {},
  });
  assert.deepEqual(await operations.read("session-1", "unknown-intent"), {
    operationId: "unknown-intent",
    sessionId: "session-1",
    acceptance: "unknown",
    phase: "uncertain",
  });
});

test("cancellation refuses a stale Run ID and only targets the durable matching Run", async () => {
  const cancelled: string[] = [];
  const operations = new OperationCoordinator({
    prompt: () => Promise.resolve(),
    readIntent: () =>
      Promise.resolve({
        kind: "receipt" as const,
        receipt: {
          intentId: "intent-1",
          sessionId: "session-1",
          runId: "run-1",
          phase: "running" as const,
          appendVersion: 3,
          outputWatermark: 1,
          stopReason: null, errorClass: null,
        },
      }),
    cancel: async (_sessionId, runId) => {
      cancelled.push(runId);
    },
    retainWork: () => () => {},
  });
  await assert.rejects(
    operations.cancel("session-1", "intent-1", "run-old"),
    OperationConflictError,
  );
  assert.deepEqual(cancelled, []);
  await operations.cancel("session-1", "intent-1", "run-1");
  assert.deepEqual(cancelled, ["run-1"]);
});

test("a late cancellation response cannot replace an observed terminal receipt", async () => {
  let finishCancel!: () => void;
  let cancelStarted!: () => void;
  const started = new Promise<void>((resolve) => { cancelStarted = resolve; });
  const cancelling = new Promise<void>((resolve) => { finishCancel = resolve; });
  const running = {
    intentId: "intent-1", sessionId: "session-1", runId: "run-1",
    phase: "running" as const, appendVersion: 3, outputWatermark: 1,
    stopReason: null, errorClass: null,
  };
  const completed = { ...running, phase: "completed" as const,
    outputWatermark: 2, stopReason: "end_turn", errorClass: null };
  const operations = new OperationCoordinator({
    prompt: () => Promise.resolve(),
    readIntent: () => Promise.resolve({ kind: "receipt" as const, receipt: running }),
    cancel: () => { cancelStarted(); return cancelling; },
    retainWork: () => () => {},
  });
  operations.submit(intent);
  operations.observeReceipts("session-1", [running]);
  const pending = operations.cancel("session-1", "intent-1", "run-1");
  await started;
  operations.observeReceipts("session-1", [completed]);
  finishCancel();
  assert.equal((await pending).phase, "completed");
  assert.equal(operations.snapshot("session-1", [])[0]?.phase, "completed");
  await operations.settled("session-1", "intent-1");
});

test("a recovered operation rereads its durable outcome after cancellation", async () => {
  let finishCancel!: () => void;
  let cancelStarted!: () => void;
  const started = new Promise<void>((resolve) => { cancelStarted = resolve; });
  const cancelling = new Promise<void>((resolve) => { finishCancel = resolve; });
  let phase: "running" | "completed" = "running";
  let reads = 0;
  const operations = new OperationCoordinator({
    prompt: () => Promise.resolve(),
    readIntent: () => {
      reads++;
      return Promise.resolve({ kind: "receipt" as const, receipt: {
        intentId: "intent-1", sessionId: "session-1", runId: "run-1",
        phase, appendVersion: 3, outputWatermark: phase === "running" ? 1 : 2,
        stopReason: phase === "running" ? null : "end_turn", errorClass: null,
      } });
    },
    cancel: () => { cancelStarted(); return cancelling; },
    retainWork: () => () => {},
  });
  const pending = operations.cancel("session-1", "intent-1", "run-1");
  await started;
  phase = "completed";
  finishCancel();
  assert.equal((await pending).phase, "completed");
  assert.equal(reads, 2);
});

test("terminal reconciliation releases a work hold once after prompt completion", async () => {
  let releases = 0;
  const operations = new OperationCoordinator({
    prompt: () => Promise.resolve(),
    readIntent: () =>
      Promise.resolve({
        kind: "receipt" as const,
        receipt: {
          intentId: "intent-1",
          sessionId: "session-1",
          runId: "run-1",
          phase: "completed" as const,
          appendVersion: 3,
          outputWatermark: 2,
          stopReason: "end_turn", errorClass: null,
        },
      }),
    cancel: () => Promise.resolve(),
    retainWork: () => () => {
      releases += 1;
    },
  });
  operations.submit(intent);
  await operations.settled("session-1", "intent-1");
  await operations.read("session-1", "intent-1");
  await operations.read("session-1", "intent-1");
  assert.equal(releases, 1);
});

test("local acceptance appears in the View until a durable receipt supersedes it", async () => {
  let finish!: () => void;
  const completion = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const changed: string[] = [];
  const operations = new OperationCoordinator({
    prompt: () => completion,
    readIntent: () => Promise.resolve({ kind: "unknown" }),
    cancel: () => Promise.resolve(),
    retainWork: () => () => {},
    changed: (sessionId) => changed.push(sessionId),
  });
  operations.submit(intent);
  assert.deepEqual(operations.snapshot("session-1", []), [
    {
      operationId: "intent-1",
      sessionId: "session-1",
      acceptance: "bridge",
      phase: "dispatching",
    },
  ]);
  assert.deepEqual(operations.snapshot("session-2", []), []);
  const receipt = {
    intentId: "intent-1",
    sessionId: "session-1",
    runId: "run-1",
    phase: "running" as const,
    appendVersion: 3,
    outputWatermark: 1,
    stopReason: null, errorClass: null,
  };
  assert.equal(
    operations.snapshot("session-1", [receipt])[0]?.acceptance,
    "acp",
  );
  assert.deepEqual(changed, ["session-1"]);
  finish();
  await operations.settled("session-1", "intent-1");
});

test("a failed prompt transport remains uncertain without pinning the owner forever", async () => {
  let held = 0;
  const operations = new OperationCoordinator({
    prompt: async () => {
      throw new Error("connection lost after dispatch");
    },
    readIntent: async () => ({ kind: "unknown" }),
    cancel: async () => {},
    retainWork: () => {
      held += 1;
      return () => {
        held -= 1;
      };
    },
  });
  operations.submit(intent);
  await operations.settled("session-1", "intent-1");
  assert.equal(held, 0);
  assert.deepEqual(operations.trackedSessionIds(), ["session-1"]);
  assert.deepEqual(operations.snapshot("session-1", []), [
    {
      operationId: "intent-1",
      sessionId: "session-1",
      acceptance: "unknown",
      phase: "uncertain",
    },
  ]);
  assert.equal(
    (await operations.read("session-1", "intent-1")).phase,
    "uncertain",
  );
});

test("receipt-window reconciliation checks every missing intent with bounded concurrency", async () => {
  const queried: string[] = [];
  let active = 0;
  let peak = 0;
  const operations = new OperationCoordinator({
    prompt: () => new Promise(() => {}),
    readIntent: async (_sessionId, intentId) => {
      queried.push(intentId);
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      return { kind: "unknown" as const };
    },
    cancel: async () => {},
    retainWork: () => () => {},
  });
  for (let index = 0; index < 10; index += 1)
    operations.submit({ ...intent, intentId: `intent-${index}` });
  await operations.reconcileMissing("session-1", []);
  assert.deepEqual(queried, Array.from({ length: 10 }, (_, index) => `intent-${index}`));
  assert.equal(peak, 8);
});

test("slow receipt reconciliation stops within its deadline without changing the operation", async () => {
  let cancelled = false;
  const operations = new OperationCoordinator({
    prompt: () => new Promise(() => {}),
    readIntent: (_sessionId, _intentId, signal) => new Promise((_, reject) => {
      signal?.addEventListener("abort", () => {
        cancelled = true;
        reject(signal.reason);
      }, { once: true });
    }),
    cancel: async () => {},
    retainWork: () => () => {},
    reconcileTimeoutMs: 20,
  });
  operations.submit(intent);
  await assert.rejects(
    operations.reconcileMissing("session-1", []),
    OperationReconciliationTimeoutError,
  );
  assert.equal(cancelled, true);
  assert.equal(operations.snapshot("session-1", [])[0]?.phase, "dispatching");
});

test("reconciliation deadline also bounds a non-cooperative receipt adapter", async () => {
  const operations = new OperationCoordinator({
    prompt: () => new Promise(() => {}),
    readIntent: () => new Promise(() => {}),
    cancel: async () => {},
    retainWork: () => () => {},
    reconcileTimeoutMs: 20,
  });
  operations.submit(intent);
  await assert.rejects(
    operations.reconcileMissing("session-1", []),
    OperationReconciliationTimeoutError,
  );
});

const promptErrorCatalog = JSON.parse(readFileSync(
  new URL("../../../../../contracts/agent-acp/errors.json", import.meta.url), "utf8",
)) as {
  errors: Record<string, { json_rpc_code: number; message: string; retryable: boolean; retry_after_ms?: number }>;
  terminal_outcomes: Record<string, { json_rpc_code: number; message: string }>;
  fallback: { data_code: string; message: string };
};
const privatePromptCause = "PRIVATE-PROMPT-OPERATION-CAUSE";
type PromptPublicError = {
  code: string;
  message: string;
  requestId: string;
  operationId: string;
  retryable: false;
  recovery: "query_operation";
};

function promptFailure(code = "agent_busy"): AcpPromptError {
  const entry = promptErrorCatalog.errors[code]!;
  const cause = Object.assign(new RequestError(entry.json_rpc_code, entry.message, {
    code,
    retryable: entry.retryable,
    ...(entry.retry_after_ms === undefined ? {} : { retry_after_ms: entry.retry_after_ms }),
  }), { privateDiagnostic: privatePromptCause });
  return new AcpPromptError(cause, 1);
}

function promptPublicError(value: unknown): PromptPublicError {
  const error = (value as { error?: PromptPublicError }).error;
  assert.ok(error, "Prompt rejection must expose a safe operation error");
  assert.equal(typeof error.requestId, "string");
  assert(error.requestId.length > 0 && error.requestId.length <= 200);
  assert.notEqual(error.requestId, intent.intentId, "Bridge error correlation reused the intent identity");
  return error;
}

const promptFailureCases = [
  ...["agent_busy", "access_denied", "runtime_barrier_required", "database_error",
    "idempotency_conflict", "intent_already_recorded"].map((code) => ({
    name: code, failure: promptFailure(code), code, message: promptErrorCatalog.errors[code]!.message,
  })),
  ...Object.entries(promptErrorCatalog.terminal_outcomes).map(([name, terminal]) => ({
    name: "terminal " + name,
    failure: new AcpPromptError(Object.assign(new RequestError(terminal.json_rpc_code, terminal.message, {
      code: "model_unsupported_content", retryable: false,
    }), { privateDiagnostic: privatePromptCause }), 1),
    code: "model_unsupported_content", message: terminal.message,
  })),
  {
    name: "unknown private transport failure",
    failure: new AcpPromptError(new Error(privatePromptCause), 1),
    code: promptErrorCatalog.fallback.data_code, message: promptErrorCatalog.fallback.message,
  },
  {
    name: "missing producer error capability",
    failure: new AcpPromptError(promptFailure().cause, null),
    code: promptErrorCatalog.fallback.data_code, message: promptErrorCatalog.fallback.message,
  },
];

for (const { name, failure, code, message } of promptFailureCases)
  test(`Prompt ${name} remains one original uncertain intent with a stable safe error across unknown reads`, async () => {
    const dispatched: unknown[] = [], queried: string[][] = [];
    let work = 0, releases = 0;
    const operations = new OperationCoordinator({
      prompt: (input) => {
        dispatched.push(structuredClone(input));
        return Promise.reject(failure);
      },
      readIntent: (sessionId, intentId) => {
        queried.push([sessionId, intentId]);
        return Promise.resolve({ kind: "unknown" });
      },
      cancel: () => Promise.resolve(),
      retainWork: () => {
        work++;
        return () => { work--; releases++; };
      },
    });
    operations.submit(intent);
    await operations.settled(intent.sessionId, intent.intentId);
    const snapshot = operations.snapshot(intent.sessionId, [])[0];
    const error = promptPublicError(snapshot);
    const expected = {
      operationId: intent.intentId, sessionId: intent.sessionId,
      acceptance: "unknown", phase: "uncertain",
      error: {
        code, message, requestId: error.requestId, operationId: intent.intentId,
        retryable: false, recovery: "query_operation",
      },
    };
    assert.deepEqual(snapshot, expected);
    for (let read = 0; read < 3; read++) {
      const actual = await operations.read(intent.sessionId, intent.intentId);
      assert.deepEqual(actual, expected, "an unknown receipt changed the original error or invented a Run");
      assert.equal(promptPublicError(actual).requestId, error.requestId);
    }
    assert.deepEqual(queried, Array.from({ length: 3 }, () => [intent.sessionId, intent.intentId]));
    operations.submit({ ...intent, prompt: structuredClone(prompt) });
    await operations.settled(intent.sessionId, intent.intentId);
    assert.deepEqual(operations.snapshot(intent.sessionId, []), [expected]);
    assert.deepEqual(dispatched, [intent], "Prompt classification or same-intent reuse replayed execution");
    assert.equal(work, 0);
    assert.equal(releases, 1);
    assert(!JSON.stringify({ snapshot, operations: operations.snapshot(intent.sessionId, []) }).includes(privatePromptCause),
      "private Prompt cause entered the public operation JSON");
  });

function recoveredPromptReceipt(phase: "running" | "completed"): IntentReceipt {
  return {
    intentId: intent.intentId, sessionId: intent.sessionId, runId: "run-1", phase,
    appendVersion: intent.expectedAppendVersion + 1,
    outputWatermark: phase === "completed" ? 8 : 1,
    stopReason: phase === "completed" ? "end_turn" : null,
    errorClass: null,
  };
}

function recoveredPromptOperation(receipt: IntentReceipt) {
  return {
    operationId: receipt.intentId, sessionId: receipt.sessionId,
    acceptance: "acp", phase: receipt.phase, runId: receipt.runId,
    outputWatermark: receipt.outputWatermark, stopReason: receipt.stopReason, errorClass: receipt.errorClass,
  };
}

for (const phase of ["running", "completed"] as const)
  test(`a durable ${phase} receipt wins over a late classified Prompt rejection`, async () => {
    const entered = Promise.withResolvers<void>(), completion = Promise.withResolvers<unknown>();
    const receipt = recoveredPromptReceipt(phase), expected = recoveredPromptOperation(receipt);
    let dispatches = 0, releases = 0;
    const operations = new OperationCoordinator({
      prompt: () => { dispatches++; entered.resolve(); return completion.promise; },
      readIntent: () => Promise.resolve({ kind: "receipt", receipt }),
      cancel: () => Promise.resolve(),
      retainWork: () => () => { releases++; },
    });
    operations.submit(intent);
    try {
      await entered.promise;
      if (phase === "running") operations.observeReceipts(intent.sessionId, [receipt]);
      else assert.deepEqual(await operations.read(intent.sessionId, intent.intentId), expected);
      assert.deepEqual(operations.snapshot(intent.sessionId, []), [expected]);
    } finally {
      completion.reject(promptFailure("database_error"));
      await operations.settled(intent.sessionId, intent.intentId);
    }
    assert.deepEqual(operations.snapshot(intent.sessionId, []), [expected]);
    assert.equal(Object.hasOwn(operations.snapshot(intent.sessionId, [])[0]!, "error"), false);
    assert.deepEqual(await operations.read(intent.sessionId, intent.intentId), expected);
    assert.equal(dispatches, 1);
    assert.equal(releases, 1);
  });

for (const phase of ["running", "completed"] as const)
  test(`a later durable ${phase} receipt clears the original classified Prompt error without replay`, async () => {
    const receipt = recoveredPromptReceipt(phase), expected = recoveredPromptOperation(receipt);
    let durable: IntentReceipt | undefined, dispatches = 0, releases = 0;
    const queried: string[][] = [];
    const operations = new OperationCoordinator({
      prompt: () => { dispatches++; return Promise.reject(promptFailure()); },
      readIntent: (sessionId, intentId) => {
        queried.push([sessionId, intentId]);
        return Promise.resolve(durable === undefined ? { kind: "unknown" } : { kind: "receipt", receipt: durable });
      },
      cancel: () => Promise.resolve(),
      retainWork: () => () => { releases++; },
    });
    operations.submit(intent);
    await operations.settled(intent.sessionId, intent.intentId);
    const first = await operations.read(intent.sessionId, intent.intentId);
    promptPublicError(first);
    assert.equal(first.acceptance, "unknown");
    assert.equal(first.phase, "uncertain");
    if (phase === "running") {
      operations.observeReceipts(intent.sessionId, [receipt]);
      assert.deepEqual(operations.snapshot(intent.sessionId, []), [expected]);
    }
    durable = receipt;
    assert.deepEqual(await operations.read(intent.sessionId, intent.intentId), expected);
    assert.deepEqual(operations.snapshot(intent.sessionId, []), [expected]);
    assert.equal(Object.hasOwn(operations.snapshot(intent.sessionId, [])[0]!, "error"), false);
    assert.deepEqual(queried, [[intent.sessionId, intent.intentId], [intent.sessionId, intent.intentId]]);
    operations.submit(structuredClone(intent));
    await operations.settled(intent.sessionId, intent.intentId);
    assert.equal(dispatches, 1);
    assert.equal(releases, 1);
    assert.deepEqual(operations.snapshot(intent.sessionId, []), [expected]);
  });

for (const phase of ["running", "completed"] as const)
  test(`an unknown intent read after a late Prompt rejection cannot erase a proven durable ${phase} Run`, async () => {
    const entered = Promise.withResolvers<void>(), completion = Promise.withResolvers<unknown>();
    const receipt = recoveredPromptReceipt(phase), expected = recoveredPromptOperation(receipt);
    const queried: string[][] = [];
    let dispatches = 0, releases = 0;
    const operations = new OperationCoordinator({
      prompt: () => { dispatches++; entered.resolve(); return completion.promise; },
      readIntent: (sessionId, intentId) => {
        queried.push([sessionId, intentId]);
        return Promise.resolve({ kind: "unknown" });
      },
      cancel: () => Promise.resolve(),
      retainWork: () => () => { releases++; },
    });
    operations.submit(intent);
    try {
      await entered.promise;
      operations.observeReceipts(intent.sessionId, [receipt]);
      assert.deepEqual(operations.snapshot(intent.sessionId, []), [expected]);
    } finally {
      completion.reject(promptFailure("database_error"));
      await operations.settled(intent.sessionId, intent.intentId);
    }
    assert.deepEqual(operations.snapshot(intent.sessionId, []), [expected]);
    for (let read = 0; read < 2; read++) {
      const result = await operations.read(intent.sessionId, intent.intentId);
      assert.deepEqual(result, expected, "an unknown read erased an already proven Run receipt");
      assert.equal(Object.hasOwn(result, "error"), false);
    }
    assert.deepEqual(operations.snapshot(intent.sessionId, []), [expected]);
    assert.deepEqual(queried, [[intent.sessionId, intent.intentId], [intent.sessionId, intent.intentId]]);
    assert.equal(dispatches, 1);
    assert.equal(releases, 1);
  });

type RetryInput = Parameters<OperationCoordinator["submit"]>[0];
type RetryPrepared = Awaited<ReturnType<OperationCoordinator["prepare"]>>;
type RetryObservation = { kind: "unknown" } | { kind: "receipt"; receipt: IntentReceipt };
type RetryReader = (sessionId: string, intentId: string, signal?: AbortSignal) => Promise<RetryObservation>;

function retryOriginal(): RetryInput {
  return {
    ...intent,
    prompt: [
      { type: "text", text: "Original ordered Prompt" },
      { type: "image", mimeType: "image/png", data: "b3JpZ2luYWwtaW1hZ2U=" },
      { type: "resource", resource: {
        uri: "file:///original.txt", mimeType: "text/plain", text: "Original attachment 原件",
      } },
    ],
  };
}

const retryTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
const retryAck = { operationId: intent.intentId, acceptance: "bridge", phase: "dispatching" } as const;

async function retryBounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Retry test operation did not settle")), 2_000);
    })]);
  } finally { clearTimeout(timer); }
}

async function retryProgress(started: Promise<void>, decision: Promise<unknown>): Promise<"query" | "decision"> {
  return retryBounded(Promise.race([
    started.then(() => "query" as const),
    decision.then(() => "decision" as const, () => "decision" as const),
  ]));
}

function retryFixture(reader: RetryReader = async () => ({ kind: "unknown" })) {
  const input = retryOriginal();
  const calls: Array<{
    input: RetryInput; complete(value: unknown): void; reject(reason?: unknown): void;
    task: Promise<unknown>; finished: boolean; activeWhenStarted: number;
  }> = [];
  const queries: Array<{
    sessionId: string; intentId: string; signal: AbortSignal | undefined;
    task: Promise<RetryObservation>; finished: boolean;
  }> = [];
  const decisions: Promise<unknown>[] = [];
  const leases: Array<{ releases: number }> = [];
  const events: string[] = [];
  let active = 0, closing = false;
  const operations = new OperationCoordinator({
    prompt(value) {
      const gate = Promise.withResolvers<unknown>();
      const call = {
        input: structuredClone(value), complete: gate.resolve, reject: gate.reject,
        task: gate.promise, finished: false, activeWhenStarted: active,
      };
      call.task = gate.promise.then(
        (result) => { call.finished = true; return result; },
        (reason: unknown) => { call.finished = true; throw reason; },
      );
      void call.task.catch(() => {});
      calls.push(call);
      events.push(`prompt:${value.intentId}`);
      if (closing) gate.resolve(undefined);
      return call.task;
    },
    readIntent(sessionId, intentId, signal) {
      const execution = Promise.resolve().then(() => reader(sessionId, intentId, signal));
      const query = { sessionId, intentId, signal, task: execution, finished: false };
      query.task = execution.then(
        (result) => { query.finished = true; return result; },
        (reason: unknown) => { query.finished = true; throw reason; },
      );
      void query.task.catch(() => {});
      queries.push(query);
      events.push(`query:${intentId}`);
      return query.task;
    },
    cancel: async () => {},
    retainWork() {
      const lease = { releases: 0 };
      leases.push(lease);
      active++;
      return () => { lease.releases++; active--; };
    },
  });
  return {
    input, operations, calls, queries, leases, events, active: () => active,
    retry(prepared: RetryPrepared) {
      const decision = operations.retryPrepared(prepared);
      decisions.push(decision);
      void decision.catch(() => {});
      return decision;
    },
    async close() {
      closing = true;
      for (const call of calls) call.complete(undefined);
      await Promise.allSettled(decisions);
      await Promise.allSettled(queries.map((query) => query.task));
      for (const call of calls) call.complete(undefined);
      await Promise.allSettled(calls.map((call) => call.task));
      await Promise.allSettled(calls.map((call) =>
        operations.settled(call.input.sessionId, call.input.intentId)));
      assert(calls.every((call) => call.finished), "Every actual ACP call must finish during cleanup");
      assert(queries.every((query) => query.finished), "Every actual intent query must finish during cleanup");
      assert.equal(active, 0, "Retry tests must release all retained work");
      assert(leases.every((lease) => lease.releases === 1), "Every work lease must be released exactly once");
    },
  };
}

type RetryFixture = ReturnType<typeof retryFixture>;

async function startRetryOriginal(fixture: RetryFixture): Promise<void> {
  fixture.operations.submit(structuredClone(fixture.input));
  await retryTurn();
  assert.equal(fixture.calls.length, 1);
}

async function settleRetryOriginal(fixture: RetryFixture): Promise<void> {
  await startRetryOriginal(fixture);
  fixture.calls[0]!.reject(promptFailure());
  await retryBounded(fixture.operations.settled(fixture.input.sessionId, fixture.input.intentId));
  assert.equal(fixture.active(), 0);
}

test("retryPrepared queries and redispatches only the same settled original Prompt while its state stays uncertain", async () => {
  const f = retryFixture();
  try {
    await settleRetryOriginal(f);
    f.operations.submit(structuredClone(f.input));
    await f.operations.settled(f.input.sessionId, f.input.intentId);
    assert.equal(f.calls.length, 1, "Ordinary duplicate submit must retain local deduplication");
    assert.equal(f.queries.length, 0);
    const request = structuredClone(f.input);
    const prepared = await f.operations.prepare(request);
    request.prompt.reverse();
    request.expectedAppendVersion++;
    assert.deepEqual(await retryBounded(f.retry(prepared)), retryAck);
    await retryTurn();
    assert.deepEqual(f.queries.map(({ sessionId, intentId }) => [sessionId, intentId]),
      [[f.input.sessionId, f.input.intentId]]);
    assert.deepEqual(f.calls.map((call) => call.input), [f.input, f.input]);
    assert.deepEqual(f.events, [`prompt:${f.input.intentId}`, `query:${f.input.intentId}`, `prompt:${f.input.intentId}`]);
    const uncertain = f.operations.snapshot(f.input.sessionId, [])[0]!;
    assert.equal(uncertain.acceptance, "unknown");
    assert.equal(uncertain.phase, "uncertain");
    assert.equal(uncertain.runId, undefined);
    assert(f.active() >= 1);
    assert(f.leases.length >= 2, "The second actual dispatch must retain work again");
    assert(f.calls.every((call) => call.activeWhenStarted >= 1));
    let finished = false;
    const currentSettlement = f.operations.settled(f.input.sessionId, f.input.intentId)
      .then(() => { finished = true; });
    await retryTurn();
    assert.equal(finished, false, "settled must refer to the second actual ACP call");
    f.calls[1]!.complete({ stopReason: "end_turn" });
    await retryBounded(currentSettlement);
    assert.equal(f.active(), 0);
    assert.equal(f.operations.snapshot(f.input.sessionId, [])[0]!.phase, "uncertain");
    const receipt = recoveredPromptReceipt("completed");
    f.operations.observeReceipts(f.input.sessionId, [receipt]);
    assert.deepEqual(f.operations.snapshot(f.input.sessionId, []), [operationFromReceipt(receipt)]);
    f.operations.submit(structuredClone(f.input));
    await retryTurn();
    assert.equal(f.calls.length, 2);
  } finally { await f.close(); }
});

for (const change of ["append CAS", "attachment content", "content order"] as const) {
  test(`retryPrepared rejects changed ${change} before any query or redispatch`, async () => {
    const f = retryFixture();
    try {
      await settleRetryOriginal(f);
      const changed = structuredClone(f.input);
      if (change === "append CAS") changed.expectedAppendVersion++;
      else if (change === "attachment content") changed.prompt[1] = {
        type: "image", mimeType: "image/png", data: "Y2hhbmdlZC1pbWFnZQ==",
      };
      else changed.prompt.reverse();
      const prepared = await f.operations.prepare(changed);
      await assert.rejects(f.retry(prepared), OperationConflictError);
      assert.equal(f.queries.length, 0);
      assert.equal(f.calls.length, 1);
    } finally { await f.close(); }
  });
}

for (const phase of ["persisting", "accepted", "running", "awaiting_permission", "cancelling",
  "completed", "failed", "cancelled", "unknown"] as const) {
  test(`retryPrepared adopts an existing durable ${phase} receipt without another Prompt`, async () => {
    const receipt: IntentReceipt = { ...recoveredPromptReceipt("running"), phase };
    const f = retryFixture(async () => ({ kind: "receipt", receipt }));
    try {
      await settleRetryOriginal(f);
      assert.deepEqual(await retryBounded(f.retry(await f.operations.prepare(f.input))), retryAck);
      assert.equal(f.queries.length, 1);
      assert.equal(f.calls.length, 1);
      assert.deepEqual(f.operations.snapshot(f.input.sessionId, []), [operationFromReceipt(receipt)]);
      if (phase === "unknown") {
        assert.equal(f.operations.snapshot(f.input.sessionId, [])[0]!.acceptance, "acp");
        assert.equal(f.operations.snapshot(f.input.sessionId, [])[0]!.phase, "uncertain");
      }
    } finally { await f.close(); }
  });
}

for (const observation of ["unknown", "receipt"] as const) {
  test(`retryPrepared with no local original entry only queries the ${observation} result`, async () => {
    const f = retryFixture(async () => observation === "unknown" ? { kind: "unknown" }
      : { kind: "receipt", receipt: recoveredPromptReceipt("completed") });
    try {
      assert.deepEqual(await retryBounded(f.retry(await f.operations.prepare(f.input))), retryAck);
      await retryTurn();
      assert.equal(f.queries.length, 1);
      assert.equal(f.calls.length, 0, "Missing local settlement evidence must never become ordinary submit");
    } finally { await f.close(); }
  });
}

test("retryPrepared query failure preserves uncertainty and queues no replay when reads recover", async () => {
  let unavailable = true;
  const f = retryFixture(async () => {
    if (unavailable) throw new Error("fixture intent query failed");
    return { kind: "unknown" };
  });
  try {
    await settleRetryOriginal(f);
    const [outcome] = await retryBounded(Promise.allSettled([f.retry(await f.operations.prepare(f.input))]));
    if (outcome!.status === "fulfilled") assert.deepEqual(outcome!.value, retryAck);
    assert.equal(f.queries.length, 1);
    assert.equal(f.calls.length, 1);
    assert.equal(f.operations.snapshot(f.input.sessionId, [])[0]!.phase, "uncertain");
    unavailable = false;
    await retryTurn();
    await retryTurn();
    assert.equal(f.queries.length, 1);
    assert.equal(f.calls.length, 1);
  } finally { await f.close(); }
});

test("retryPrepared never queues replay when the original was in flight at entry but settles during its query", async () => {
  const started = Promise.withResolvers<void>();
  const query = Promise.withResolvers<RetryObservation>();
  const f = retryFixture(async () => { started.resolve(); return query.promise; });
  try {
    await startRetryOriginal(f);
    const decision = f.retry(await f.operations.prepare(f.input));
    const progress = await retryProgress(started.promise, decision);
    // An immediate ACK without a query is also a safe in-flight short circuit.
    // If the owner queries, finish the original call while that read is held.
    f.calls[0]!.reject(promptFailure());
    await Promise.allSettled([f.calls[0]!.task]);
    await retryTurn();
    if (progress === "query") {
      assert.equal(f.queries.length, 1);
      assert.equal(f.queries[0]!.finished, false);
      query.resolve({ kind: "unknown" });
    }
    assert.deepEqual(await retryBounded(decision), retryAck);
    await retryTurn();
    await retryTurn();
    assert.equal(f.calls.length, 1, "An in-flight action must not become a queued replay after settlement");
    assert.equal(f.operations.snapshot(f.input.sessionId, [])[0]!.phase, "uncertain");
    assert.equal(f.active(), 0);
  } finally { started.resolve(); query.resolve({ kind: "unknown" }); await f.close(); }
});

test("retryPrepared concurrent clicks share one held query and one new actual dispatch", async () => {
  const started = Promise.withResolvers<void>();
  const query = Promise.withResolvers<RetryObservation>();
  const f = retryFixture(async () => { started.resolve(); return query.promise; });
  try {
    await settleRetryOriginal(f);
    const firstPrepared = await f.operations.prepare(f.input);
    const secondPrepared = await f.operations.prepare(structuredClone(f.input));
    const first = f.retry(firstPrepared);
    assert.equal(await retryProgress(started.promise, first), "query", "Explicit retry must query before deciding");
    const second = f.retry(secondPrepared);
    await retryTurn();
    assert.equal(f.queries.length, 1, "Concurrent actions must share the query as well as dispatch");
    assert.equal(f.calls.length, 1);
    f.operations.submit(structuredClone(f.input));
    assert.equal(f.queries.length, 1, "Ordinary duplicate submit must not start another retry decision");
    query.resolve({ kind: "unknown" });
    assert.deepEqual(await retryBounded(Promise.all([first, second])), [retryAck, retryAck]);
    await retryTurn();
    assert.equal(f.queries.length, 1);
    assert.deepEqual(f.calls.map((call) => call.input), [f.input, f.input]);
    assert.equal(f.operations.snapshot(f.input.sessionId, [])[0]!.phase, "uncertain");
  } finally { started.resolve(); query.resolve({ kind: "unknown" }); await f.close(); }
});

for (const queryResult of ["unknown", "older receipt", "error"] as const) {
  test(`retryPrepared preserves a late observed receipt over a held query returning ${queryResult}`, async () => {
    const started = Promise.withResolvers<void>();
    const query = Promise.withResolvers<RetryObservation>();
    const f = retryFixture(async () => { started.resolve(); return query.promise; });
    const receipt = recoveredPromptReceipt("completed");
    try {
      await settleRetryOriginal(f);
      const decision = f.retry(await f.operations.prepare(f.input));
      assert.equal(await retryProgress(started.promise, decision), "query");
      f.operations.observeReceipts(f.input.sessionId, [receipt]);
      assert.deepEqual(f.operations.snapshot(f.input.sessionId, []), [operationFromReceipt(receipt)]);
      if (queryResult === "error") query.reject(new Error("fixture stale query failed"));
      else query.resolve(queryResult === "unknown" ? { kind: "unknown" }
        : { kind: "receipt", receipt: recoveredPromptReceipt("running") });
      const [outcome] = await retryBounded(Promise.allSettled([decision]));
      if (outcome!.status === "fulfilled") assert.deepEqual(outcome!.value, retryAck);
      await retryTurn();
      assert.equal(f.queries.length, 1);
      assert.equal(f.calls.length, 1, "A late durable receipt forbids another Prompt");
      assert.deepEqual(f.operations.snapshot(f.input.sessionId, []), [operationFromReceipt(receipt)],
        "A stale query outcome must not regress the observed durable Run");
    } finally { started.resolve(); query.resolve({ kind: "unknown" }); await f.close(); }
  });
}

test("retryPrepared cancellation joins a non-cooperative original query before ending and never redispatches", async () => {
  const parent = new AbortController();
  const started = Promise.withResolvers<void>();
  const query = Promise.withResolvers<RetryObservation>();
  const f = retryFixture(async () => { started.resolve(); return query.promise; });
  try {
    await settleRetryOriginal(f);
    const prepared = await f.operations.prepare(f.input, parent.signal);
    let decisionFinished = false;
    const decision = f.retry(prepared);
    const outcome = decision.then(
      (value) => { decisionFinished = true; return { status: "fulfilled" as const, value }; },
      (reason: unknown) => { decisionFinished = true; return { status: "rejected" as const, reason }; },
    );
    assert.equal(await retryProgress(started.promise, decision), "query");
    parent.abort(new Error("fixture request cancelled during intent query"));
    await retryTurn();
    assert.equal(f.queries[0]!.signal?.aborted, true, "The actual intent read must receive cancellation");
    assert.equal(f.queries[0]!.finished, false);
    assert.equal(decisionFinished, false, "Cancellation must not abandon the actual query Promise");
    assert.equal(f.calls.length, 1);
    query.resolve({ kind: "unknown" });
    const result = await retryBounded(outcome);
    if (result.status === "fulfilled") assert.deepEqual(result.value, retryAck);
    assert.equal(f.queries[0]!.finished, true);
    await retryTurn();
    assert.equal(f.calls.length, 1);
    assert.equal(f.operations.snapshot(f.input.sessionId, [])[0]!.phase, "uncertain");
  } finally {
    parent.abort();
    started.resolve();
    query.resolve({ kind: "unknown" });
    await f.close();
  }
});

async function fillRetryCapacity(f: RetryFixture): Promise<void> {
  const fillers = Array.from({ length: 255 }, (_, index) => ({
    ...structuredClone(f.input), intentId: `retry-capacity-${index}`,
  }));
  for (const filler of fillers) f.operations.submit(filler);
  await retryTurn();
  for (const call of f.calls)
    if (call.input.intentId.startsWith("retry-capacity-")) call.complete(undefined);
  await retryBounded(Promise.all(fillers.map((filler) =>
    f.operations.settled(filler.sessionId, filler.intentId))));
}

async function overflowRetryCapacity(f: RetryFixture): Promise<void> {
  const overflow = { ...structuredClone(f.input), intentId: "retry-capacity-overflow" };
  f.operations.submit(overflow);
  await retryTurn();
  for (const call of f.calls)
    if (call.input.intentId === overflow.intentId) call.complete(undefined);
  await retryBounded(f.operations.settled(overflow.sessionId, overflow.intentId));
}

test("retryPrepared keeps a held decision entry under the existing 256-operation eviction limit", async () => {
  const started = Promise.withResolvers<void>();
  const query = Promise.withResolvers<RetryObservation>();
  const f = retryFixture(async () => { started.resolve(); return query.promise; });
  try {
    await settleRetryOriginal(f);
    const decision = f.retry(await f.operations.prepare(f.input));
    assert.equal(await retryProgress(started.promise, decision), "query");
    await fillRetryCapacity(f);
    await overflowRetryCapacity(f);
    const changed = { ...structuredClone(f.input), expectedAppendVersion: f.input.expectedAppendVersion + 1 };
    assert.throws(() => f.operations.submit(changed), OperationConflictError,
      "Capacity eviction must not erase the immutable input of a held retry decision");
    assert.equal(f.queries.length, 1);
    query.resolve({ kind: "unknown" });
    assert.deepEqual(await retryBounded(decision), retryAck);
    await retryTurn();
    assert.deepEqual(f.calls.filter((call) => call.input.intentId === f.input.intentId)
      .map((call) => call.input), [f.input, f.input]);
  } finally { started.resolve(); query.resolve({ kind: "unknown" }); await f.close(); }
});

test("retryPrepared capacity fencing preserves an actual in-flight call even after a terminal receipt retires its work", async () => {
  const f = retryFixture();
  try {
    await startRetryOriginal(f);
    f.operations.observeReceipts(f.input.sessionId, [recoveredPromptReceipt("completed")]);
    assert.equal(f.calls[0]!.finished, false, "The actual ACP call is still owned after its receipt arrives");
    await fillRetryCapacity(f);
    await overflowRetryCapacity(f);
    const changed = { ...structuredClone(f.input), expectedAppendVersion: f.input.expectedAppendVersion + 1 };
    assert.throws(() => f.operations.submit(changed), OperationConflictError,
      "A terminal receipt must not permit eviction while the actual ACP call remains in flight");
    let finished = false;
    const settled = f.operations.settled(f.input.sessionId, f.input.intentId)
      .then(() => { finished = true; });
    await retryTurn();
    assert.equal(finished, false, "Capacity pressure must retain the actual original settlement Promise");
    f.calls[0]!.complete({ stopReason: "end_turn" });
    await retryBounded(settled);
    assert.equal(f.calls.filter((call) => call.input.intentId === f.input.intentId).length, 1);
    assert.equal(f.queries.length, 0);
  } finally { await f.close(); }
});
