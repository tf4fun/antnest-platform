import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentBridgeOwner, type AcpBridgePort } from "../src/bridge/agent-owner.ts";
import type { AcpBridgeCallbacks, IntentReceipt } from "../src/adapters/acp-http.ts";

const scope = { organizationId: "org", principalId: "user", agentId: "agent" };
function fixture() {
  let now = 0;
  let work = 0;
  let callbacks!: AcpBridgeCallbacks;
  let active: string | null = null;
  let appendVersion = 0;
  let watermark = 0;
  let receipts: IntentReceipt[] = [];
  const loads: string[] = [];
  const port: AcpBridgePort = {
    async load(sessionId) { loads.push(sessionId); return { cut: { sealedWatermark: watermark, appendVersion } }; },
    async readExecution(sessionId) { return { sessionId, appendVersion, outputWatermark: watermark,
      activeRunId: active, recentReceipts: receipts, configurationRevision: null }; },
    async readIntent() { return receipts[0] ? { kind: "receipt", receipt: receipts[0] } : { kind: "unknown" }; },
    async prompt() {}, async cancel() { throw new Error("Eviction must not cancel ACP work"); }, close() {},
  };
  return {
    port, loads, now: () => now, tick: (time: number) => { now = time; }, work: () => work,
    callbacks: () => callbacks,
    execution: (version: number, sequence: number, run: string | null, next: IntentReceipt[] = []) => {
      appendVersion = version; watermark = sequence; active = run; receipts = next;
    },
    open: () => AgentBridgeOwner.open({ scope, now: () => now, idleMs: 300_000,
      retainWork: () => { work++; let released = false; return () => { if (!released) { released = true; work--; } }; },
      connect: async (_scope, next) => { callbacks = next; return port; } }),
  };
}

test("Session idle clocks and incarnation are independent of another observed Session", async () => {
  const f = fixture(); const owner = await f.open();
  try {
    await owner.authorizeSession("one"); await owner.authorizeSession("two");
    const original = owner.sessionIncarnation("two");
    const stream = owner.subscribeAgentJournal("one", null, (cursor) => ({ cursor }));
    await stream.next();
    f.tick(300_001); await owner.sweep();
    assert.equal(owner.cachedSessionCount, 1);
    assert.equal(owner.retainedSession("two"), null);
    assert.notEqual(owner.retainedSession("one"), null);
    await owner.authorizeSession("two");
    assert.notEqual(owner.sessionIncarnation("two"), original);
    await stream.return!();
    f.tick(600_000); await owner.sweep();
    assert.equal(owner.cachedSessionCount, 2, "idle deadline starts at detach, not last activity before attachment");
    f.tick(600_001); await owner.sweep();
    assert.equal(owner.cachedSessionCount, 0);
  } finally { owner.close(); }
});

test("recovered ACP work pins the owner until a terminal observation, then gets a full idle grace", async () => {
  const f = fixture(); f.execution(0, 0, "running"); const owner = await f.open();
  try {
    await owner.authorizeSession("one");
    assert.equal(f.work(), 1);
    f.tick(900_000); await owner.sweep();
    assert.equal(owner.cachedSessionCount, 1);
    assert.equal(f.work(), 1);
    f.execution(0, 0, null); await owner.sweep();
    assert.equal(f.work(), 0);
    f.tick(1_199_999); await owner.sweep(); assert.equal(owner.cachedSessionCount, 1);
    f.tick(1_200_000); await owner.sweep(); assert.equal(owner.cachedSessionCount, 0);
  } finally { owner.close(); }
});

test("late execution and permission callbacks cannot resurrect a closed owner", async () => {
  const f = fixture(); const owner = await f.open();
  let finish!: () => void;
  const wait = new Promise<void>((resolve) => { finish = resolve; });
  f.port.readExecution = async (sessionId) => { await wait; return { sessionId,
    appendVersion: 0, outputWatermark: 0, activeRunId: "late", recentReceipts: [], configurationRevision: null }; };
  const reading = owner.authorizeSession("one");
  await new Promise((resolve) => setImmediate(resolve));
  owner.close(); finish();
  await assert.rejects(reading, /retired|closed|stale/i);
  assert.equal(f.work(), 0);
  assert.deepEqual(await f.callbacks().requestPermission({ sessionId: "one",
    toolCall: { toolCallId: "tool", title: "Late" }, options: [] }, new AbortController().signal),
  { outcome: { outcome: "cancelled" } });
  assert.equal(owner.cachedSessionCount, 0);
  assert.equal(f.work(), 0);
});

test("late execution reads cannot roll back a newer durable observation or resurrect work", async () => {
  const f = fixture();
  const owner = await f.open();
  try {
    await owner.authorizeSession("one");
    const replies: Array<(value: Awaited<ReturnType<AcpBridgePort["readExecution"]>>) => void> = [];
    f.port.readExecution = () => new Promise((resolve) => { replies.push(resolve); });
    const older = owner.authorizeExecution("one");
    const newer = owner.authorizeExecution("one");
    const receipt: IntentReceipt = { sessionId: "one", intentId: "intent", runId: "run",
      phase: "completed", appendVersion: 1, outputWatermark: 1, stopReason: "end_turn" };
    replies[1]!({ sessionId: "one", appendVersion: 1, outputWatermark: 1,
      activeRunId: null, recentReceipts: [receipt], configurationRevision: null });
    await newer;
    replies[0]!({ sessionId: "one", appendVersion: 0, outputWatermark: 0,
      activeRunId: "run", recentReceipts: [], configurationRevision: null });
    const late = await older;
    assert.equal(late.appendVersion, 1);
    assert.equal(late.outputWatermark, 1);
    assert.deepEqual(owner.cachedReceipts("one"), [receipt]);
    assert.equal(f.work(), 0);
  } finally { owner.close(); }
});

test("concurrent Agent state reads converge to the later request in either completion order", async () => {
  for (const order of [[0, 1], [1, 0]]) {
    const f = fixture();
    const owner = await f.open();
    try {
      type State = { availability: "ready" | "busy"; activeSessionId: string | null };
      const replies: Array<(value: State) => void> = [];
      f.port.readAgentExecutionState = () => new Promise((resolve) => { replies.push(resolve); });
      const reads = [owner.readAgentExecutionState(), owner.readAgentExecutionState()];
      const states: State[] = [{ availability: "busy", activeSessionId: "one" },
        { availability: "ready", activeSessionId: null }];
      for (const index of order) { replies[index]!(states[index]!); await reads[index]; }
      assert.deepEqual(owner.cachedAgentState(), states[1]);
    } finally { owner.close(); }
  }
});

test("an unchanged fresh Agent watch observation still fences an older HTTP read", async () => {
  const f = fixture();
  let observe!: (state: { availability: "ready" | "busy"; activeSessionId: string | null }) => void;
  f.port.watchAgentExecutionState = async (next, signal) => {
    observe = next;
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  };
  const owner = await f.open();
  try {
    const ready = { availability: "ready" as const, activeSessionId: null };
    observe(ready);
    let finish!: (state: { availability: "busy"; activeSessionId: string }) => void;
    f.port.readAgentExecutionState = () => new Promise((resolve) => { finish = resolve; });
    const reading = owner.readAgentExecutionState();
    observe(ready);
    finish({ availability: "busy", activeSessionId: "one" });
    assert.deepEqual(await reading, ready);
    assert.deepEqual(owner.cachedAgentState(), ready);
  } finally { owner.close(); }
});

test("known local admission advances the live append version without replay during or after the Run", async () => {
  const f = fixture(); const owner = await f.open();
  try {
    await owner.authorizeSession("one");
    const receipt: IntentReceipt = { sessionId: "one", intentId: "intent", runId: "run",
      phase: "running", appendVersion: 1, outputWatermark: 2, stopReason: null };
    f.port.prompt = async () => {
      for (const [sequence, sessionUpdate, text] of [[1, "user_message_chunk", "Question"], [2, "agent_message_chunk", "Answer"]] as const)
        await f.callbacks().update({ sessionId: "one", update: { sessionUpdate, messageId: String(sequence), content: { type: "text", text } },
          _meta: { "antnest.dev/delivery": { kind: "part", sequence, partIndex: 0, partCount: 1, runId: "run", messageId: String(sequence) } } });
      f.execution(1, 2, "run", [receipt]);
    };
    owner.operations.submit({ sessionId: "one", intentId: "intent", expectedAppendVersion: 0,
      prompt: [{ type: "text", text: "Question" }] });
    await owner.operations.settled("one", "intent");
    assert.equal((await owner.authorizeSession("one")).appendVersion, 1);
    assert.deepEqual(f.loads, ["one"]);
    f.execution(1, 3, "run", [{ ...receipt, outputWatermark: 3 }]);
    const waiting = owner.authorizeSession("one");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(f.loads, ["one"], "Missing live delivery waits instead of replaying");
    await f.callbacks().update({ sessionId: "one", update: { sessionUpdate: "agent_message_chunk", messageId: "2",
      content: { type: "text", text: " completed" } },
      _meta: { "antnest.dev/delivery": { kind: "part", sequence: 3, partIndex: 0, partCount: 1, runId: "run", messageId: "3" } } });
    await waiting;
    f.execution(1, 3, null, [{ ...receipt, outputWatermark: 3, phase: "completed", stopReason: "end_turn" }]);
    await owner.authorizeSession("one");
    assert.deepEqual(f.loads, ["one"]);
    assert.equal(owner.readTurns("one")[0]?.outcome, "completed");
  } finally { owner.close(); }
});

test("permission and configuration holds postpone Session eviction until each hold ends", async () => {
  const f = fixture();
  const option = { id: "auto", name: "Automatic", type: "boolean" as const, currentValue: true };
  f.port.load = async () => ({ cut: { appendVersion: 0, sealedWatermark: 0 }, response: { configOptions: [option] } });
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  f.port.setConfiguration = async () => { await pending; return { configOptions: [{ ...option, currentValue: false }] }; };
  const owner = await f.open();
  try {
    await owner.authorizeSession("one"); await owner.authorizeSession("two");
    const permission = f.callbacks().requestPermission({ sessionId: "one", toolCall: { toolCallId: "tool" },
      options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }] }, new AbortController().signal);
    const changing = owner.setConfiguration("one", "auto", false, "a".repeat(64));
    f.tick(900_000); await owner.sweep();
    assert.equal(owner.cachedSessionCount, 1);
    const item = owner.permissions[0]!;
    owner.decidePermission(item.permissionId, item.generation, "yes"); await permission;
    f.tick(1_200_000); await owner.sweep();
    assert.equal(owner.cachedSessionCount, 1, "Configuration still owns its materialization");
    finish(); await changing;
    assert.equal(owner.viewMetadata("one").configOptions[0]?.currentValue, false);
    f.tick(1_499_999); await owner.sweep(); assert.equal(owner.cachedSessionCount, 1);
    f.tick(1_500_000); await owner.sweep(); assert.equal(owner.cachedSessionCount, 0);
  } finally { finish(); owner.close(); }
});

test("configuration response from a closed materialization is fenced out", async () => {
  const f = fixture();
  const option = { id: "auto", name: "Automatic", type: "boolean" as const, currentValue: true };
  f.port.load = async () => ({ cut: { appendVersion: 0, sealedWatermark: 0 }, response: { configOptions: [option] } });
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  f.port.setConfiguration = async () => { await pending; return { configOptions: [{ ...option, currentValue: false }] }; };
  const owner = await f.open();
  await owner.authorizeSession("one");
  const changing = owner.setConfiguration("one", "auto", false, "a".repeat(64));
  owner.close(); finish();
  await assert.rejects(changing, /retired|stale/i);
  assert.equal(owner.cachedSessionCount, 0);
});
