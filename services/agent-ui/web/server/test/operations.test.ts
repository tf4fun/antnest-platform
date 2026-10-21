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
