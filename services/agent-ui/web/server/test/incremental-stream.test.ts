import assert from "node:assert/strict";
import { test } from "node:test";
import type { AcpBridgeCallbacks } from "../src/adapters/acp-http.ts";
import { createWorkspaceRuntime } from "../src/workspace-runtime.ts";
import { applyBridgeEvent, initialBridgeStream } from "../../src/lib/bridge-stream.ts";

const base = "http://localhost/api/app/workspace/v1/agents/agent";
const headers = { "x-antnest-organization-id": "org", "x-antnest-principal-id": "user", "x-antnest-agent-id": "agent" };

test("metadata and normal output publish directly applicable deltas without ACP rereads", async () => {
  let callbacks!: AcpBridgeCallbacks;
  let reads = 0; let loads = 0;
  const runtime = createWorkspaceRuntime({ connect: async (_scope, input) => {
    callbacks = input;
    return {
      async load(sessionId) { loads++; await callbacks.update({ sessionId,
        update: { sessionUpdate: "agent_message_chunk", messageId: "answer", content: { type: "text", text: "a".repeat(12_000) } },
        _meta: { "antnest.dev/delivery": { kind: "part", sequence: 1, partIndex: 0, partCount: 1, runId: "run", messageId: "event-1" } } });
        return { cut: { appendVersion: 1, sealedWatermark: 1 } }; },
      async readAgentExecutionState() { reads++; return { availability: "ready" as const, activeSessionId: null }; },
      async readExecution(sessionId) { reads++; return { sessionId, appendVersion: 1, outputWatermark: 1,
        activeRunId: null, recentReceipts: [], configurationRevision: null }; },
      async readIntent() { return { kind: "unknown" as const }; },
      async prompt() {}, async cancel() {}, close() {},
    };
  } });
  const abort = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const get = (path: string) => runtime.handle(new Request(`${base}${path}`, { headers }));
  try {
    const snapshot = await (await get("/view?sessionId=session"))!.json();
    let state = { ...initialBridgeStream("agent", "session"), view: snapshot };
    const response = await runtime.handle(new Request(`${base}/events?sessionId=session&cursor=${encodeURIComponent(snapshot.streamCursor)}`,
      { headers, signal: abort.signal }));
    reader = response!.body!.getReader();
    const next = async () => {
      const { value } = await reader!.read();
      const text = new TextDecoder().decode(value);
      const raw = JSON.parse(text.match(/data: (.+)/u)![1]!);
      const result = applyBridgeEvent(state, raw);
      assert.equal(result.action, "view"); state = result.state;
      return { raw, text };
    };
    const baseline = reads;
    await callbacks.update({ sessionId: "session", update: { sessionUpdate: "session_info_update", title: "Renamed" } });
    const title = await next();
    assert.equal(title.raw.type, "delta");
    assert.ok(title.text.length < 4000);
    assert.ok(!title.text.includes("a".repeat(100)));
    assert.equal(state.view?.selectedView?.title, "Renamed");
    assert.equal(reads, baseline, "Local projection changes do not requery ACP");
    assert.equal(loads, 1);
    const beforeCommands = reads;
    await callbacks.update({ sessionId: "session", update: {
      sessionUpdate: "available_commands_update",
      availableCommands: [{ name: "help", description: "Help", _meta: { private: "omit" } }],
    } });
    const commands = await next();
    assert.equal(commands.raw.type, "delta");
    assert.deepEqual(state.view?.selectedView?.availableCommands,
      [{ name: "help", description: "Help" }]);
    assert.ok(!commands.text.includes("private"));
    assert.equal(reads, beforeCommands);
    await callbacks.update({ sessionId: "session", update: {
      sessionUpdate: "available_commands_update", availableCommands: [],
    } });
    await next();
    assert.deepEqual(state.view?.selectedView?.availableCommands, []);
    assert.equal(reads, beforeCommands);
    const previous = state.view!.streamCursor;
    await callbacks.update({ sessionId: "session", update: { sessionUpdate: "session_info_update", title: "Renamed" } });
    await new Promise((resolve) => setImmediate(resolve));
    // A fresh authorized HTTP read may query ACP but must not publish an unchanged snapshot.
    const same = await (await get("/view?sessionId=session"))!.json();
    assert.equal(same.streamCursor, previous);
    const beforeOutput = reads;
    await callbacks.update({ sessionId: "session",
      update: { sessionUpdate: "agent_message_chunk", messageId: "answer", content: { type: "text", text: "continued" } },
      _meta: { "antnest.dev/delivery": { kind: "part", sequence: 2, partIndex: 0, partCount: 1, runId: "run", messageId: "event-2" } } });
    const output = await next();
    assert.equal(output.raw.type, "delta");
    assert.ok(output.text.length < 4000);
    assert.equal(state.view?.selectedView?.outputWatermark, 2);
    assert.equal(state.view?.selectedView?.turns[0]?.finalResponse[1]?.text, "continued");
    assert.equal(reads, beforeOutput);
  } finally { abort.abort(); await reader?.cancel(); await runtime.drain(100); }
});
