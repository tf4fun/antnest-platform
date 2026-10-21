import assert from "node:assert/strict";
import test from "node:test";
import { BridgeOperationTracker } from "./bridge-operations.ts";
import { WorkspaceApiError, type PromptAdmission } from "./workspace-api-client.ts";

const admission: PromptAdmission = {
  intentId: "intent-1", expectedAppendVersion: 7, historyToken: "history-7",
  prompt: [{ type: "text", text: "hello" }],
};

test("Bridge receipt returns immediately while the Run remains active until observed terminal", async () => {
  const updates: string[] = [];
  const tracker = new BridgeOperationTracker({
    agentId: "agent-1",
    api: { sessionCurrent: () => true, onSessionCancelled: () => () => {},
      prompt: async () => ({ operationId: "intent-1", acceptance: "bridge", phase: "dispatching" }),
      operation: async () => assert.fail("unexpected lookup"),
      cancel: async () => assert.fail("unexpected cancel"),
    },
    changed: (operation) => updates.push(operation.phase),
  });
  const receipt = await tracker.submit("session-1", admission);
  assert.equal(receipt.phase, "dispatching");
  assert.equal(tracker.get("session-1", "intent-1")?.phase, "dispatching");
  tracker.observe([{ operationId: "intent-1", sessionId: "session-1", phase: "running",
    acceptance: "acp", runId: "run-1", outputWatermark: 2 }]);
  assert.equal(tracker.get("session-1", "intent-1")?.phase, "running");
  tracker.observe([{ operationId: "intent-1", sessionId: "session-1", phase: "completed",
    acceptance: "acp", runId: "run-1", outputWatermark: 4 }]);
  assert.equal(tracker.get("session-1", "intent-1")?.phase, "completed");
  assert.deepEqual(updates, ["dispatching", "running", "completed"]);
});

test("failed operation retains the durable failure class after an HTTP reread", async () => {
  const tracker = new BridgeOperationTracker({
    agentId: "agent-1",
    api: { sessionCurrent: () => true, onSessionCancelled: () => () => {},
      prompt: async () => assert.fail("unexpected prompt"),
      operation: async () => assert.fail("unexpected lookup"),
      cancel: async () => assert.fail("unexpected cancel"),
    },
  });
  tracker.observe([{ operationId: "intent-1", sessionId: "session-1", phase: "failed",
    acceptance: "acp", runId: "run-1", outputWatermark: 4,
    errorClass: "model_unsupported_content" }]);
  assert.equal(tracker.get("session-1", "intent-1")?.errorClass,
    "model_unsupported_content");
});

test("operation observation retains active work while bounding completed history", () => {
  const tracker = new BridgeOperationTracker({
    agentId: "agent-1",
    api: { sessionCurrent: () => true, onSessionCancelled: () => () => {},
      prompt: async () => assert.fail("unexpected prompt"),
      operation: async () => assert.fail("unexpected lookup"),
      cancel: async () => assert.fail("unexpected cancel"),
    },
  });
  tracker.observe([{ operationId: "active", sessionId: "session-1", phase: "running",
    acceptance: "acp", runId: "active-run", outputWatermark: 1 },
  { operationId: "uncertain", sessionId: "session-2", phase: "uncertain",
    acceptance: "unknown" }]);
  for (let index = 0; index < 200; index++)
    tracker.observe([{ operationId: `done-${index}`, sessionId: "session-1",
      phase: "completed", acceptance: "acp", runId: `run-${index}`,
      outputWatermark: index }]);
  const snapshot = tracker.snapshot;
  assert.ok(snapshot.length <= 66, `retained ${snapshot.length} operations`);
  assert.equal(snapshot.find((item) => item.operationId === "active")?.phase, "running");
  assert.equal(snapshot.find((item) => item.operationId === "uncertain")?.phase, "uncertain");
  assert.equal(snapshot.find((item) => item.operationId === "done-199")?.phase, "completed");
  assert.equal(tracker.get("session-1", "done-0"), undefined);
});

test("lost prompt response queries the original intent without submitting again", async () => {
  let submits = 0;
  const tracker = new BridgeOperationTracker({
    agentId: "agent-1",
    api: { sessionCurrent: () => true, onSessionCancelled: () => () => {},
      prompt: async () => { submits++; throw new WorkspaceApiError("lost", undefined, "workspace_network_error", "query_operation", "intent-1"); },
      operation: async (_agentId, _sessionId, intentId) => {
        assert.equal(intentId, "intent-1");
        return { operationId: "intent-1", sessionId: "session-1", phase: "running", acceptance: "acp", runId: "run-1", outputWatermark: 0 };
      },
      cancel: async () => assert.fail("unexpected cancel"),
    },
  });
  const result = await tracker.submit("session-1", admission);
  assert.equal(result.phase, "running");
  assert.equal(submits, 1);
});

test("unknown receipt remains uncertain and never silently retries the Prompt", async () => {
  let submits = 0;
  const tracker = new BridgeOperationTracker({
    agentId: "agent-1",
    api: { sessionCurrent: () => true, onSessionCancelled: () => () => {},
      prompt: async () => { submits++; throw new WorkspaceApiError("lost", 503, "workspace_unavailable", "query_operation", "intent-1"); },
      operation: async () => { throw new WorkspaceApiError("missing", 404, "not_found", "none"); },
      cancel: async () => assert.fail("unexpected cancel"),
    },
  });
  const result = await tracker.submit("session-1", admission);
  assert.equal(result.phase, "uncertain");
  assert.equal(result.acceptance, "unknown");
  assert.equal(submits, 1);
});

test("cancel uses only the known Run ID bound to the original Session and intent", async () => {
  const calls: unknown[] = [];
  const tracker = new BridgeOperationTracker({
    agentId: "agent-1",
    api: { sessionCurrent: () => true, onSessionCancelled: () => () => {},
      prompt: async () => ({ operationId: "intent-1", acceptance: "bridge", phase: "dispatching" }),
      operation: async () => assert.fail("unexpected lookup"),
      cancel: async (...args) => {
        calls.push(args);
        return { operationId: "intent-1", sessionId: "session-1", phase: "cancelling", acceptance: "acp", runId: "run-1", outputWatermark: 2 };
      },
    },
  });
  await tracker.submit("session-1", admission);
  await assert.rejects(tracker.cancel("session-1", "intent-1"), /Run ID/u);
  tracker.observe([{ operationId: "intent-1", sessionId: "session-1", phase: "running",
    acceptance: "acp", runId: "run-1", outputWatermark: 2 }]);
  await tracker.cancel("session-1", "intent-1");
  assert.deepEqual(calls, [["agent-1", "session-1", "intent-1", "run-1", undefined]]);
  await assert.rejects(tracker.cancel("session-2", "intent-1"), /Run ID/u);
});

test("lost cancel response reads the original Run without sending Stop twice", async () => {
  let cancels = 0;
  let reads = 0;
  const tracker = new BridgeOperationTracker({
    agentId: "agent-1",
    api: { sessionCurrent: () => true, onSessionCancelled: () => () => {},
      prompt: async () => ({ operationId: "intent-1", acceptance: "bridge", phase: "dispatching" }),
      operation: async (_agentId, sessionId, intentId) => {
        reads++;
        assert.equal(sessionId, "session-1");
        assert.equal(intentId, "intent-1");
        return { operationId: intentId, sessionId, phase: "cancelling",
          acceptance: "acp", runId: "run-1", outputWatermark: 2 };
      },
      cancel: async (_agentId, sessionId, intentId, expectedRunId) => {
        cancels++;
        assert.deepEqual([sessionId, intentId, expectedRunId],
          ["session-1", "intent-1", "run-1"]);
        throw new WorkspaceApiError("response lost", undefined,
          "workspace_network_error", "retry_read");
      },
    },
  });
  await tracker.submit("session-1", admission);
  tracker.observe([{ operationId: "intent-1", sessionId: "session-1", phase: "running",
    acceptance: "acp", runId: "run-1", outputWatermark: 2 }]);
  assert.equal((await tracker.cancel("session-1", "intent-1")).phase, "cancelling");
  assert.equal(cancels, 1);
  assert.equal(reads, 1);
});

test("lost cancel response rejects a lookup for another Run", async () => {
  const tracker = new BridgeOperationTracker({
    agentId: "agent-1",
    api: { sessionCurrent: () => true, onSessionCancelled: () => () => {},
      prompt: async () => ({ operationId: "intent-1", acceptance: "bridge", phase: "dispatching" }),
      operation: async () => ({ operationId: "intent-1", sessionId: "session-1",
        phase: "running", acceptance: "acp", runId: "run-2", outputWatermark: 3 }),
      cancel: async () => { throw new WorkspaceApiError("response lost", undefined,
        "workspace_network_error", "retry_read"); },
    },
  });
  await tracker.submit("session-1", admission);
  tracker.observe([{ operationId: "intent-1", sessionId: "session-1", phase: "running",
    acceptance: "acp", runId: "run-1", outputWatermark: 2 }]);
  await assert.rejects(tracker.cancel("session-1", "intent-1"), /response lost/u);
  assert.equal(tracker.get("session-1", "intent-1")?.runId, "run-1");
});

test("closing a browser tracker releases local state without cancelling ACP work", async () => {
  let cancelled = 0;
  const tracker = new BridgeOperationTracker({
    agentId: "agent-1",
    api: { sessionCurrent: () => true, onSessionCancelled: () => () => {},
      prompt: async () => ({ operationId: "intent-1", acceptance: "bridge", phase: "dispatching" }),
      operation: async () => assert.fail("unexpected lookup"),
      cancel: async () => { cancelled++; return {}; },
    },
  });
  await tracker.submit("session-1", admission);
  tracker.close();
  assert.equal(tracker.get("session-1", "intent-1"), undefined);
  assert.equal(cancelled, 0);
});

for (const action of ["submit", "cancel"] as const) {
  for (const outcome of ["success", "ambiguous"] as const) {
    for (const boundary of ["close", "replacement"] as const) {
      test(`${action} ${outcome} after ${boundary} neither publishes nor recovers old work`, async () => {
        let current = true;
        let complete!: (value: never) => void;
        let fail!: (cause: unknown) => void;
        const pendingResponse = new Promise<never>((resolve, reject) => { complete = resolve; fail = reject; });
        let queries = 0;
        const updates: unknown[] = [];
        const tracker = new BridgeOperationTracker({ agentId: "agent-1", api: {
          sessionCurrent: () => current,
          prompt: async () => pendingResponse,
          cancel: async () => pendingResponse,
          operation: async () => { queries++; return {}; },
        }, changed: value => updates.push(value) });
        if (action === "cancel") tracker.observe([{ operationId: "intent-1", sessionId: "session-1", phase: "running",
          acceptance: "acp", runId: "run-1", outputWatermark: 1 }]);
        updates.length = 0;
        const pending = action === "submit" ? tracker.submit("session-1", admission) : tracker.cancel("session-1", "intent-1");
        if (boundary === "close") tracker.close();
        else current = false;
        if (outcome === "success") complete((action === "submit"
          ? { operationId: "intent-1", acceptance: "bridge", phase: "dispatching" }
          : { operationId: "intent-1", sessionId: "session-1", phase: "cancelling", acceptance: "acp", runId: "run-1", outputWatermark: 2 }) as never);
        else fail(new WorkspaceApiError("response lost", undefined, "workspace_network_error", "query_operation", "intent-1"));
        await assert.rejects(pending);
        assert.equal(queries, 0);
        assert.deepEqual(updates, []);
        if (boundary === "close") assert.deepEqual(tracker.snapshot, []);
      });
    }
  }
}

test("a replaced session during recovery never publishes uncertain state", async () => {
  let current = true;
  let complete!: (value: unknown) => void;
  let entered!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const result = new Promise<unknown>(resolve => { complete = resolve; });
  const updates: unknown[] = [];
  const tracker = new BridgeOperationTracker({ agentId: "agent-1", api: {
    sessionCurrent: () => current,
    prompt: async () => { throw new WorkspaceApiError("lost", undefined, "workspace_network_error", "query_operation", "intent-1"); },
    cancel: async () => ({}),
    operation: async () => { entered(); return result; },
  }, changed: value => updates.push(value) });
  const pending = tracker.submit("session-1", admission);
  await reading;
  current = false;
  complete({ operationId: "intent-1", sessionId: "session-1", phase: "completed", acceptance: "acp", runId: "run-1", outputWatermark: 2 });
  await assert.rejects(pending);
  assert.deepEqual(updates, []);
  assert.deepEqual(tracker.snapshot, []);
});

const publicOperationError = {
  code: "internal_error",
  message: "Agent request failed",
  requestId: "request-1",
  operationId: "intent-1",
  retryable: false,
  recovery: "query_operation",
} as const;

function uncertainOperation(error: unknown = publicOperationError) {
  return { operationId: "intent-1", sessionId: "session-1", phase: "uncertain",
    acceptance: "unknown", error };
}

function trackedError(operation: ReturnType<BridgeOperationTracker["get"]>): unknown {
  return operation && "error" in operation ? operation.error : undefined;
}

test("observed operation retains its safe error and the original intent without retrying", async () => {
  const calls: string[] = [];
  const changes: unknown[] = [];
  const tracker = new BridgeOperationTracker({ agentId: "agent-1", api: {
    sessionCurrent: () => true,
    prompt: async () => { calls.push("prompt"); throw new Error("unexpected Prompt"); },
    operation: async () => { calls.push("operation"); throw new Error("unexpected lookup"); },
    cancel: async () => { calls.push("cancel"); throw new Error("unexpected cancel"); },
  }, changed: operation => changes.push(operation) });
  try {
    tracker.observe([uncertainOperation()]);
    assert.deepEqual(tracker.get("session-1", "intent-1"), uncertainOperation());
    assert.deepEqual(tracker.snapshot, [uncertainOperation()]);
    assert.deepEqual(changes, [uncertainOperation()]);
    await assert.rejects(tracker.submit("session-1", admission), /already tracked/u);
    assert.deepEqual(calls, []);
  } finally {
    tracker.close();
  }
});

test("lost HTTP admission recovers the original public error without another Prompt", async () => {
  const calls: unknown[] = [];
  const changes: unknown[] = [];
  const tracker = new BridgeOperationTracker({ agentId: "agent-1", api: {
    sessionCurrent: () => true,
    prompt: async (...args) => {
      calls.push(["prompt", ...args]);
      throw new WorkspaceApiError("Response was lost", undefined,
        "workspace_network_error", "query_operation", "intent-1");
    },
    operation: async (...args) => {
      calls.push(["operation", ...args]);
      return uncertainOperation();
    },
    cancel: async () => assert.fail("unexpected cancel"),
  }, changed: operation => changes.push(operation) });
  try {
    const result = await tracker.submit("session-1", admission);
    assert.deepEqual(result, uncertainOperation());
    assert.deepEqual(tracker.get("session-1", "intent-1"), uncertainOperation());
    assert.deepEqual(changes, [uncertainOperation()]);
    await assert.rejects(tracker.submit("session-1", admission), /already tracked/u);
    assert.deepEqual(calls, [
      ["prompt", "agent-1", "session-1", admission, undefined],
      ["operation", "agent-1", "session-1", "intent-1", undefined],
    ]);
  } finally {
    tracker.close();
  }
});

const privateErrorCanary = "private-operation-token-canary";
const invalidPublicErrors = [
  ["empty code", { ...publicOperationError, code: "" }],
  ["non-string message", { ...publicOperationError, message: { secret: privateErrorCanary } }],
  ["missing request identity", { code: publicOperationError.code,
    message: publicOperationError.message, operationId: "intent-1",
    retryable: false, recovery: "query_operation" }],
  ["another operation", { ...publicOperationError, operationId: "intent-other" }],
  ["retry instruction", { ...publicOperationError, retryable: true }],
  ["read retry recovery", { ...publicOperationError, recovery: "retry_read" }],
  ["private details", { ...publicOperationError, details: { token: privateErrorCanary } }],
  ["private cause", { ...publicOperationError, cause: privateErrorCanary }],
] as const;

for (const delivery of ["observe", "HTTP recovery"] as const) {
  for (const [label, error] of invalidPublicErrors) {
    test(`${delivery} excludes operation errors containing ${label}`, async () => {
      let submits = 0;
      let reads = 0;
      const changes: unknown[] = [];
      const tracker = new BridgeOperationTracker({ agentId: "agent-1", api: {
        sessionCurrent: () => true,
        prompt: async () => {
          submits++;
          throw new WorkspaceApiError("Response was lost", undefined,
            "workspace_network_error", "query_operation", "intent-1");
        },
        operation: async () => { reads++; return uncertainOperation(error); },
        cancel: async () => assert.fail("unexpected cancel"),
      }, changed: operation => changes.push(operation) });
      try {
        if (delivery === "observe") tracker.observe([uncertainOperation(error)]);
        else await tracker.submit("session-1", admission);
        assert.equal(trackedError(tracker.get("session-1", "intent-1")), undefined);
        assert.ok(!JSON.stringify([tracker.snapshot, changes]).includes(privateErrorCanary));
        assert.equal(submits, delivery === "observe" ? 0 : 1);
        assert.equal(reads, delivery === "observe" ? 0 : 1);
      } finally {
        tracker.close();
      }
    });
  }
}

for (const phase of ["running", "completed"] as const) {
  test(`durable ${phase} receipt replaces an uncertain error without resubmission`, async () => {
    let submits = 0;
    const tracker = new BridgeOperationTracker({ agentId: "agent-1", api: {
      sessionCurrent: () => true,
      prompt: async () => { submits++; throw new Error("unexpected Prompt"); },
      operation: async () => assert.fail("unexpected lookup"),
      cancel: async () => assert.fail("unexpected cancel"),
    } });
    try {
      tracker.observe([uncertainOperation()]);
      assert.deepEqual(trackedError(tracker.get("session-1", "intent-1")), publicOperationError);
      const receipt = { operationId: "intent-1", sessionId: "session-1", phase,
        acceptance: "acp", runId: "run-1", outputWatermark: 4 };
      tracker.observe([receipt]);
      assert.deepEqual(tracker.get("session-1", "intent-1"), receipt);
      assert.equal(trackedError(tracker.get("session-1", "intent-1")), undefined);
      assert.deepEqual(tracker.snapshot, [receipt]);
      await assert.rejects(tracker.submit("session-1", admission), /already tracked/u);
      assert.equal(submits, 0);
    } finally {
      tracker.close();
    }
  });
}

for (const outcome of ["bridge ACK", "failed recovery", "unknown recovery"] as const) {
  test(`late ${outcome} preserves an already observed uncertain error for the original intent`, async () => {
    const acknowledgement = {
      operationId: "intent-1", acceptance: "bridge", phase: "dispatching",
    } as const;
    let complete!: (value: typeof acknowledgement) => void;
    let fail!: (cause: unknown) => void;
    let enter!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const response = new Promise<typeof acknowledgement>((resolve, reject) => {
      complete = resolve;
      fail = reject;
    });
    let submits = 0;
    let reads = 0;
    const requests: unknown[] = [];
    const changes: unknown[] = [];
    const tracker = new BridgeOperationTracker({ agentId: "agent-1", api: {
      sessionCurrent: () => true,
      prompt: async (agentId, sessionId, originalAdmission) => {
        submits++;
        requests.push(["prompt", agentId, sessionId, originalAdmission]);
        enter();
        return response;
      },
      operation: async (agentId, sessionId, intentId) => {
        reads++;
        requests.push(["operation", agentId, sessionId, intentId]);
        if (outcome === "failed recovery")
          throw new WorkspaceApiError("Original operation is temporarily unavailable", 503,
            "workspace_unavailable", "retry_read");
        assert.equal(outcome, "unknown recovery");
        return null;
      },
      cancel: async () => assert.fail("unexpected cancel"),
    }, changed: operation => changes.push(operation) });
    const pending = tracker.submit("session-1", admission);
    try {
      await entered;
      tracker.observe([uncertainOperation()]);
      assert.deepEqual(tracker.get("session-1", "intent-1"), uncertainOperation());
      if (outcome === "bridge ACK") complete(acknowledgement);
      else fail(new WorkspaceApiError("Response was lost", undefined,
        "workspace_network_error", "query_operation", "intent-1"));
      const result = await pending;
      assert.deepEqual(result, uncertainOperation());
      assert.deepEqual(tracker.get("session-1", "intent-1"), uncertainOperation());
      assert.deepEqual(tracker.snapshot, [uncertainOperation()]);
      assert.deepEqual(changes, [uncertainOperation()]);
      await assert.rejects(tracker.submit("session-1", admission), /already tracked/u);
      assert.equal(submits, 1);
      assert.equal(reads, outcome === "bridge ACK" ? 0 : 1);
      assert.deepEqual(requests, [
        ["prompt", "agent-1", "session-1", admission],
        ...(outcome === "bridge ACK" ? [] :
          [["operation", "agent-1", "session-1", "intent-1"]]),
      ]);
    } finally {
      complete(acknowledgement);
      await Promise.allSettled([pending]);
      tracker.close();
    }
  });
}
