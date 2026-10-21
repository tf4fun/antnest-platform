import { TestRequest as Request } from "./support/auth-fixture.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { createWorkspaceRuntime } from "../src/workspace-runtime.ts";
import { AgentAccessRevokedError, SessionNotFoundError } from "../src/adapters/acp-http.ts";

const requireAcp = createRequire(new URL("../../../../agent-acp-service/package.json", import.meta.url));
const { Ajv2020 } = requireAcp("ajv/dist/2020.js");
const schema = JSON.parse(readFileSync(new URL("../../../../../contracts/agent-ui/workspace-api.schema.json", import.meta.url), "utf8"));
const validate = (name: string) => new Ajv2020({ strict: true, validateFormats: false }).compile({ $schema: schema.$schema, $defs: schema.$defs, $ref: `#/$defs/${name}` });
const validView = validate("agentView"); const validResult = validate("controlCommandResult");
const validStream = validate("streamEvent");
const headers = { "x-antnest-organization-id": "org", "x-antnest-principal-id": "user", "x-antnest-agent-id": "agent", "content-type": "application/json" };
const base = "http://workspace/api/app/workspace/v1/agents/agent";

test("command runtime shares config CAS and targeted cancel while keeping controls out of prompts", async () => {
  let busy = true; let revoked = false; let configRevision = "a".repeat(64);
  let options: any[] = [{ id: "mode", category: "mode", name: "Mode", type: "select", currentValue: "auto", options: [{ value: "auto", name: "Auto" }, { value: "chat", name: "Chat" }] }];
  const mutations: unknown[] = [];
  const receipt = () => ({ intentId: "intent", sessionId: "session", runId: "run", phase: busy ? "running" as const : "cancelled" as const,
    appendVersion: 1, outputWatermark: 0, stopReason: null, errorClass: null });
  const runtime = createWorkspaceRuntime({ connect: async (_scope, callbacks) => ({
    capabilities: { sessionCapabilities: { fork: {} } },
    async load() { return { cut: { appendVersion: 1, sealedWatermark: 0 }, response: { configOptions: options } }; },
    async readExecution(sessionId) { if (revoked) throw new AgentAccessRevokedError();
      return { sessionId, appendVersion: 1, outputWatermark: 0, activeRunId: busy ? "run" : null,
        recentReceipts: sessionId === "session" ? [receipt()] : [], configurationRevision: configRevision }; },
    async readAgentExecutionState() { if (revoked) throw new AgentAccessRevokedError();
      return { availability: busy ? "busy" as const : "ready" as const, activeSessionId: busy ? "session" : null }; },
    async readIntent() { return { kind: "receipt" as const, receipt: receipt() }; },
    async prompt() { mutations.push("prompt"); },
    async cancel(sessionId, expectedRunId) { mutations.push(["cancel", sessionId, expectedRunId]); busy = false; },
    async list() { return { sessions: [{ sessionId: "session", cwd: "/workspace" }] }; },
    async forkSession(sessionId) { mutations.push(["fork", sessionId]); return { sessionId: "fork" }; },
    async setConfiguration(sessionId, configId, value, expectedRevision) {
      assert.equal(expectedRevision, configRevision); mutations.push(["config", sessionId, configId, value]);
      configRevision = "b".repeat(64); options = [{ ...options[0], currentValue: value },
        { id: "thinking_effort", category: "thought_level", name: "Thinking", type: "select", currentValue: "low", options: [{ value: "low", name: "Low" }] }];
      await callbacks.update({ sessionId, update: { sessionUpdate: "config_option_update", configOptions: options } });
      return { configOptions: options };
    }, close() {},
  }) });
  const post = async (text: string, extra = {}) => runtime.handle(new Request(`${base}/commands`, { method: "POST", headers, body: JSON.stringify({ text, sessionId: "session", ...extra }) }));
  const abort = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const initial = await (await runtime.handle(new Request(`${base}/view?sessionId=session`, { headers })))!.json();
    assert.ok(validView(initial), JSON.stringify(validView.errors));
    assert.ok(initial.controlCommands.some((item: any) => item.name === "mode"));
    for (const text of ["/status", "/help", "/usage", "/mode", "/sessions"]) {
      const response = await post(text); assert.equal(response?.status, 200, text);
      assert.ok(validResult(await response!.json()), JSON.stringify(validResult.errors));
    }
    assert.deepEqual(mutations, []);
    const stream = await runtime.handle(new Request(`${base}/events?sessionId=session&cursor=${encodeURIComponent(initial.streamCursor)}`, { headers, signal: abort.signal }));
    assert.equal(stream?.status, 200); reader = stream!.body!.getReader();
    assert.equal((await post("/mode chat", { expectedConfigurationToken: "stale" }))?.status, 409);
    assert.equal((await post("/mode chat", { expectedConfigurationToken: initial.selectedView.configurationToken }))?.status, 200);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const frame = await Promise.race([reader.read(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Missing command catalogue delta")), 2000);
      })]);
      const event = JSON.parse(new TextDecoder().decode(frame.value).match(/data: (.+)/u)![1]!);
      assert.ok(validStream(event), JSON.stringify(validStream.errors));
      assert.ok(event.patch.some((entry: any) => entry.path.startsWith("/controlCommands")));
    } finally { clearTimeout(timer); }
    assert.equal((await post("/stop", { operationId: "intent", expectedRunId: "wrong" }))?.status, 409);
    assert.equal((await post("/stop", { operationId: "intent", expectedRunId: "run" }))?.status, 200);
    assert.equal((await post("/fork"))?.status, 200);
    assert.deepEqual(mutations, [["config", "session", "mode", "chat"], ["cancel", "session", "run"], ["fork", "session"]]);
    revoked = true;
    assert.equal((await post("/help"))?.status, 403);
    assert.equal(mutations.length, 3);
  } finally { abort.abort(); await reader?.cancel(); await runtime.drain(1000); }
});

for (const condition of ["blocked-agent-view", "blocked-learning", "blocked-history", "revoked",
  "missing", "unknown", "wrong-run", "terminal", "revoked-at-intent", "foreign-receipt"] as const) {
  test(`targeted stop bypasses projection while preserving ${condition}`, async () => {
    const gate = Promise.withResolvers<void>();
    const milestone = Promise.withResolvers<string>();
    const calls: string[] = [];
    const cancellations: string[][] = [];
    let active = true;
    const receipt = () => ({ intentId: "intent", sessionId: condition === "foreign-receipt" ? "foreign" : "session",
      runId: "run", phase: condition === "terminal" ? "completed" as const : active ? "running" as const : "cancelled" as const,
      appendVersion: 1, outputWatermark: 0, stopReason: null, errorClass: null });
    const projection = async (name: string) => {
      calls.push(name);
      if (condition === `blocked-${name}`) { milestone.resolve(name); await gate.promise; }
    };
    const runtime = createWorkspaceRuntime({ connect: async () => ({
      async readAgentExecutionState() { await projection("agent-view");
        return { availability: active ? "busy" as const : "ready" as const, activeSessionId: active ? "session" : null }; },
      async readLearningChanges() { await projection("learning");
        return { items: [], nextCursor: "sealed", sealedCursor: "sealed", olderCursor: null }; },
      async load() { await projection("history"); return { cut: { appendVersion: 1, sealedWatermark: 0 } }; },
      async readExecution(sessionId) {
        calls.push("execution");
        if (condition === "revoked") throw new AgentAccessRevokedError();
        if (condition === "missing") throw new SessionNotFoundError();
        return { sessionId, appendVersion: 1, outputWatermark: 0, activeRunId: active ? "run" : null,
          recentReceipts: [], configurationRevision: null };
      },
      async readIntent(sessionId, intentId) {
        calls.push("intent"); assert.equal(sessionId, "session"); assert.equal(intentId, "intent");
        if (condition === "revoked-at-intent") throw new AgentAccessRevokedError();
        return condition === "unknown" ? { kind: "unknown" as const } : { kind: "receipt" as const, receipt: receipt() };
      },
      async cancel(sessionId, runId) { calls.push("cancel"); cancellations.push([sessionId, runId]); active = false; milestone.resolve("cancel"); },
      async prompt() { assert.fail("A control must not dispatch a Prompt"); },
      close() {},
    }) });
    const pending = runtime.handle(new Request(`${base}/commands`, { method: "POST", headers,
      body: JSON.stringify({ text: "/stop", sessionId: "session", operationId: "intent",
        expectedRunId: condition === "wrong-run" ? "wrong" : "run" }) }));
    try {
      const first = await Promise.race([milestone.promise, pending.then(() => "response")]);
      if (condition.startsWith("blocked-")) assert.equal(first, "cancel");
      const response = await pending;
      const expected = condition.startsWith("blocked-") ? 200 : condition.startsWith("revoked") ? 403 : condition === "missing" ? 404 : 409;
      assert.equal(response?.status, expected);
      assert.deepEqual(cancellations, expected === 200 ? [["session", "run"]] : []);
      assert.ok(calls.every((name) => ["execution", "intent", "cancel"].includes(name)), JSON.stringify(calls));
      assert.equal(calls.filter((name) => name === "intent").length, expected === 200 ? 2 : ["revoked", "missing"].includes(condition) ? 0 : 1);
    } finally {
      gate.resolve(); await Promise.allSettled([pending]); active = false; await runtime.sweep();
      assert.equal((await runtime.drain(1000)).forced, false);
    }
  });
}
