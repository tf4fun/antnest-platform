import assert from "node:assert/strict";
import test from "node:test";
import { BridgeAgentController } from "./bridge-agent-controller.ts";
import type { BridgeAgentView } from "./bridge-stream.ts";
import { WorkspaceApiError } from "./workspace-api-client.ts";

function view(sessionId: string | null): BridgeAgentView {
  return {
    agentId: "agent", bridgeEpoch: "epoch", promptCapabilities: { image: true },
    selectedSessionId: sessionId, streamCursor: `cursor-${sessionId ?? "none"}`,
    selectedView: sessionId === null ? null : {
      sessionId, bridgeEpoch: "epoch", historyState: "ready", viewRevision: 1,
      title: null, updatedAt: null,
      turns: [{ turnId: "turn", outcome: "completed", prompt: [{ type: "text", text: "Question" }],
        finalResponse: [{ type: "text", text: "Answer" }], contentCursor: null,
        processVersion: 0, processCount: 0 }],
      olderTurnsCursor: null, configOptions: [], usage: null,
    },
  };
}

test("Controller swaps one scoped observer when selected Session changes", async () => {
  const observers: { sessionId: string | null; close: () => void; onView: (view: BridgeAgentView) => void }[] = [];
  let closes = 0;
  const controller = new BridgeAgentController({
    agentId: "agent",
    api: { agentView: async () => ({}), eventsURL: () => "", turnContent: async () => ({}) },
    openObserver: async (input) => {
      input.onView(view(input.sessionId));
      const observer = { sessionId: input.sessionId, onView: input.onView,
        close: () => { closes++; } };
      observers.push(observer);
      return observer.close;
    },
  });
  await controller.select(null);
  assert.equal(controller.snapshot.view?.selectedSessionId, null);
  await controller.select("session");
  assert.equal(closes, 1);
  assert.equal(controller.snapshot.conversation?.messages[1]?.content, "Answer");
  assert.equal(controller.snapshot.conversation?.updatedAt,
    new Date(0).toISOString(), "Unknown ACP time must not become browser wall time");
  observers[0]!.onView(view(null));
  assert.equal(controller.snapshot.view?.selectedSessionId, "session");
  controller.close();
  assert.equal(closes, 2);
  assert.equal(controller.snapshot.view, null);
});

test("Controller snapshot does not retain an unbounded second operation history", async () => {
  let push!: (view: BridgeAgentView) => void;
  const controller = new BridgeAgentController({
    agentId: "agent",
    api: { agentView: async () => ({}), eventsURL: () => "", turnContent: async () => ({}) },
    openObserver: async (input) => { push = input.onView; input.onView(view("session")); return () => {}; },
  });
  try {
    await controller.select("session");
    push({ ...view("session"), operations: [
      { operationId: "active", sessionId: "other", phase: "running",
        acceptance: "acp", runId: "active-run", outputWatermark: 1 },
      ...Array.from({ length: 200 }, (_, index) => ({
        operationId: `done-${index}`, sessionId: "session", phase: "completed",
        acceptance: "acp", runId: `run-${index}`, outputWatermark: index,
      })),
    ] });
    assert.ok(controller.snapshot.operations.length <= 65);
    assert.equal(controller.snapshot.operations.find((item) => item.operationId === "active")?.phase,
      "running");
    assert.equal(controller.snapshot.operations.find((item) => item.operationId === "done-199")?.phase,
      "completed");
  } finally {
    controller.close();
  }
});

test("Controller resync reopens only the current selected Session", async () => {
  const selected: (string | null)[] = [];
  let resync!: () => void;
  const controller = new BridgeAgentController({
    agentId: "agent",
    api: { agentView: async () => ({}), eventsURL: () => "", turnContent: async () => ({}) },
    openObserver: async (input) => {
      selected.push(input.sessionId);
      resync = input.onResync;
      input.onView(view(input.sessionId));
      return () => {};
    },
  });
  await controller.select("session");
  resync();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(selected, ["session", "session"]);
  controller.close();
});

test("Controller backs off repeated transport failures and resets after recovery", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let attempts = 0;
  let disconnect!: () => void;
  const controller = new BridgeAgentController({
    agentId: "agent",
    api: { agentView: async () => ({}), eventsURL: () => "", turnContent: async () => ({}) },
    openObserver: async (input) => {
      attempts++;
      if (attempts === 2 || attempts === 3)
        throw new Error("Bridge unavailable");
      input.onView(view("session"));
      input.onConnected?.();
      disconnect = input.onDisconnect;
      return () => {};
    },
  });
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  try {
    await controller.select("session");
    disconnect();
    t.mock.timers.tick(1_000);
    await flush();
    assert.equal(attempts, 2);
    t.mock.timers.tick(1_000);
    await flush();
    assert.equal(attempts, 2, "Second retry must wait beyond the first delay");
    t.mock.timers.tick(1_000);
    await flush();
    assert.equal(attempts, 3);
    t.mock.timers.tick(4_000);
    await flush();
    assert.equal(attempts, 4);
    disconnect();
    t.mock.timers.tick(1_000);
    await flush();
    assert.equal(attempts, 5, "A healthy observer resets the backoff");
  } finally {
    controller.close();
    t.mock.timers.reset();
  }
});

test("Controller clears private View when reconnect discovers an inactive identity", async () => {
  let resync!: () => void;
  let attempts = 0;
  const controller = new BridgeAgentController({
    agentId: "agent",
    api: { agentView: async () => ({}), eventsURL: () => "", turnContent: async () => ({}) },
    openObserver: async (input) => {
      if (++attempts === 1) {
        input.onView(view("session"));
        resync = input.onResync;
        return () => {};
      }
      throw new WorkspaceApiError("Session is inactive", 401, "unauthenticated", "login");
    },
  });
  await controller.select("session");
  assert.ok(controller.snapshot.view);
  resync();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(controller.snapshot.unauthenticated, true);
  assert.equal(controller.snapshot.view, null);
  assert.deepEqual(controller.snapshot.operations, []);
});

test("Prompt acceptance and Run terminal are distinct controller states", async () => {
  let push!: (view: BridgeAgentView) => void;
  const submissions: unknown[] = [];
  const controller = new BridgeAgentController({
    agentId: "agent",
    api: {
      agentView: async () => ({}), eventsURL: () => "", turnContent: async () => ({}),
      prompt: async (_agentId, _sessionId, admission) => {
        submissions.push(admission);
        return { operationId: admission.intentId, acceptance: "bridge", phase: "dispatching" };
      },
      operation: async () => ({}), cancel: async () => ({}),
    },
    openObserver: async (input) => {
      push = input.onView;
      input.onView({ ...view("session"), selectedView: {
        ...view("session").selectedView, appendVersion: 4, historyToken: "token-4", operations: [],
      } });
      return () => {};
    },
  });
  await controller.select("session");
  const admitted = await controller.submitPrompt("intent-1", [{ type: "text", text: "Question" }]);
  assert.equal(admitted.phase, "dispatching");
  assert.equal(controller.snapshot.operations[0]?.phase, "dispatching");
  assert.deepEqual(submissions, [{ intentId: "intent-1", expectedAppendVersion: 4,
    historyToken: "token-4", prompt: [{ type: "text", text: "Question" }] }]);
  push({ ...view("session"), selectedView: {
    ...view("session").selectedView, appendVersion: 5, historyToken: "token-5", operations: [
      { operationId: "intent-1", sessionId: "session", phase: "completed", acceptance: "acp",
        runId: "run-1", outputWatermark: 10 },
    ],
  } });
  assert.equal(controller.snapshot.operations[0]?.phase, "completed");
  controller.close();
});

test("Controller answers only the current permission generation", async () => {
  let push!: (view: BridgeAgentView) => void;
  const decisions: unknown[][] = [];
  const controller = new BridgeAgentController({
    agentId: "agent",
    api: {
      agentView: async () => ({}), eventsURL: () => "", turnContent: async () => ({}),
      prompt: async () => ({}), operation: async () => ({}), cancel: async () => ({}),
      decidePermission: async (...args) => { decisions.push(args); return {}; },
    },
    openObserver: async (input) => {
      push = input.onView;
      input.onView({ ...view(null), permissions: [] });
      return () => {};
    },
  });
  await controller.select(null);
  push({ ...view(null), permissions: [{ permissionId: "p1", sessionId: "s1", generation: 7,
    toolCall: { toolCallId: "t1" }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] }] });
  assert.equal(controller.snapshot.permissions[0]?.id, "p1");
  await controller.decidePermission("p1", "allow");
  assert.deepEqual(decisions, [["agent", "p1", 7, "allow", undefined]]);
  controller.close();
});

test("disconnected Controller refuses commands derived from its stale View", async () => {
  let disconnect!: () => void;
  const writes: string[] = [];
  const controller = new BridgeAgentController({
    agentId: "agent",
    api: {
      agentView: async () => ({}), eventsURL: () => "", turnContent: async () => ({}),
      prompt: async () => { writes.push("prompt"); return {}; },
      cancel: async () => { writes.push("cancel"); return {}; },
      operation: async () => ({}),
      configuration: async () => { writes.push("configuration"); return {}; },
      decidePermission: async () => { writes.push("permission"); return {}; },
    },
    openObserver: async (input) => {
      disconnect = input.onDisconnect;
      input.onView({ ...view("session"), permissions: [{ permissionId: "p1",
        sessionId: "session", generation: 1, toolCall: { toolCallId: "tool" },
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] }],
      operations: [{ operationId: "intent-1", sessionId: "session", phase: "running",
        acceptance: "acp", runId: "run-1", outputWatermark: 1 }],
      selectedView: { ...view("session").selectedView, appendVersion: 2,
        historyToken: "history-2", configurationToken: "config-1",
        configOptions: [{ id: "safe_mode", name: "Safe mode", type: "boolean",
          currentValue: true }] } });
      return () => {};
    },
  });
  try {
    await controller.select("session");
    disconnect();
    assert.equal(controller.snapshot.connection, "offline");
    await assert.rejects(controller.submitPrompt("intent-2", [{ type: "text", text: "hello" }]),
      /current.*View|connection/ui);
    await assert.rejects(controller.cancelOperation("session", "intent-1"), /connection/ui);
    await assert.rejects(controller.setConfiguration("safe_mode", false), /connection/ui);
    await assert.rejects(controller.decidePermission("p1", "allow"), /connection/ui);
    assert.deepEqual(writes, []);
  } finally {
    controller.close();
  }
});

test("lost permission response rereads the current request without deciding twice", async () => {
  let decided = false;
  let commands = 0;
  let observations = 0;
  const pending = { permissionId: "p1", sessionId: "session", generation: 7,
    toolCall: { toolCallId: "t1" },
    options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] };
  const controller = new BridgeAgentController({
    agentId: "agent",
    api: {
      agentView: async () => ({}), eventsURL: () => "", turnContent: async () => ({}),
      decidePermission: async () => {
        commands++;
        decided = true;
        throw new WorkspaceApiError("response lost", undefined,
          "workspace_network_error", "retry_read");
      },
    },
    openObserver: async (input) => {
      observations++;
      input.onView({ ...view(input.sessionId), permissions: decided ? [] : [pending] });
      return () => {};
    },
  });
  try {
    await controller.select("session");
    await controller.decidePermission("p1", "allow");
    assert.equal(commands, 1);
    assert.equal(observations, 2);
    assert.deepEqual(controller.snapshot.permissions, []);
  } finally {
    controller.close();
  }
});

test("lost permission response preserves an error while the same request remains pending", async () => {
  let commands = 0;
  const pending = { permissionId: "p1", sessionId: "session", generation: 7,
    toolCall: { toolCallId: "t1" },
    options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] };
  const controller = new BridgeAgentController({
    agentId: "agent",
    api: {
      agentView: async () => ({}), eventsURL: () => "", turnContent: async () => ({}),
      decidePermission: async () => {
        commands++;
        throw new WorkspaceApiError("response lost", undefined,
          "workspace_network_error", "retry_read");
      },
    },
    openObserver: async (input) => {
      input.onView({ ...view(input.sessionId), permissions: [pending] });
      return () => {};
    },
  });
  try {
    await controller.select("session");
    await assert.rejects(controller.decidePermission("p1", "allow"), /response lost/u);
    assert.equal(commands, 1);
    assert.equal(controller.snapshot.permissions[0]?.id, "p1");
  } finally {
    controller.close();
  }
});

test("Configuration command carries the selected View token", async () => {
  const changes: unknown[][] = [];
  const controller = new BridgeAgentController({
    agentId: "agent",
    api: {
      agentView: async () => ({}), eventsURL: () => "", turnContent: async () => ({}),
      prompt: async () => ({}), operation: async () => ({}), cancel: async () => ({}),
      decidePermission: async () => ({}),
      configuration: async (...args) => { changes.push(args); return {}; },
    },
    openObserver: async (input) => {
      input.onView({ ...view("session"), selectedView: {
        ...view("session").selectedView, configurationToken: "config-token",
        configOptions: [{ id: "model", name: "Model", type: "select", currentValue: "a",
          options: [{ value: "a", name: "A" }, { value: "b", name: "B" }] }],
      } });
      return () => {};
    },
  });
  await controller.select("session");
  await controller.setConfiguration("model", "b");
  assert.deepEqual(changes, [["agent", "session", "model", "b", "config-token", undefined]]);
  await assert.rejects(controller.setConfiguration("model", "unlisted"), /not advertised/u);
  controller.close();
});

test("lost configuration response reloads authoritative choices without resending", async () => {
  let authoritative = "a";
  let commands = 0;
  let observations = 0;
  const controller = new BridgeAgentController({
    agentId: "agent",
    api: {
      agentView: async () => ({}), eventsURL: () => "", turnContent: async () => ({}),
      configuration: async () => {
        commands++;
        authoritative = "b";
        throw new Error("response lost");
      },
    },
    openObserver: async (input) => {
      observations++;
      input.onView({ ...view("session"), selectedView: {
        ...view("session").selectedView, configurationToken: `config-${observations}`,
        configOptions: [{ id: "model", name: "Model", type: "select",
          currentValue: authoritative,
          options: [{ value: "a", name: "A" }, { value: "b", name: "B" }] }],
      } });
      return () => {};
    },
  });
  try {
    await controller.select("session");
    await controller.setConfiguration("model", "b");
    assert.equal(observations, 2);
    assert.equal(controller.snapshot.view?.selectedView?.configOptions[0]?.currentValue, "b");
    assert.equal(commands, 1);
  } finally {
    controller.close();
  }
});

test("lost configuration response reports failure when authoritative choice stayed unchanged", async () => {
  let commands = 0;
  let observations = 0;
  const controller = new BridgeAgentController({
    agentId: "agent",
    api: {
      agentView: async () => ({}), eventsURL: () => "", turnContent: async () => ({}),
      configuration: async () => { commands++; throw new Error("response lost"); },
    },
    openObserver: async (input) => {
      observations++;
      input.onView({ ...view("session"), selectedView: {
        ...view("session").selectedView, configurationToken: `config-${observations}`,
        configOptions: [{ id: "model", name: "Model", type: "select", currentValue: "a",
          options: [{ value: "a", name: "A" }, { value: "b", name: "B" }] }],
      } });
      return () => {};
    },
  });
  try {
    await controller.select("session");
    await assert.rejects(controller.setConfiguration("model", "b"), /response lost/u);
    assert.equal(observations, 2);
    assert.equal(controller.snapshot.view?.selectedView?.configOptions[0]?.currentValue, "a");
    assert.equal(commands, 1);
  } finally {
    controller.close();
  }
});

test("late configuration failure cannot reopen a Session selected before it arrived", async () => {
  let rejectCommand!: (cause: Error) => void;
  const command = new Promise<never>((_resolve, reject) => { rejectCommand = reject; });
  const selections: (string | null)[] = [];
  const controller = new BridgeAgentController({
    agentId: "agent",
    api: {
      agentView: async () => ({}), eventsURL: () => "", turnContent: async () => ({}),
      configuration: async () => command,
    },
    openObserver: async (input) => {
      selections.push(input.sessionId);
      input.onView({ ...view(input.sessionId), selectedView: {
        ...view(input.sessionId).selectedView, configurationToken: "config-token",
        configOptions: [{ id: "model", name: "Model", type: "select", currentValue: "a",
          options: [{ value: "a", name: "A" }, { value: "b", name: "B" }] }],
      } });
      return () => {};
    },
  });
  try {
    await controller.select("session");
    const changing = controller.setConfiguration("model", "b");
    await controller.select("another");
    rejectCommand(new Error("response lost"));
    await assert.rejects(changing, /response lost/u);
    assert.deepEqual(selections, ["session", "another"]);
    assert.equal(controller.snapshot.view?.selectedSessionId, "another");
  } finally {
    controller.close();
  }
});
