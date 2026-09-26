import assert from "node:assert/strict";
import { test } from "node:test";
import { parseControlCommand, controlCatalogue } from "../src/protocol/workspace-commands.ts";
import { executeControlCommand, type ControlPort } from "../src/commands/execute.ts";
import { AgentAccessRevokedError, SessionNotFoundError } from "../src/adapters/acp-http.ts";

const view = (busy = false): any => ({
  agentId: "agent", availability: busy ? "busy" : "ready", activeSessionId: busy ? "session" : null,
  selectedSessionId: "session", operations: busy ? [{ operationId: "intent", sessionId: "session", runId: "run", phase: "running" }] : [],
  selectedView: { sessionId: "session", title: "Work", historyState: "ready", availableCommands: [],
    configOptions: [{ id: "model", category: "model", name: "Model", type: "select", currentValue: "default",
      options: [{ group: "provider", name: "Provider", options: [{ value: "default", name: "Default" }, { value: "profile:two", name: "Second model" }] }] },
      { id: "mode", category: "mode", name: "Mode", type: "select", currentValue: "auto", options: [{ value: "auto", name: "Auto" }] }],
    usage: { used: 12, size: 100, cost: { amount: 0.25, currency: "USD" } } },
});
function port(current = view()) {
  const calls: unknown[] = [];
  const target: ControlPort = {
    async view(sessionId) { calls.push(["view", sessionId]); return { ...current, selectedSessionId: sessionId,
      selectedView: sessionId === null ? null : { ...current.selectedView, sessionId } }; },
    async sessions(cursor) { calls.push(["sessions", cursor]); return { sessions: [{ sessionId: "session", title: "Work" }], nextCursor: "next" }; },
    async configure(...args) { calls.push(["configure", ...args]); },
    async cancel(...args) { calls.push(["cancel", ...args]); },
    async fork(sessionId) { calls.push(["fork", sessionId]); return { sessionId: "fork" }; },
    forkSupported: true,
  };
  return { calls, target };
}

test("control parsing uses exact tokens, aliases and whole-message arguments", () => {
  assert.deepEqual(parseControlCommand("  /帮助  model "), { name: "help", argument: "model" });
  assert.deepEqual(parseControlCommand("/model Second model"), { name: "model", argument: "Second model" });
  for (const text of ["explain /stop", "/stopper", "/tmp/file", "//stop", "/skill:work"])
    assert.equal(parseControlCommand(text), null, text);
});

test("draft catalogue needs no Session and configuration entries follow current capabilities", () => {
  const draft = controlCatalogue(null, false).map((item) => item.name);
  assert.ok(draft.includes("help") && draft.includes("new") && draft.includes("resume"));
  assert.ok(!draft.includes("model") && !draft.includes("fork") && !draft.includes("stop"));
  const selected = controlCatalogue(view(), true).map((item) => item.name);
  assert.ok(selected.includes("model") && selected.includes("mode") && selected.includes("fork"));
  assert.ok(!selected.includes("thinking"));
});

test("status and help work while busy and never dispatch a mutation", async () => {
  const { calls, target } = port(view(true));
  const status = await executeControlCommand({ text: "/status", sessionId: "session" }, target);
  assert.match(status.text, /busy/);
  const help = await executeControlCommand({ text: "/help", sessionId: "session" }, target);
  assert.match(help.text, /\/stop/);
  assert.ok(calls.every((call: any) => call[0] === "view"));
});

test("new selects a draft without creating a Session or cancelling current work", async () => {
  const { calls, target } = port(view(true));
  const result = await executeControlCommand({ text: "/new", sessionId: "session" }, target);
  assert.deepEqual(result.selection, { sessionId: null });
  assert.deepEqual(calls, [["view", "session"]]);
});

test("configuration uses grouped exact choices and the original CAS token", async () => {
  const { calls, target } = port(view(true));
  const result = await executeControlCommand({ text: "/model Second model", sessionId: "session", expectedConfigurationToken: "observed" }, target);
  assert.equal(result.configurationChanged, true);
  assert.deepEqual(calls.at(-1), ["configure", "session", "model", "profile:two", "observed"]);
  for (const text of ["/model Sec", "/thinking high", "/stop extra", "/new extra", "/unknown"])
    await assert.rejects(executeControlCommand({ text, sessionId: "session" }, target));
  await assert.rejects(executeControlCommand({ text: "/model default", sessionId: "session" }, target), /configuration/i);
});

test("stop preserves the caller's observed Run target and never chooses another Session", async () => {
  const { calls, target } = port(view(true));
  await assert.rejects(executeControlCommand({ text: "/stop", sessionId: "session" }, target), /observed/i);
  await executeControlCommand({ text: "/stop", sessionId: "session", operationId: "intent", expectedRunId: "run" }, target);
  assert.deepEqual(calls.at(-1), ["cancel", "session", "intent", "run"]);
  await assert.rejects(executeControlCommand({ text: "/stop", sessionId: "other", operationId: "intent", expectedRunId: "run" }, target));
});

test("usage keeps missing measurements unknown and lists do not imply a complete directory", async () => {
  const { target } = port();
  const usage = await executeControlCommand({ text: "/usage", sessionId: "session" }, target);
  assert.match(usage.text, /12.*100/s); assert.match(usage.text, /USD.*0.25/);
  const unknown = view(); unknown.selectedView.usage = null;
  assert.match((await executeControlCommand({ text: "/usage", sessionId: "session" }, port(unknown).target)).text, /not reported/i);
  const sessions = await executeControlCommand({ text: "/sessions", sessionId: null }, target);
  assert.match(sessions.text, /\/resume session/); assert.match(sessions.text, /\/sessions next/);
});

test("resume authorizes an exact target and fork requires an idle supported source", async () => {
  const { calls, target } = port();
  assert.deepEqual((await executeControlCommand({ text: "/resume target", sessionId: null }, target)).selection, { sessionId: "target" });
  assert.ok(calls.some((call: any) => call[0] === "view" && call[1] === "target"));
  assert.deepEqual((await executeControlCommand({ text: "/fork", sessionId: "session" }, target)).selection, { sessionId: "fork" });
  const busy = port(view(true));
  await assert.rejects(executeControlCommand({ text: "/fork", sessionId: "session" }, busy.target), /running|busy/i);
  assert.ok(!busy.calls.some((call: any) => call[0] === "fork"));
});

test("all configuration categories preserve their advertised ID and exact value", async () => {
  const current = view();
  current.selectedView.configOptions.push({ id: "effort", category: "thought_level", name: "Thinking", type: "select",
    currentValue: "low", options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] });
  const { calls, target } = port(current);
  assert.equal(controlCatalogue(current, true).length, 11);
  for (const [text, configId, value] of [["/model profile:two", "model", "profile:two"],
    ["/mode Auto", "mode", "auto"], ["/thinking High", "effort", "high"]]) {
    await executeControlCommand({ text, sessionId: "session", expectedConfigurationToken: "original-token" }, target);
    assert.deepEqual(calls.at(-1), ["configure", "session", configId, value, "original-token"]);
  }
  const listing = await executeControlCommand({ text: "/thinking", sessionId: "session" }, target);
  assert.match(listing.text, /\/thinking high — High/);
  const choices = current.selectedView.configOptions[0].options[0].options;
  choices.push({ value: "profile:three", name: "Second model" });
  const writesBefore = calls.filter((call: any) => call[0] === "configure").length;
  await assert.rejects(executeControlCommand({ text: "/model Second model", sessionId: "session", expectedConfigurationToken: "original-token" }, target), /exact choices/);
  assert.equal(calls.filter((call: any) => call[0] === "configure").length, writesBefore);
});

test("help reserves controls and aliases even when a native command has the same name", async () => {
  const current = view();
  current.selectedView.availableCommands = [
    { name: "help", description: "native help must not win" },
    { name: "帮助", description: "native alias must not win" },
    { name: "thinking", description: "unsupported native control must not leak" },
    { name: "skill:review", description: "Review changes", input: { hint: "[path]" } },
  ];
  const { target } = port(current);
  const help = await executeControlCommand({ text: "/帮助", sessionId: "session" }, target);
  assert.match(help.text, /\/skill:review \[path\]/);
  assert.doesNotMatch(help.text, /native|\/thinking/);
  assert.equal((help.text.match(/^\/help /gm) ?? []).length, 1);
  const native = await executeControlCommand({ text: "/help /skill:review", sessionId: "session" }, target);
  assert.equal(native.text, "/skill:review [path] — Review changes");
});

test("every command checks current access before reading data or dispatching a mutation", async () => {
  for (const text of ["/help", "/status", "/usage", "/new", "/sessions", "/resume target", "/fork",
    "/model default", "/mode auto", "/thinking high", "/stop"]) {
    const { target, calls } = port();
    target.view = async () => { throw new AgentAccessRevokedError(); };
    await assert.rejects(executeControlCommand({ text, sessionId: "session", expectedConfigurationToken: "token",
      expectedRunId: "run", operationId: "intent" }, target), AgentAccessRevokedError, text);
    assert.deepEqual(calls, [], text);
  }
  const { target, calls } = port();
  const authorizedView = target.view;
  target.view = async (sessionId) => { if (sessionId === "foreign") throw new SessionNotFoundError(); return authorizedView(sessionId); };
  await assert.rejects(executeControlCommand({ text: "/resume foreign", sessionId: null }, target), SessionNotFoundError);
  assert.deepEqual(calls, [["view", null]]);
});

test("draft and unavailable history cannot dispatch session mutations", async () => {
  for (const text of ["/usage", "/fork", "/stop", "/model default", "/mode auto", "/thinking high"]) {
    const { target, calls } = port();
    await assert.rejects(executeControlCommand({ text, sessionId: null }, target), /conversation/);
    assert.deepEqual(calls, [["view", null]]);
  }
  const blocked = view(); blocked.selectedView.historyState = "blocked";
  const { target, calls } = port(blocked);
  assert.match((await executeControlCommand({ text: "/usage", sessionId: "session" }, target)).text, /Last known usage/);
  for (const text of ["/model", "/mode auto", "/fork"])
    await assert.rejects(executeControlCommand({ text, sessionId: "session", expectedConfigurationToken: "token" }, target), /unavailable|not available/);
  assert.ok(calls.every((call: any) => call[0] === "view"));
  target.forkSupported = false;
  await assert.rejects(executeControlCommand({ text: "/fork", sessionId: "session" }, target), /unavailable/);
});

test("stop refuses terminal and superseded targets without cancelling successor work", async () => {
  for (const phase of ["completed", "failed", "cancelled"]) {
    const current = view(true); current.operations[0].phase = phase;
    current.operations.push({ operationId: "successor-intent", sessionId: "session", runId: "successor-run", phase: "running" });
    const { target, calls } = port(current);
    await assert.rejects(executeControlCommand({ text: "/stop", sessionId: "session", operationId: "intent", expectedRunId: "run" }, target), /no longer available/);
    assert.deepEqual(calls, [["view", "session"]]);
  }
});

test("upstream mutation failures propagate once without automatic retries or a success result", async () => {
  for (const [text, action] of [["/fork", "fork"], ["/model default", "configure"], ["/stop", "cancel"]] as const) {
    const { target } = port(view(action === "cancel"));
    const failure = new Error("upstream response lost"); let attempts = 0;
    target[action] = async () => { attempts++; throw failure; };
    await assert.rejects(executeControlCommand({ text, sessionId: "session", expectedConfigurationToken: "token",
      operationId: "intent", expectedRunId: "run" }, target), (cause: unknown) => cause === failure);
    assert.equal(attempts, 1);
  }
});

test("session lists preserve opaque cursors and resume without arguments only lists", async () => {
  const { calls, target } = port();
  await executeControlCommand({ text: "/sessions cursor:abc_+/=", sessionId: null }, target);
  assert.deepEqual(calls.at(-1), ["sessions", "cursor:abc_+/="]);
  const resumed = await executeControlCommand({ text: "/resume", sessionId: null }, target);
  assert.equal(resumed.selection, undefined);
  assert.deepEqual(calls.at(-1), ["sessions", undefined]);
});
