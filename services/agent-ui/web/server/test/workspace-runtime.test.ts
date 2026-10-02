import { applyAgentDelta } from "../src/protocol/agent-view-delta.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AcpBridgePort } from "../src/bridge/agent-owner.ts";
import { HistoryTokens } from "../src/bridge/history-token.ts";
import { createWorkspaceRuntime } from "../src/workspace-runtime.ts";

function expandedEvent(event: any, previous: any): any {
  if (event.type !== "delta") return event;
  const view = applyAgentDelta(previous, event);
  assert.ok(view, "SSE delta must apply to the preceding View");
  return { ...event, view };
}

const scope = {
  organizationId: "org-1",
  principalId: "user-1",
  agentId: "agent-1",
};
const base =
  "http://localhost/api/app/workspace/v1/agents/agent-1/sessions/session-1";

test("Agent View exposes a learning result delivered through an uncached Session", async () => {
  let update!: (value: unknown) => void;
  const runtime = createWorkspaceRuntime({
    connect: async (_scope, callbacks) => {
      update = callbacks.update as (value: unknown) => void;
      return {
        async readAgentExecutionState() {
          return { availability: "ready" as const, activeSessionId: null };
        },
        async readLearningChanges() { return {
          items: [{ changeId: "prior-change", sequence: "1", agentId: "agent-1",
            kind: "skill_created" as const, occurredAt: "2026-09-29T00:00:00Z",
            skillName: "workflow", changeSummary: "Earlier learning result" }],
          nextCursor: "sealed-1", sealedCursor: "sealed-1", olderCursor: null,
        }; },
        async load() { return { cut: { sealedWatermark: 0, appendVersion: 0 } }; },
        async readExecution(sessionId) { return { sessionId, appendVersion: 0,
          outputWatermark: 0, activeRunId: null, recentReceipts: [],
          configurationRevision: null }; },
        async readIntent() { return { kind: "unknown" as const }; },
        async prompt() {}, async cancel() {}, close() {},
      };
    },
  });
  const headers = { "x-antnest-organization-id": "org-1",
    "x-antnest-principal-id": "user-1", "x-antnest-agent-id": "agent-1" };
  const read = async () => runtime.handle(new Request(
    "http://localhost/api/app/workspace/v1/agents/agent-1/view", { headers }));
  try {
    assert.deepEqual((await (await read())?.json()).systemNotices.map(
      (item: { changeId: string }) => item.changeId), ["prior-change"]);
    update({ sessionId: "uncached-session", update: {
      sessionUpdate: "notice", severity: "info", title: "Learned a workflow",
      description: "Skill learning result saved.",
      _meta: { "antnest.dev/skill-learning": {
        version: 1, changeId: "change-1", sequence: "1", agentId: "agent-1",
        kind: "skill_created", occurredAt: "2026-09-29T00:00:00Z",
        skillName: "workflow", changeSummary: "Learned a workflow",
        sourceSessionId: "uncached-session",
      } },
    } });
    const view = await (await read())?.json();
    assert.deepEqual(view.systemNotices.map((item: { changeId: string }) => item.changeId),
      ["prior-change", "change-1"]);
    assert.equal(view.selectedView, null);
  } finally { await runtime.drain(1_000); }
});

test("Session View carries ACP title and timestamp through replay and live updates", async () => {
  let update!: (value: unknown) => void;
  let watermark = 0;
  const runtime = createWorkspaceRuntime({
    connect: async (_scope, callbacks) => {
      update = callbacks.update as (value: unknown) => void;
      return {
        async readAgentExecutionState() {
          return { availability: "ready" as const, activeSessionId: null };
        },
        async load(sessionId) {
          callbacks.update({ sessionId,
            update: { sessionUpdate: "session_info_update", title: "ACP title",
              updatedAt: "2026-09-24T00:00:00Z" },
          });
          return { cut: { sealedWatermark: 0, appendVersion: 1 } };
        },
        async readExecution(sessionId) { return { sessionId, appendVersion: 1,
          outputWatermark: watermark, activeRunId: null, recentReceipts: [],
          configurationRevision: null }; },
        async readIntent() { return { kind: "unknown" as const }; },
        async prompt() {}, async cancel() {}, close() {},
      };
    },
  });
  const headers = { "x-antnest-organization-id": "org-1",
    "x-antnest-principal-id": "user-1", "x-antnest-agent-id": "agent-1" };
  const read = async () => runtime.handle(new Request(`${base}/view`, { headers }));
  try {
    const first = await read();
    assert.equal(first?.status, 200);
    const original = await first?.json();
    assert.equal(original.title, "ACP title");
    assert.equal(original.updatedAt, "2026-09-24T00:00:00Z");
    watermark = 1;
    update({ sessionId: "session-1",
      update: { sessionUpdate: "session_info_update", title: "Renamed",
        updatedAt: "2026-09-24T01:00:00Z" },
      _meta: { "antnest.dev/delivery": { kind: "part", sequence: 1,
        partIndex: 0, partCount: 1, runId: null, messageId: "info-2" } },
    });
    const next = await read();
    assert.equal(next?.status, 200);
    const body = await next?.json();
    assert.equal(body.title, "Renamed");
    assert.equal(body.updatedAt, "2026-09-24T01:00:00Z");
    update({ sessionId: "session-1", update: {
      sessionUpdate: "session_info_update", title: "Sideband title",
      updatedAt: "2026-09-24T02:00:00Z",
    } });
    const sideband = await read();
    assert.equal(sideband?.status, 200);
    const changed = await sideband?.json();
    assert.equal(changed.title, "Sideband title");
    assert.equal(changed.updatedAt, "2026-09-24T02:00:00Z");
  } finally {
    await runtime.drain(1_000);
  }
});

test("Agent SSE capacity is shared across selections and released on disconnect", async () => {
  const runtime = createWorkspaceRuntime({
    maxAgentSubscribers: 1,
    connect: async () => ({
      async readAgentExecutionState() {
        return { availability: "ready" as const, activeSessionId: null };
      },
      async load() { return { cut: { sealedWatermark: 0, appendVersion: 0 } }; },
      async readExecution(sessionId) { return { sessionId, appendVersion: 0,
        outputWatermark: 0, activeRunId: null, recentReceipts: [],
        configurationRevision: null }; },
      async readIntent() { return { kind: "unknown" as const }; },
      async prompt() {}, async cancel() {}, close() {},
    }),
  });
  assert.deepEqual(runtime.metrics(), { owners: 0, observerLeases: 0, heldWork: 0,
    cachedBytes: 0, streamSubscribers: 0,
    journalQueuedBytes: 0, journalRetainedBytes: 0,
    activeReplays: 0, queuedReplays: 0,
    uncertainOperations: 0, oldestUncertainMs: 0 });
  const headers = {
    "x-antnest-organization-id": "org-1",
    "x-antnest-principal-id": "user-1",
    "x-antnest-agent-id": "agent-1",
  };
  const url = "http://localhost/api/app/workspace/v1/agents/agent-1/events";
  const abort = new AbortController();
  let firstReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let admittedReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const first = await runtime.handle(new Request(url, {
      headers, signal: abort.signal,
    }));
    assert.equal(first?.status, 200);
    assert.equal(runtime.metrics().owners, 1);
    assert.ok(runtime.metrics().observerLeases >= 1);
    assert.equal(runtime.metrics().streamSubscribers, 1);
    firstReader = first!.body!.getReader();
    const full = await runtime.handle(new Request(`${url}?sessionId=session-1`, { headers }));
    assert.equal(full?.status, 429);
    assert.equal((await full?.json()).code, "stream_capacity_exceeded");
    abort.abort();
    await firstReader.cancel();
    firstReader = undefined;
    const admitted = await runtime.handle(new Request(`${url}?sessionId=session-1`, { headers }));
    assert.equal(admitted?.status, 200);
    assert.ok(runtime.metrics().cachedBytes > 0);
    admittedReader = admitted!.body!.getReader();
  } finally {
    abort.abort();
    await firstReader?.cancel();
    await admittedReader?.cancel();
    await runtime.drain(1_000);
    assert.deepEqual(runtime.metrics(), { owners: 0, observerLeases: 0, heldWork: 0,
      cachedBytes: 0, streamSubscribers: 0,
      journalQueuedBytes: 0, journalRetainedBytes: 0,
      activeReplays: 0, queuedReplays: 0,
      uncertainOperations: 0, oldestUncertainMs: 0 });
  }
});

test("failed replacement replay serves a freshly authorized read-only sealed View", async () => {
  let version = 1;
  let failReplacement = true;
  let accessDenied = false;
  let loads = 0;
  let update!: (value: unknown) => void;
  const runtime = createWorkspaceRuntime({
    connect: async (_scope, callbacks) => { update = callbacks.update as (value: unknown) => void; return {
      async readAgentExecutionState() {
        return { availability: "ready" as const, activeSessionId: null };
      },
      async load(sessionId) {
        loads++;
        if (loads > 1 && failReplacement) throw new Error("ACP replay offline");
        callbacks.update({ sessionId,
          update: { sessionUpdate: "agent_message_chunk", messageId: `answer-${loads}`,
            content: { type: "text", text: loads === 1 ? "old answer" : "new answer" } },
          _meta: { "antnest.dev/delivery": { kind: "part", sequence: 1,
            partIndex: 0, partCount: 1, runId: `run-${loads}`, messageId: `event-${loads}` } },
        });
        callbacks.update({ sessionId,
          update: { sessionUpdate: "available_commands_update", availableCommands: [] },
          _meta: { "antnest.dev/delivery": { kind: "checkpoint", sequence: 2 } },
        });
        return { cut: { sealedWatermark: 2, appendVersion: version } };
      },
      async readExecution(sessionId) { if (accessDenied) throw new Error("Access denied");
        return { sessionId, appendVersion: version,
        outputWatermark: 2, activeRunId: null, recentReceipts: [],
        configurationRevision: null }; },
      async readIntent() { return { kind: "unknown" as const }; },
      async prompt() {}, async cancel() {}, close() {},
    }; },
  });
  const headers = { "x-antnest-organization-id": "org-1",
    "x-antnest-principal-id": "user-1", "x-antnest-agent-id": "agent-1" };
  const read = async () => runtime.handle(new Request(`${base}/view`, { headers }));
  try {
    const first = await read();
    assert.equal(first?.status, 200);
    const sealed = await first?.json();
    assert.equal(sealed.historyState, "ready");
    assert.match(JSON.stringify(sealed.turns), /old answer/u);
    version = 2;
    const failed = await read();
    assert.equal(failed?.status, 200);
    const blocked = await failed?.json();
    assert.equal(blocked.historyState, "blocked");
    assert.equal(blocked.appendVersion, 1);
    assert.equal(blocked.outputWatermark, 2);
    assert.equal(blocked.historyToken, null);
    assert.equal(blocked.configurationToken, null);
    assert.equal(blocked.olderTurnsCursor, null);
    assert.match(JSON.stringify(blocked.turns), /old answer/u);
    const agentView = await runtime.handle(new Request(
      "http://localhost/api/app/workspace/v1/agents/agent-1/view?sessionId=session-1",
      { headers },
    ));
    assert.equal(agentView?.status, 200);
    const selected = await agentView?.json();
    assert.equal(selected.selectedView.historyState, "blocked");
    const streamAbort = new AbortController();
    const stream = await runtime.handle(new Request(
      `http://localhost/api/app/workspace/v1/agents/agent-1/events?sessionId=session-1&cursor=${encodeURIComponent(selected.streamCursor)}`,
      { headers, signal: streamAbort.signal },
    ));
    assert.equal(stream?.status, 200);
    const reader = stream!.body!.getReader();
    try {
      update({ sessionId: "session-1", update: {
        sessionUpdate: "available_commands_update", availableCommands: [],
      }, _meta: { "antnest.dev/delivery": { kind: "checkpoint", sequence: 3 } } });
      const frame = new TextDecoder().decode((await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Blocked SSE timed out")), 1500)),
      ])).value);
      assert.equal(expandedEvent(JSON.parse(frame.match(/data: (.+)/u)?.[1] ?? "null"), selected)
        .view.selectedView.historyState, "blocked");
    } finally {
      streamAbort.abort();
      await reader.cancel();
    }
    accessDenied = true;
    const denied = await read();
    assert.equal(denied?.status, 503);
    assert.doesNotMatch(await denied?.text() ?? "", /old answer/u);
    accessDenied = false;
    failReplacement = false;
    const recovered = await read();
    assert.equal(recovered?.status, 200);
    const ready = await recovered?.json();
    assert.equal(ready.historyState, "ready");
    assert.equal(ready.appendVersion, 2);
    assert.match(JSON.stringify(ready.turns), /new answer/u);
  } finally {
    await runtime.drain(1_000);
  }
});

test("live history remains complete in HTTP, multipart output and Agent SSE", async () => {
  let update!: (value: unknown) => void;
  const runtime = createWorkspaceRuntime({
    connect: async (_identity, callbacks) => {
      update = callbacks.update as (value: unknown) => void;
      return {
        async readAgentExecutionState() {
          return { availability: "busy" as const, activeSessionId: "session-1" };
        },
        async load() { return { cut: { sealedWatermark: 0, appendVersion: 1 } }; },
        async readExecution(sessionId) { return { sessionId, appendVersion: 1,
          outputWatermark: 0, activeRunId: "run-1", recentReceipts: [{ sessionId,
            intentId: "intent-1", runId: "run-1", phase: "running" as const,
            appendVersion: 1, outputWatermark: 0, stopReason: null, errorClass: null }],
          configurationRevision: null }; },
        async readIntent() { return { kind: "unknown" as const }; },
        async prompt() {}, async cancel() {}, close() {},
      };
    },
  });
  const headers = { "x-antnest-organization-id": "org-1",
    "x-antnest-principal-id": "user-1", "x-antnest-agent-id": "agent-1" };
  const read = async (path: string) => runtime.handle(new Request(path, { headers }));
  const streamAbort = new AbortController();
  let streamReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const initial = await read(`${base}/view`);
    assert.equal(initial?.status, 200);
    const previousToken = (await initial?.json()).historyToken;
    const agentBefore = await read("http://localhost/api/app/workspace/v1/agents/agent-1/view?sessionId=session-1");
    const initialAgentView = await agentBefore?.json();
    const agentCursor = initialAgentView.streamCursor;
    const stream = await runtime.handle(new Request(
      `http://localhost/api/app/workspace/v1/agents/agent-1/events?sessionId=session-1&cursor=${encodeURIComponent(agentCursor)}`,
      { headers, signal: streamAbort.signal },
    ));
    assert.equal(stream?.status, 200);
    streamReader = stream!.body!.getReader();
    update({ sessionId: "session-1", update: {
      sessionUpdate: "agent_message_chunk", messageId: "answer-1",
      content: { type: "text", text: "output".repeat(200) },
    }, _meta: { "antnest.dev/delivery": { kind: "part", sequence: 1,
      partIndex: 0, partCount: 1, runId: "run-1", messageId: "event-1" } } });
    const response = await read(`${base}/view`);
    assert.equal(response?.status, 200);
    const view = await response?.json();
    assert.equal(view.historyState, "ready");
    assert.equal(view.outputWatermark, 1);
    assert.equal(typeof view.historyToken, "string");
    assert.equal(view.turns[0].finalResponse[0].text, "output".repeat(200));
    assert.equal(view.operations[0]?.operationId, "intent-1");
    const frame = new TextDecoder().decode((await Promise.race([
      streamReader.read(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("SSE timed out")), 2000)),
    ])).value);
    assert.equal(expandedEvent(JSON.parse(frame.match(/data: (.+)/u)?.[1] ?? "null"), initialAgentView)
      .view.selectedView.historyState, "ready");
    update({ sessionId: "session-1", update: {
      sessionUpdate: "agent_message_chunk", messageId: "answer-1",
      content: { type: "text", text: "later" },
    }, _meta: { "antnest.dev/delivery": { kind: "part", sequence: 2,
      partIndex: 0, partCount: 1, runId: "run-1", messageId: "event-2" } } });
    const continued = await read(`${base}/view`);
    assert.equal((await continued?.json()).outputWatermark, 2);
    update({ sessionId: "session-1", update: {
      sessionUpdate: "agent_message_chunk", messageId: "answer-1",
      content: { type: "text", text: " split-a" },
    }, _meta: { "antnest.dev/delivery": { kind: "part", sequence: 3,
      partIndex: 0, partCount: 2, runId: "run-1", messageId: "event-3" } } });
    assert.equal((await (await read(`${base}/view`))?.json()).outputWatermark, 2);
    update({ sessionId: "session-1", update: {
      sessionUpdate: "agent_message_chunk", messageId: "answer-1",
      content: { type: "text", text: " split-b" },
    }, _meta: { "antnest.dev/delivery": { kind: "part", sequence: 3,
      partIndex: 1, partCount: 2, runId: "run-1", messageId: "event-3" } } });
    const splitComplete = await (await read(`${base}/view`))?.json();
    assert.equal(splitComplete.outputWatermark, 3);
    assert.equal(splitComplete.turns[0].finalResponse.map((block: { text: string }) => block.text).join(""),
      "output".repeat(200) + "later split-a split-b");
    const agent = await read("http://localhost/api/app/workspace/v1/agents/agent-1/view?sessionId=session-1");
    assert.equal(agent?.status, 200);
    assert.equal((await agent?.json()).selectedView.historyState, "ready");
    assert.equal((await read(`${base}/turns`))?.status, 200);
    const prompt = await runtime.handle(new Request(`${base}/prompts`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json",
        "Idempotency-Key": "later-intent", "If-Match": previousToken },
      body: JSON.stringify({ intentId: "later-intent", expectedAppendVersion: 1,
        prompt: [{ type: "text", text: "Continue from the complete View" }] }),
    }));
    assert.equal(prompt?.status, 202);
  } finally {
    streamAbort.abort();
    await streamReader?.cancel();
    await runtime.drain(1_000);
  }
});

test("history accounting covers every identity and releases data after owner sweep", async () => {
  const runtime = createWorkspaceRuntime({
    idleMs: 0,
    maxOwners: 3,
    connect: async () => ({
      async readAgentExecutionState() { return { availability: "ready" as const, activeSessionId: null }; },
      async load() { return { cut: { sealedWatermark: 0, appendVersion: 0 } }; },
      async readExecution(sessionId) { return { sessionId, appendVersion: 0,
        outputWatermark: 0, activeRunId: null, recentReceipts: [], configurationRevision: null }; },
      async readIntent() { return { kind: "unknown" as const }; },
      async prompt() {}, async cancel() {}, close() {},
    }),
  });
  const view = (principalId: string) => runtime.handle(new Request(
    "http://localhost/api/app/workspace/v1/agents/agent-1/view?sessionId=session-1",
    { headers: {
      "x-antnest-organization-id": "org-1",
      "x-antnest-principal-id": principalId,
      "x-antnest-agent-id": "agent-1",
    } },
  ));
  assert.equal((await view("user-1"))?.status, 200);
  assert.equal((await view("user-2"))?.status, 200);
  const full = await view("user-3");
  assert.equal(full?.status, 200);
  assert.ok(runtime.metrics().cachedBytes >= 3 * 16_384);
  await runtime.sweep();
  assert.equal(runtime.metrics().cachedBytes, 0);
  assert.equal((await view("user-3"))?.status, 200);
  await runtime.drain(1_000);
});

test("live output retains independent complete histories across owners", async () => {
  const updates = new Map<string, (value: unknown) => void>();
  const runtime = createWorkspaceRuntime({
    maxOwners: 2,
    connect: async (identity, callbacks) => {
      updates.set(identity.principalId, callbacks.update as (value: unknown) => void);
      return {
        async readAgentExecutionState() {
          return { availability: "busy" as const, activeSessionId: "session-1" };
        },
        async load() { return { cut: { sealedWatermark: 0, appendVersion: 1 } }; },
        async readExecution(sessionId) { return { sessionId, appendVersion: 1,
          outputWatermark: 0, activeRunId: "run-1", recentReceipts: [],
          configurationRevision: null }; },
        async readIntent() { return { kind: "unknown" as const }; },
        async prompt() {}, async cancel() {}, close() {},
      };
    },
  });
  const read = async (principalId: string) => {
    const response = await runtime.handle(new Request(
      "http://localhost/api/app/workspace/v1/agents/agent-1/view?sessionId=session-1",
      { headers: {
        "x-antnest-organization-id": "org-1",
        "x-antnest-principal-id": principalId,
        "x-antnest-agent-id": "agent-1",
      } },
    ));
    return { status: response?.status, body: await response?.json() };
  };
  try {
    assert.equal((await read("user-1")).status, 200);
    assert.equal((await read("user-2")).status, 200);
    const counts = new Map([ ["user-1", 0], ["user-2", 0] ]);
    for (let index = 0; index < 16; index++) {
      const principalId = index % 2 === 0 ? "user-1" : "user-2";
      const sequence = (counts.get(principalId) ?? 0) + 1;
      counts.set(principalId, sequence);
      assert.doesNotThrow(() => updates.get(principalId)?.({
        sessionId: "session-1",
        update: { sessionUpdate: "agent_message_chunk", messageId: "answer",
          content: { type: "text", text: "x".repeat(8 * 1024) } },
        _meta: { "antnest.dev/delivery": { kind: "part", sequence,
          partIndex: 0, partCount: 1, runId: "run-1",
          messageId: `event-${sequence}` } },
      }));
      const result = await read(principalId);
      assert.equal(result.status, 200);
      assert.equal(result.body.selectedView.historyState, "ready");
      assert.equal(result.body.selectedView.outputWatermark, sequence);
    }
    for (const id of ["user-1", "user-2"]) {
      const view = (await read(id)).body.selectedView;
      const turn = view.turns[0];
      const blocks = [...turn.finalResponse];
      let cursor = turn.contentCursor;
      while (cursor !== null) {
        const page = await (await runtime.handle(new Request(
          `${base}/turns/${turn.turnId}/content?cursor=${encodeURIComponent(cursor)}`,
          { headers: { "x-antnest-organization-id": "org-1",
            "x-antnest-principal-id": id, "x-antnest-agent-id": "agent-1" } },
        )))!.json();
        if (page.section === "finalResponse") blocks.push(...page.items);
        cursor = page.nextCursor;
      }
      assert.equal(blocks.length, 8);
      assert.ok(blocks.every((block: { text: string }) => block.text === "x".repeat(8 * 1024)));
    }
  } finally {
    await runtime.drain(1_000);
  }
});

test("runtime bootstrap discovers agents without creating an ACP owner", async () => {
  let owners = 0;
  const runtime = createWorkspaceRuntime({
    epoch: () => "epoch-1",
    now: () => 1_700_000_000_000,
    discover: async () => [{
      agent_id: "agent-1", name: "First", lifecycle_state: "created",
      activation_state: "enabled", runtime_state: "available",
    }],
    connect: async () => { owners++; throw new Error("Unexpected ACP connection"); },
  });
  const response = await runtime.handle(new Request(
    "http://localhost/api/app/workspace/v1/bootstrap",
    { headers: {
      "x-antnest-organization-id": "org-1",
      "x-antnest-principal-id": "user-1",
      "x-antnest-administrator": "false", "x-antnest-organization-slug": "ZW5naW5lZXJpbmc", "x-antnest-organization-name": "RW5naW5lZXJpbmc",
    } },
  ));
  assert.equal(response?.status, 200);
  const body = await response?.json();
  assert.equal(body.bridgeEpoch, "epoch-1");
  assert.equal(body.principal.administrator, false);
  assert.equal(body.agents[0].agentId, "agent-1");
  assert.equal(owners, 0);
  await runtime.drain(1_000);
});

test("Agent View projects only negotiated prompt content capabilities", async () => {
  const runtime = createWorkspaceRuntime({
    connect: async () => ({
      capabilities: { promptCapabilities: {
        image: true, audio: false, embeddedContext: true,
        _meta: { private: "hidden" },
      } },
      async readAgentExecutionState() { return { availability: "ready" as const, activeSessionId: null }; },
      async load() { return { cut: { sealedWatermark: 0, appendVersion: 0 } }; },
      async readExecution(sessionId) { return { sessionId, appendVersion: 0, outputWatermark: 0,
        activeRunId: null, recentReceipts: [], configurationRevision: null }; },
      async readIntent() { return { kind: "unknown" as const }; },
      async prompt() {}, async cancel() {}, close() {},
    }),
  });
  const response = await runtime.handle(new Request(
    "http://localhost/api/app/workspace/v1/agents/agent-1/view",
    { headers: {
      "x-antnest-organization-id": "org-1",
      "x-antnest-principal-id": "user-1",
      "x-antnest-agent-id": "agent-1",
    } },
  ));
  assert.equal(response?.status, 200);
  const view = await response?.json();
  assert.deepEqual(view.promptCapabilities, {
    image: true, audio: false, embeddedContext: true,
  });
  await runtime.drain(1_000);
});

test("runtime exposes scoped ACP Session catalog and creation", async () => {
  const calls: string[] = [];
  const runtime = createWorkspaceRuntime({
    connect: async (connectedScope) => ({
      async list(cursor) {
        calls.push(`list:${connectedScope.principalId}:${cursor ?? ""}`);
        return { sessions: [{ sessionId: "session-1", cwd: "/workspace", title: "First" }], nextCursor: "next" };
      },
      async createSession() {
        calls.push(`create:${connectedScope.principalId}`);
        return { sessionId: "session-2" };
      },
      async load() { return { cut: { sealedWatermark: 0, appendVersion: 0 } }; },
      async readExecution(sessionId) { return { sessionId, appendVersion: 0, outputWatermark: 0,
        activeRunId: null, recentReceipts: [], configurationRevision: null }; },
      async readIntent() { return { kind: "unknown" as const }; },
      async prompt() {},
      async cancel() {},
      close() {},
    }),
  });
  const headers = {
    "x-antnest-organization-id": "org-1",
    "x-antnest-principal-id": "user-1",
    "x-antnest-agent-id": "agent-1",
  };
  const catalog = await runtime.handle(new Request(
    "http://localhost/api/app/workspace/v1/agents/agent-1/sessions?cursor=old",
    { headers },
  ));
  assert.equal(catalog?.status, 200);
  assert.equal((await catalog?.json()).items[0].sessionId, "session-1");
  const created = await runtime.handle(new Request(
    "http://localhost/api/app/workspace/v1/agents/agent-1/sessions",
    { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{}" },
  ));
  assert.equal(created?.status, 201);
  assert.deepEqual(await created?.json(), { sessionId: "session-2" });
  assert.deepEqual(calls, ["list:user-1:old", "create:user-1"]);
  await runtime.drain(1_000);
});

test("Agent view checks an active Session while selected history is still loading", async () => {
  let releaseLoad!: () => void;
  const loadGate = new Promise<void>((resolve) => { releaseLoad = resolve; });
  let activeStarted!: () => void;
  const activeRead = new Promise<void>((resolve) => { activeStarted = resolve; });
  const runtime = createWorkspaceRuntime({
    connect: async () => ({
      async readAgentExecutionState() {
        return { availability: "busy" as const, activeSessionId: "session-2" };
      },
      async load() {
        await loadGate;
        return { cut: { sealedWatermark: 0, appendVersion: 1 } };
      },
      async readExecution(sessionId) {
        if (sessionId === "session-2") activeStarted();
        return { sessionId, appendVersion: 1, outputWatermark: 0,
          activeRunId: sessionId === "session-2" ? "run-2" : null,
          recentReceipts: sessionId === "session-2" ? [{
            sessionId, intentId: "intent-2", runId: "run-2", phase: "running" as const,
            appendVersion: 1, outputWatermark: 0, stopReason: null, errorClass: null,
          }] : [], configurationRevision: null };
      },
      async readIntent() { return { kind: "unknown" as const }; },
      async prompt() { return { stopReason: "end_turn" }; },
      async cancel() {},
      close() {},
    }),
  });
  const pending = runtime.handle(new Request(
    "http://localhost/api/app/workspace/v1/agents/agent-1/view?sessionId=session-1",
    { headers: {
      "x-antnest-organization-id": "org-1",
      "x-antnest-principal-id": "user-1",
      "x-antnest-agent-id": "agent-1",
    } },
  ));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      activeRead,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("active Session waited for selected replay")), 500,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    releaseLoad();
  }
  const response = await pending;
  assert.equal(response?.status, 200);
  const view = await response?.json();
  assert.equal(view.selectedView.sessionId, "session-1");
  assert.equal(view.operations[0]?.operationId, "intent-2");
  await runtime.drain(1_000);
});

test("new scopes receive capacity errors while existing SSE owners stay live", async () => {
  const runtime = createWorkspaceRuntime({
    maxOwners: 2,
    connect: async () => ({
      async readAgentExecutionState() {
        return { availability: "ready" as const, activeSessionId: null };
      },
      async load() { return { cut: { sealedWatermark: 0, appendVersion: 0 } }; },
      async readExecution(sessionId) {
        return { sessionId, appendVersion: 0, outputWatermark: 0,
          activeRunId: null, recentReceipts: [], configurationRevision: null };
      },
      async readIntent() { return { kind: "unknown" as const }; },
      async prompt() { return { stopReason: "end_turn" }; },
      async cancel() {},
      close() {},
    }),
  });
  const headers = (principalId: string) => ({
    "x-antnest-organization-id": "org-1",
    "x-antnest-principal-id": principalId,
    "x-antnest-agent-id": "agent-1",
  });
  const events = "http://localhost/api/app/workspace/v1/agents/agent-1/events";
  const first = await runtime.handle(new Request(events, { headers: headers("user-1") }));
  const second = await runtime.handle(new Request(events, { headers: headers("user-2") }));
  try {
    assert.equal(first?.status, 200);
    assert.equal(second?.status, 200);
    const full = await runtime.handle(new Request(
      "http://localhost/api/app/workspace/v1/agents/agent-1/view",
      { headers: headers("user-3") },
    ));
    assert.equal(full?.status, 429);
    assert.equal((await full?.json()).code, "bridge_capacity_exceeded");
    for (const path of [
      `${base}/view`,
      `${base}/turns`,
      `${base}/operations/intent-1`,
      "http://localhost/api/app/workspace/v1/agents/agent-1/events",
    ]) {
      const denied = await runtime.handle(new Request(path, { headers: headers("user-3") }));
      assert.equal(denied?.status, 429, path);
      assert.equal((await denied?.json()).code, "bridge_capacity_exceeded", path);
    }
    await first?.body?.cancel();
    const admitted = await runtime.handle(new Request(
      "http://localhost/api/app/workspace/v1/agents/agent-1/view",
      { headers: headers("user-3") },
    ));
    assert.equal(admitted?.status, 200);
  } finally {
    await first?.body?.cancel().catch(() => {});
    await second?.body?.cancel().catch(() => {});
    await runtime.drain(1_000);
  }
});

test("Agent view exposes an active operation without selecting its Session", async () => {
  let loads = 0;
  const runtime = createWorkspaceRuntime({
    connect: async () => ({
      async load() {
        loads += 1;
        return { cut: { sealedWatermark: 0, appendVersion: 1 } };
      },
      async readAgentExecutionState() {
        return { availability: "busy" as const, activeSessionId: "session-2" };
      },
      async readExecution(sessionId) {
        return {
          sessionId,
          appendVersion: 1,
          outputWatermark: 0,
          activeRunId: "run-2",
          recentReceipts: [{
            sessionId,
            intentId: "intent-2",
            runId: "run-2",
            phase: "running" as const,
            appendVersion: 1,
            outputWatermark: 0,
            stopReason: null, errorClass: null,
          }],
          configurationRevision: null,
        };
      },
      async readIntent() { return { kind: "unknown" as const }; },
      async prompt() { return { stopReason: "end_turn" }; },
      async cancel() {},
      close() {},
    }),
  });
  const response = await runtime.handle(new Request(
    "http://localhost/api/app/workspace/v1/agents/agent-1/view",
    { headers: {
      "x-antnest-organization-id": "org-1",
      "x-antnest-principal-id": "user-1",
      "x-antnest-agent-id": "agent-1",
    } },
  ));
  assert.equal(response?.status, 200);
  const view = await response?.json();
  assert.equal(view.selectedView, null);
  assert.equal(view.activeSessionId, "session-2");
  assert.equal(view.operations[0]?.operationId, "intent-2");
  assert.equal(loads, 0);
  const selected = await runtime.handle(new Request(
    "http://localhost/api/app/workspace/v1/agents/agent-1/view?sessionId=session-1",
    { headers: {
      "x-antnest-organization-id": "org-1",
      "x-antnest-principal-id": "user-1",
      "x-antnest-agent-id": "agent-1",
    } },
  ));
  assert.equal(selected?.status, 200);
  const selectedView = await selected?.json();
  assert.equal(selectedView.selectedView.sessionId, "session-1");
  assert.ok(selectedView.operations.some((operation: { sessionId: string }) =>
    operation.sessionId === "session-2"));
});

test("Agent-only SSE reports a new operation without selecting its Session", async () => {
  let finish!: () => void;
  const completion = new Promise<void>((resolve) => { finish = resolve; });
  const runtime = createWorkspaceRuntime({
    connect: async () => ({
      async readAgentExecutionState() {
        return { availability: "ready" as const, activeSessionId: null };
      },
      async load() { return { cut: { sealedWatermark: 0, appendVersion: 1 } }; },
      async readExecution(sessionId) {
        return { sessionId, appendVersion: 1, outputWatermark: 0,
          activeRunId: null, recentReceipts: [], configurationRevision: null };
      },
      async readIntent() { return { kind: "unknown" as const }; },
      prompt: () => completion,
      async cancel() {},
      close() {},
    }),
  });
  const headers = {
    "x-antnest-organization-id": "org-1",
    "x-antnest-principal-id": "user-1",
    "x-antnest-agent-id": "agent-1",
  };
  const session = await (await runtime.handle(new Request(`${base}/view`, { headers })))?.json();
  const agent = await (await runtime.handle(new Request(
    "http://localhost/api/app/workspace/v1/agents/agent-1/view", { headers },
  )))?.json();
  const abort = new AbortController();
  const stream = await runtime.handle(new Request(
    `http://localhost/api/app/workspace/v1/agents/agent-1/events?cursor=${encodeURIComponent(agent.streamCursor)}`,
    { headers, signal: abort.signal },
  ));
  assert.equal(stream?.status, 200);
  const reader = stream!.body!.getReader();
  const accepted = await runtime.handle(new Request(`${base}/prompts`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json",
      "idempotency-key": "intent-1", "if-match": session.historyToken },
    body: JSON.stringify({ intentId: "intent-1", expectedAppendVersion: 1,
      prompt: [{ type: "text", text: "go" }] }),
  }));
  assert.equal(accepted?.status, 202);
  const frame = new TextDecoder().decode((await Promise.race([
    reader.read(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Agent SSE timed out")), 2000)),
  ])).value);
  const event = expandedEvent(JSON.parse(frame.match(/data: (.+)/u)?.[1] ?? "null"), agent);
  assert.equal(event.type, "delta");
  assert.equal(event.view.selectedView, null);
  assert.equal(event.view.operations[0]?.sessionId, "session-1");
  assert.equal(event.view.operations[0]?.operationId, "intent-1");
  abort.abort();
  await reader.cancel();
  finish();
});

test("upstream Agent watch pushes external state changes into Agent-only SSE", async () => {
  let state = { availability: "ready" as "ready" | "busy", activeSessionId: null as string | null };
  let emit!: (value: typeof state) => void | Promise<void>;
  const runtime = createWorkspaceRuntime({
    connect: async () => ({
      async readAgentExecutionState() { return state; },
      async watchAgentExecutionState(changed, signal) {
        emit = changed;
        await changed(state);
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      },
      async load() { return { cut: { sealedWatermark: 0, appendVersion: 1 } }; },
      async readExecution(sessionId) {
        return { sessionId, appendVersion: 1, outputWatermark: 0,
          activeRunId: null, recentReceipts: [], configurationRevision: null };
      },
      async readIntent() { return { kind: "unknown" as const }; },
      async prompt() { return { stopReason: "end_turn" }; },
      async cancel() {},
      close() {},
    }),
  });
  const headers = {
    "x-antnest-organization-id": "org-1",
    "x-antnest-principal-id": "user-1",
    "x-antnest-agent-id": "agent-1",
  };
  const url = "http://localhost/api/app/workspace/v1/agents/agent-1";
  const view = await (await runtime.handle(new Request(`${url}/view`, { headers })))?.json();
  const abort = new AbortController();
  const response = await runtime.handle(new Request(
    `${url}/events?cursor=${encodeURIComponent(view.streamCursor)}`,
    { headers, signal: abort.signal },
  ));
  assert.equal(response?.status, 200);
  const reader = response!.body!.getReader();
  try {
    state = { availability: "busy", activeSessionId: "session-2" };
    await emit(state);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("External state did not reach SSE")), 2000);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    const frame = new TextDecoder().decode(chunk.value);
    const event = expandedEvent(JSON.parse(frame.match(/data: (.+)/u)?.[1] ?? "null"), view);
    assert.equal(event.type, "delta");
    assert.equal(event.view.availability, "busy");
    assert.equal(event.view.activeSessionId, "session-2");
  } finally {
    abort.abort();
    await reader.cancel();
    await runtime.drain(100);
  }
});

test("runtime binds real owner leases to command routes and durable recovery", async () => {
  const calls: string[] = [];
  const reuse: string[] = [];
  let time = 0;
  const port: AcpBridgePort = {
    async load() {
      calls.push("load");
      return { cut: { sealedWatermark: 0, appendVersion: 3 } };
    },
    async readExecution(sessionId) {
      calls.push("execution");
      return {
        sessionId,
        appendVersion: 3,
        outputWatermark: 0,
        activeRunId: null,
        recentReceipts: [],
        configurationRevision: null,
      };
    },
    async readIntent(sessionId, intentId) {
      calls.push("receipt");
      return {
        kind: "receipt",
        receipt: {
          sessionId,
          intentId,
          runId: "run-1",
          phase: "running",
          appendVersion: 4,
          outputWatermark: 0,
          stopReason: null, errorClass: null,
        },
      };
    },
    async prompt() {
      calls.push("prompt");
      return { stopReason: "end_turn" };
    },
    async cancel() {
      calls.push("cancel");
    },
    close() {
      calls.push("close");
    },
  };
  const key = Buffer.alloc(32, 5);
  const runtime = createWorkspaceRuntime({
    tokenKey: key,
    connect: async () => {
      calls.push("connect");
      return port;
    },
    now: () => time,
    recordLocalIntentReuse: (outcome) => reuse.push(outcome),
    idleMs: 300_000,
    epoch: () => "epoch-1",
    incarnation: () => "incarnation-1",
  });
  const token = new HistoryTokens(key).issue({
    ...scope,
    sessionId: "session-1",
    epoch: "epoch-1",
    incarnation: "incarnation-1",
    appendVersion: 3,
  });
  const headers = {
    "x-antnest-organization-id": scope.organizationId,
    "x-antnest-principal-id": scope.principalId,
    "x-antnest-agent-id": scope.agentId,
  };
  const prompt = await runtime.handle(
    new Request(`${base}/prompts`, {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
        "idempotency-key": "intent-1",
        "if-match": token,
      },
      body: JSON.stringify({
        intentId: "intent-1",
        expectedAppendVersion: 3,
        prompt: [{ type: "text", text: "go" }],
      }),
    }),
  );
  assert.equal(prompt?.status, 202);
  const recovery = await runtime.handle(
    new Request(`${base}/operations/intent-1`, { headers }),
  );
  assert.equal(recovery?.status, 200);
  assert.equal((await recovery?.json()).runId, "run-1");
  assert.equal(calls.filter((call) => call === "connect").length, 1);
  assert.equal(calls.filter((call) => call === "load").length, 1);
  assert.equal(calls.filter((call) => call === "execution").length, 2);
  assert.ok(calls.includes("receipt"));
  const duplicate = await runtime.handle(new Request(`${base}/prompts`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json",
      "idempotency-key": "intent-1", "if-match": token },
    body: JSON.stringify({ intentId: "intent-1", expectedAppendVersion: 3,
      prompt: [{ type: "text", text: "go" }] }),
  }));
  assert.equal(duplicate?.status, 202);
  assert.deepEqual(reuse, ["hit"]);
  await Promise.resolve();
  time = 300_001;
  await runtime.sweep();
  assert.ok(calls.includes("close"));
});

test("runtime aggregates a local uncertain operation until its owner drains", async () => {
  const runtime = createWorkspaceRuntime({
    connect: async () => ({
      async readAgentExecutionState() {
        return { availability: "ready" as const, activeSessionId: null };
      },
      async load() { return { cut: { sealedWatermark: 0, appendVersion: 1 } }; },
      async readExecution(sessionId) { return { sessionId, appendVersion: 1,
        outputWatermark: 0, activeRunId: null, recentReceipts: [],
        configurationRevision: null }; },
      async readIntent() { return { kind: "unknown" as const }; },
      async prompt() {}, async cancel() {}, close() {},
    }),
  });
  const headers = {
    "x-antnest-organization-id": "org-1",
    "x-antnest-principal-id": "user-1",
    "x-antnest-agent-id": "agent-1",
  };
  try {
    const view = await (await runtime.handle(new Request(
      "http://localhost/api/app/workspace/v1/agents/agent-1/view?sessionId=session-1",
      { headers },
    )))?.json();
    const accepted = await runtime.handle(new Request(`${base}/prompts`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json",
        "idempotency-key": "intent-1", "if-match": view.selectedView.historyToken },
      body: JSON.stringify({ intentId: "intent-1", expectedAppendVersion: 1,
        prompt: [{ type: "text", text: "go" }] }),
    }));
    assert.equal(accepted?.status, 202);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runtime.metrics().uncertainOperations, 1);
    assert.ok(runtime.metrics().oldestUncertainMs >= 0);
  } finally {
    await runtime.drain(1_000);
  }
  assert.equal(runtime.metrics().uncertainOperations, 0);
});

test("operation recovery reads durable receipt even when historical replay is unavailable", async () => {
  let loads = 0;
  const runtime = createWorkspaceRuntime({
    connect: async () => ({
      async load() {
        loads += 1;
        throw new Error("history capacity exceeded");
      },
      async readExecution(sessionId) {
        return {
          sessionId,
          appendVersion: 4,
          outputWatermark: 9,
          activeRunId: "run-1",
          recentReceipts: [],
          configurationRevision: null,
        };
      },
      async readIntent(sessionId, intentId) {
        return {
          kind: "receipt",
          receipt: {
            sessionId,
            intentId,
            runId: "run-1",
            phase: "running",
            appendVersion: 4,
            outputWatermark: 9,
            stopReason: null, errorClass: null,
          },
        };
      },
      async prompt() {
        throw new Error("unexpected prompt");
      },
      async cancel() {},
      close() {},
    }),
  });
  const response = await runtime.handle(
    new Request(`${base}/operations/intent-1`, {
      headers: {
        "x-antnest-organization-id": scope.organizationId,
        "x-antnest-principal-id": scope.principalId,
        "x-antnest-agent-id": scope.agentId,
      },
    }),
  );
  assert.equal(response?.status, 200);
  assert.equal((await response?.json()).runId, "run-1");
  assert.equal(loads, 0);
});

test("runtime serves compact turn and content pages from the sealed ACP replay", async () => {
  const runtime = createWorkspaceRuntime({
    tokenKey: Buffer.alloc(32, 8),
    epoch: () => "epoch-1",
    incarnation: () => "incarnation-1",
    connect: async (_scope, callbacks) => ({
      async load(sessionId) {
        await callbacks.update({
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: "answer-1",
            content: { type: "text", text: "complete answer" },
          },
          _meta: {
            "antnest.dev/delivery": {
              kind: "part",
              sequence: 1,
              partIndex: 0,
              partCount: 1,
              runId: "run-1",
              messageId: "event-1",
            },
          },
        });
        return { cut: { sealedWatermark: 1, appendVersion: 1 } };
      },
      async readExecution(sessionId) {
        return {
          sessionId,
          appendVersion: 1,
          outputWatermark: 1,
          activeRunId: null,
          recentReceipts: [],
          configurationRevision: null,
        };
      },
      async readIntent() {
        return { kind: "unknown" };
      },
      async prompt() {
        return { stopReason: "end_turn" };
      },
      async cancel() {},
      close() {},
    }),
  });
  const headers = {
    "x-antnest-organization-id": scope.organizationId,
    "x-antnest-principal-id": scope.principalId,
    "x-antnest-agent-id": scope.agentId,
  };
  const response = await runtime.handle(
    new Request(`${base}/turns`, { headers }),
  );
  assert.equal(response?.status, 200);
  assert.equal((await response?.json()).items[0]?.turnId, "run-1");
  const viewResponse = await runtime.handle(
    new Request(`${base}/view`, { headers }),
  );
  assert.equal(viewResponse?.status, 200);
  const view = await viewResponse?.json();
  assert.equal(view.historyState, "ready");
  assert.equal(view.turns[0]?.turnId, "run-1");
  assert.equal(typeof view.historyToken, "string");
  assert.equal(typeof view.streamCursor, "string");
});

test("SSE resumes the View cut and publishes a live ACP turn without cancelling the owner", async () => {
  let notify: ((input: unknown) => void) | undefined;
  let requestPermission:
    ((input: unknown, signal: AbortSignal) => Promise<unknown>) | undefined;
  let closes = 0;
  let watermark = 0;
  const runtime = createWorkspaceRuntime({
    tokenKey: Buffer.alloc(32, 11),
    epoch: () => "epoch-1",
    incarnation: () => "incarnation-1",
    connect: async (_scope, callbacks) => {
      notify = callbacks.update as (input: unknown) => void;
      requestPermission = callbacks.requestPermission as (
        input: unknown,
        signal: AbortSignal,
      ) => Promise<unknown>;
      return {
        async readAgentExecutionState() {
          return { availability: "ready" as const, activeSessionId: null };
        },
        async load() {
          return { cut: { sealedWatermark: 0, appendVersion: 1 } };
        },
        async readExecution(sessionId) {
          return {
            sessionId,
            appendVersion: 1,
            outputWatermark: watermark,
            activeRunId: null,
            recentReceipts: [],
            configurationRevision: null,
          };
        },
        async readIntent() {
          return { kind: "unknown" };
        },
        async prompt() {
          return { stopReason: "end_turn" };
        },
        async cancel() {},
        close() {
          closes += 1;
        },
      };
    },
  });
  const headers = {
    "x-antnest-organization-id": scope.organizationId,
    "x-antnest-principal-id": scope.principalId,
    "x-antnest-agent-id": scope.agentId,
  };
  const viewResponse = await runtime.handle(
    new Request("http://localhost/api/app/workspace/v1/agents/agent-1/view?sessionId=session-1", { headers }),
  );
  const view = await viewResponse?.json();
  assert.equal(
    (
      await runtime.handle(
        new Request(
          "http://localhost/api/app/workspace/v1/agents/agent-1/events?sessionId=session-1",
        ),
      )
    )?.status,
    401,
  );
  assert.equal(
    (
      await runtime.handle(
        new Request(
          "http://localhost/api/app/workspace/v1/agents/agent-2/events?sessionId=session-1",
          { headers },
        ),
      )
    )?.status,
    403,
  );
  const abort = new AbortController();
  const events = await runtime.handle(
    new Request(
      `http://localhost/api/app/workspace/v1/agents/agent-1/events?sessionId=session-1&cursor=${encodeURIComponent(view.streamCursor)}`,
      { headers, signal: abort.signal },
    ),
  );
  assert.equal(events?.status, 200);
  assert.equal(
    events?.headers.get("content-type"),
    "text/event-stream; charset=utf-8",
  );
  const reader = events!.body!.getReader();
  watermark = 1;
  notify?.({
    sessionId: "session-1",
    update: {
      sessionUpdate: "agent_message_chunk",
      messageId: "answer-1",
      content: { type: "text", text: "live answer" },
    },
    _meta: {
      "antnest.dev/delivery": {
        kind: "part",
        sequence: 1,
        partIndex: 0,
        partCount: 1,
        runId: "run-1",
        messageId: "event-1",
      },
    },
  });
  const chunk = await Promise.race([
    reader.read(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("SSE update timed out")), 2000),
    ),
  ]);
  const frame = new TextDecoder().decode(chunk.value);
  assert.match(frame, /event: delta/u);
  const data = expandedEvent(JSON.parse(frame.match(/data: (.+)/u)?.[1] ?? "null"), view);
  assert.equal(data.view.selectedView.turns[0]?.turnId, "run-1");
  assert.equal(data.view.selectedView.turns[0]?.finalResponse[0]?.text, "live answer");
  const permissionAbort = new AbortController();
  const decision = requestPermission?.(
    {
      sessionId: "session-1",
      toolCall: { toolCallId: "tool-1", title: "Edit" },
      options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }],
    },
    permissionAbort.signal,
  );
  const permissionFrame = new TextDecoder().decode((await reader.read()).value);
  const permissionEvent = expandedEvent(JSON.parse(
    permissionFrame.match(/data: (.+)/u)?.[1] ?? "null",
  ), data.view);
  assert.equal(
    permissionEvent.view.permissions[0]?.toolCall.toolCallId,
    "tool-1",
  );
  assert.ok(permissionEvent.view.selectedView.viewRevision > data.view.selectedView.viewRevision);
  const pending = permissionEvent.view.permissions[0];
  const decisionPath = `http://localhost/api/app/workspace/v1/agents/agent-1/permissions/${pending.permissionId}/decision`;
  const stale = await runtime.handle(
    new Request(decisionPath, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        generation: pending.generation + 1,
        optionId: "yes",
      }),
    }),
  );
  assert.equal(stale?.status, 409);
  // A durable output can be ahead of local replay while the permission request
  // already belongs to this authorized owner.
  watermark = 2;
  const accepted = await runtime.handle(
    new Request(decisionPath, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ generation: pending.generation, optionId: "yes" }),
    }),
  );
  assert.equal(accepted?.status, 200);
  assert.deepEqual((await accepted?.json()).permissions, []);
  assert.deepEqual(await decision, {
    outcome: { outcome: "selected", optionId: "yes" },
  });
  permissionAbort.abort();
  abort.abort();
  await reader.cancel();
  assert.equal(closes, 0);
});

test("prompt acceptance and durable receipt changes appear in View and SSE", async () => {
  let finish!: () => void;
  const completion = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let receipts: Array<{
    intentId: string;
    sessionId: string;
    runId: string;
    phase: "running";
    appendVersion: number;
    outputWatermark: number;
    stopReason: null;
    errorClass: null;
  }> = [];
  const runtime = createWorkspaceRuntime({
    connect: async () => ({
      async readAgentExecutionState() {
        return { availability: "ready" as const, activeSessionId: null };
      },
      async load() {
        return { cut: { sealedWatermark: 0, appendVersion: 1 } };
      },
      async readExecution(sessionId) {
        return {
          sessionId,
          appendVersion: 1,
          outputWatermark: 0,
          activeRunId: null,
          recentReceipts: receipts,
          configurationRevision: null,
        };
      },
      async readIntent() {
        return { kind: "unknown" };
      },
      prompt: () => completion,
      async cancel() {},
      close() {},
    }),
  });
  const headers = {
    "x-antnest-organization-id": "org-1",
    "x-antnest-principal-id": "user-1",
    "x-antnest-agent-id": "agent-1",
  };
  const view = await (
    await runtime.handle(new Request("http://localhost/api/app/workspace/v1/agents/agent-1/view?sessionId=session-1", { headers }))
  )?.json();
  const abort = new AbortController();
  const stream = await runtime.handle(
    new Request(
      `http://localhost/api/app/workspace/v1/agents/agent-1/events?sessionId=session-1&cursor=${encodeURIComponent(view.streamCursor)}`,
      { headers, signal: abort.signal },
    ),
  );
  const reader = stream!.body!.getReader();
  const accepted = await runtime.handle(
    new Request(`${base}/prompts`, {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
        "idempotency-key": "intent-1",
        "if-match": view.selectedView.historyToken,
      },
      body: JSON.stringify({
        intentId: "intent-1",
        expectedAppendVersion: 1,
        prompt: [{ type: "text", text: "go" }],
      }),
    }),
  );
  assert.equal(accepted?.status, 202);
  const bridgeFrame = new TextDecoder().decode((await reader.read()).value);
  const bridgeEvent = expandedEvent(JSON.parse(
    bridgeFrame.match(/data: (.+)/u)?.[1] ?? "null",
  ), view);
  assert.deepEqual(bridgeEvent.view.operations[0], {
    operationId: "intent-1",
    sessionId: "session-1",
    acceptance: "bridge",
    phase: "dispatching",
  });
  receipts = [
    {
      intentId: "intent-1",
      sessionId: "session-1",
      runId: "run-1",
      phase: "running",
      appendVersion: 1,
      outputWatermark: 0,
      stopReason: null, errorClass: null,
    },
  ];
  const durableView = await (
    await runtime.handle(new Request(`${base}/view`, { headers }))
  )?.json();
  assert.equal(durableView.operations[0]?.acceptance, "acp");
  const durableFrame = new TextDecoder().decode((await reader.read()).value);
  const durableEvent = expandedEvent(JSON.parse(
    durableFrame.match(/data: (.+)/u)?.[1] ?? "null",
  ), bridgeEvent.view);
  assert.equal(durableEvent.view.operations[0]?.runId, "run-1");
  abort.abort();
  await reader.cancel();
  finish();
});

test("View atomically exposes replayed Usage and the latest configuration choices", async () => {
  const oldOptions = [
    {
      id: "mode",
      name: "Mode",
      type: "select" as const,
      currentValue: "review",
      options: [{ value: "review", name: "Review" }],
    },
  ];
  const currentOptions = [{ ...oldOptions[0]!, currentValue: "auto" }];
  const runtime = createWorkspaceRuntime({
    connect: async (_scope, callbacks) => ({
      async load(sessionId) {
        await callbacks.update({
          sessionId,
          update: {
            sessionUpdate: "config_option_update",
            configOptions: currentOptions,
          },
          _meta: {
            "antnest.dev/delivery": {
              kind: "part",
              sequence: 1,
              partIndex: 0,
              partCount: 1,
              runId: null,
              messageId: "config-1",
            },
          },
        });
        await callbacks.update({
          sessionId,
          update: {
            sessionUpdate: "usage_update",
            used: 10,
            size: 100,
            cost: { amount: 0.03, currency: "USD" },
          },
          _meta: {
            "antnest.dev/delivery": {
              kind: "part",
              sequence: 2,
              partIndex: 0,
              partCount: 1,
              runId: null,
              messageId: "usage-1",
            },
          },
        });
        return {
          cut: { sealedWatermark: 2, appendVersion: 1 },
          response: { configOptions: oldOptions },
        };
      },
      async readExecution(sessionId) {
        return {
          sessionId,
          appendVersion: 1,
          outputWatermark: 2,
          activeRunId: null,
          recentReceipts: [],
          configurationRevision: null,
        };
      },
      async readIntent() {
        return { kind: "unknown" };
      },
      async prompt() {
        return { stopReason: "end_turn" };
      },
      async cancel() {},
      close() {},
    }),
  });
  const view = await (
    await runtime.handle(
      new Request(`${base}/view`, {
        headers: {
          "x-antnest-organization-id": "org-1",
          "x-antnest-principal-id": "user-1",
          "x-antnest-agent-id": "agent-1",
        },
      }),
    )
  )?.json();
  assert.deepEqual(view.configOptions, currentOptions);
  assert.deepEqual(view.usage, {
    used: 10,
    size: 100,
    cost: { amount: 0.03, currency: "USD" },
  });
  assert.deepEqual(view.turns, []);
});

test("configuration command accepts only a current advertised value and returns the new View", async () => {
  let applied = 0;
  let upstreamRevision: string | null = "a".repeat(64);
  let options = [
    {
      id: "auto",
      name: "Automatic",
      type: "boolean" as const,
      currentValue: true,
    },
  ];
  const runtime = createWorkspaceRuntime({
    epoch: () => "epoch-1",
    incarnation: () => "incarnation-1",
    connect: async () => ({
      async load() {
        return {
          cut: { sealedWatermark: 0, appendVersion: 1 },
          response: { configOptions: options },
        };
      },
      async readExecution(sessionId) {
        return {
          sessionId,
          appendVersion: 1,
          outputWatermark: 0,
          activeRunId: null,
          recentReceipts: [],
          configurationRevision: upstreamRevision,
        };
      },
      async readIntent() {
        return { kind: "unknown" };
      },
      async prompt() {
        return { stopReason: "end_turn" };
      },
      async cancel() {},
      async setConfiguration(_sessionId, configId, value, expectedRevision) {
        applied += 1;
        assert.equal(configId, "auto");
        assert.equal(value, false);
        assert.equal(expectedRevision, "a".repeat(64));
        options = [{ ...options[0]!, currentValue: false }];
        return { configOptions: options };
      },
      close() {},
    }),
  });
  const headers = {
    "x-antnest-organization-id": "org-1",
    "x-antnest-principal-id": "user-1",
    "x-antnest-agent-id": "agent-1",
  };
  const first = await (
    await runtime.handle(new Request(`${base}/view`, { headers }))
  )?.json();
  assert.equal(first.configOptions[0]?.currentValue, true);
  assert.equal(typeof first.configurationToken, "string");
  const body = (value: unknown, expectedConfigurationToken: string) =>
    JSON.stringify({
      configId: "auto",
      value,
      expectedConfigurationToken,
    });
  const post = (payload: string) =>
    runtime.handle(
      new Request(`${base}/configuration`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: payload,
      }),
    );
  assert.equal((await post(body(false, "stale")))?.status, 409);
  assert.equal(
    (await post(body("false", first.configurationToken)))?.status,
    409,
  );
  assert.equal(applied, 0);
  upstreamRevision = null;
  assert.equal((await post(body(false, first.configurationToken)))?.status, 409);
  assert.equal(applied, 0, "A missing producer revision must not issue an ACP write");
  upstreamRevision = "a".repeat(64);
  const response = await post(body(false, first.configurationToken));
  assert.equal(response?.status, 200);
  const updated = await response?.json();
  assert.equal(updated.configOptions[0]?.currentValue, false);
  assert.notEqual(updated.configurationToken, first.configurationToken);
  assert.equal(applied, 1);
  assert.equal(
    (await post(body(false, first.configurationToken)))?.status,
    409,
  );
});

test("runtime sweep keeps a recovered Run alive without observers then retires after its own grace", async () => {
  let now = 0; let active = true; let closes = 0; let cancels = 0;
  const runtime = createWorkspaceRuntime({ now: () => now, idleMs: 300_000,
    connect: async () => ({
      async load() { return { cut: { appendVersion: 1, sealedWatermark: 0 } }; },
      async readExecution(sessionId) { return { sessionId, appendVersion: 1, outputWatermark: 0,
        activeRunId: active ? "run" : null, recentReceipts: [], configurationRevision: null }; },
      async readIntent() { return { kind: "unknown" as const }; }, async prompt() {},
      async cancel() { cancels++; }, close() { closes++; },
    }) });
  const headers = { "x-antnest-organization-id": "org-1", "x-antnest-principal-id": "user-1", "x-antnest-agent-id": "agent-1" };
  try {
    assert.equal((await runtime.handle(new Request(`${base}/view`, { headers })))?.status, 200);
    assert.equal(runtime.metrics().observerLeases, 0);
    assert.equal(runtime.metrics().heldWork, 1);
    now = 900_000; await runtime.sweep(); assert.equal(closes, 0);
    active = false; await runtime.sweep(); assert.equal(runtime.metrics().heldWork, 0);
    now = 1_199_999; await runtime.sweep(); assert.equal(closes, 0);
    now = 1_200_000; await runtime.sweep(); assert.equal(closes, 1);
    assert.equal(runtime.metrics().cachedBytes, 0); assert.equal(cancels, 0);
  } finally { await runtime.drain(100); }
});


test("ordinary Views and sweeps do not fetch learning status; explicit diagnostic reads remain authorized", async () => {
  let reads = 0;
  const runtime = createWorkspaceRuntime({
    connect: async () => ({
      async readAgentExecutionState() { return { availability: "ready" as const, activeSessionId: null }; },
      async readLearningStatus() { reads++; return { agentId: "agent-1", blocked: { reason: "writer_present" as const } }; },
      async load() { return { cut: { sealedWatermark: 0, appendVersion: 0 } }; },
      async readExecution(sessionId) { return { sessionId, appendVersion: 0, outputWatermark: 0, activeRunId: null, recentReceipts: [], configurationRevision: null }; },
      async readIntent() { return { kind: "unknown" as const }; },
      async prompt() {}, async cancel() {}, close() {},
    }),
  });
  const url = "http://localhost/api/app/workspace/v1/agents/agent-1/view";
  const headers = { "x-antnest-organization-id": "org-1", "x-antnest-principal-id": "user-1", "x-antnest-agent-id": "agent-1" };
  try {
    const ordinary = await runtime.handle(new Request(url, { headers }));
    assert.equal((await ordinary?.json()).learningStatus, null);
    await runtime.sweep();
    assert.equal(reads, 0);
    const explicit = await runtime.handle(new Request(`${url}?learningStatus=1`, { headers }));
    assert.equal((await explicit?.json()).learningStatus.blocked.reason, "writer_present");
    assert.equal(reads, 1);
    assert.equal((await runtime.handle(new Request(`${url}?learningStatus=1`)))?.status, 401);
    assert.equal(reads, 1);
  } finally { await runtime.drain(1_000); }
});
