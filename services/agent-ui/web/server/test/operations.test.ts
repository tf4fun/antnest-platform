import assert from "node:assert/strict";
import { test } from "node:test";
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
    phase: "running", appendVersion: 3, outputWatermark: 0, stopReason: null,
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
          stopReason: null,
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
          stopReason: "end_turn",
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
    stopReason: null,
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
