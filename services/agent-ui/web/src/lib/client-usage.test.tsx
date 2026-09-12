import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as acp from "@agentclientprotocol/sdk";
import { createAgentUIClient, type ConnectedAgent, type AgentConnectionListener } from "./client";
import type { Conversation } from "./types";
import App from "../App";
import type { WorkspaceState } from "./workspace-state";

type Request = { id?: number; method: string; params: { sessionId: string } };
const updates = new Map<string, acp.SessionUpdate[]>();
const sockets: FixtureSocket[] = [];
const clients: ConnectedAgent[] = [];
const stateSources: FixtureStateSource[] = [];

class FixtureStateSource extends EventTarget {
  closed = false;
  constructor(readonly url: string) {
    super(); stateSources.push(this);
    const id = url.split("/")[4]!;
    queueMicrotask(() => this.state({ agent_id: id, availability: "ready", access_allowed: true, agent_revision: 1, active_session_id: null }));
  }
  close() { this.closed = true; }
  state(value: WorkspaceState) { if (!this.closed) this.dispatchEvent(new MessageEvent("workspace_state", { data: JSON.stringify(value) })); }
}
let onLoad: (id: string, socket: FixtureSocket) => Promise<object>;
let onPrompt: (id: string, socket: FixtureSocket) => Promise<object>;
let onList: () => Promise<object>;
const priced = (amount: number): acp.SessionUpdate => ({ sessionUpdate: "usage_update", used: 100, size: 1000, cost: { amount, currency: "USD" } });

// Only the WebSocket boundary is synthetic; the production adapter and SDK run unchanged.
class FixtureSocket extends EventTarget {
  readyState = 1;
  requests: Request[] = [];
  constructor(readonly url: string) { super(); sockets.push(this); }
  send(raw: string) {
    const request = JSON.parse(raw) as Request;
    this.requests.push(request);
    void this.respond(request).then(result => { if (request.id !== undefined) this.receive({ jsonrpc: "2.0", id: request.id, result }); },
      () => { if (request.id !== undefined) this.receive({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: "Synthetic request failed" } }); });
  }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event("close")); }
  receive(value: unknown) { if (this.readyState === 1) this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })); }
  update(sessionId: string, update: acp.SessionUpdate) { this.receive({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } }); }
  async respond(request: Request): Promise<object> {
    switch (request.method) {
      case "initialize": return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } } };
      case "session/list": return onList();
      case "session/new": return { sessionId: "new-session" };
      case "session/load": return onLoad(request.params.sessionId, this);
      case "session/prompt": return onPrompt(request.params.sessionId, this);
      case "session/cancel": return {};
      case "session/set_config_option": return { configOptions: [] };
      default: throw new Error(`Unexpected method ${request.method}`);
    }
  }
}

beforeEach(() => {
  sockets.length = 0; updates.clear(); clients.length = 0;
  stateSources.length = 0;
  vi.stubGlobal("WebSocket", FixtureSocket);
  vi.stubGlobal("EventSource", FixtureStateSource);
  onLoad = async (id, socket) => { for (const update of updates.get(id) ?? []) socket.update(id, update); return { configOptions: [] }; };
  onPrompt = async () => ({ stopReason: "end_turn" });
  onList = async () => ({ sessions: ["s1", "s2"].map(sessionId => ({ sessionId, title: `Chat ${sessionId}`, cwd: "/workspace" })) });
});
afterEach(async () => { cleanup(); clients.forEach(client => client.close()); sockets.forEach(socket => socket.close()); await Promise.resolve(); });

async function connect(agent = "agent-1") {
  const snapshots: Conversation[] = [];
  const listener: AgentConnectionListener = { onConnection: vi.fn(), onPermissions: vi.fn(), onConversation: value => snapshots.push(value) };
  const connection = await createAgentUIClient().connectAgent(agent, listener);
  clients.push(connection);
  return { connection, snapshots, listener, socket: sockets.at(-1)!, current: (id = "s1") => connection.conversations.find(c => c.id === id)! };
}

test("official SDK delivers cost snapshots and duplicate replay never accumulates them", async () => {
  const test = await connect();
  expect(test.socket.url).toContain("/api/app/agents/agent-1/acp");
  updates.set("s1", [priced(0.01), priced(0.03), priced(0.03)]);
  await test.connection.loadConversation("s1");
  expect(test.current().usage?.cost?.amount).toBe(0.03);
  await test.connection.loadConversation("s1");
  expect(test.current().usage?.cost?.amount).toBe(0.03);
  test.socket.update("s1", priced(0.04));
  await waitFor(() => expect(test.current().usage?.cost?.amount).toBe(0.04));
  await test.connection.setConfiguration("s1", "model", "another");
  expect(test.current().usage?.cost?.amount).toBe(0.04);
  expect(test.current().messages).toEqual([]);
  expect(sessionStorage.length).toBe(0);
});

test("official SDK replay preserves Session metadata time and does not manufacture message timestamps", async () => {
  const original = "2026-09-01T09:00:00Z";
  onList = async () => ({ sessions: [{ sessionId: "s1", title: "Previous conversation", cwd: "/workspace", updatedAt: original }] });
  const fixture = await connect();
  updates.set("s1", [
    { sessionUpdate: "user_message_chunk", messageId: "old-user", content: { type: "text", text: "Earlier request" } } as acp.SessionUpdate,
    { sessionUpdate: "tool_call", toolCallId: "old-tool", title: "Read file", status: "completed" },
    { sessionUpdate: "agent_message_chunk", messageId: "old-agent", content: { type: "text", text: "Earlier response" } } as acp.SessionUpdate,
  ]);
  for (let i = 0; i < 2; i++) {
    await fixture.connection.loadConversation("s1");
    expect(fixture.current().updatedAt).toBe(original);
    expect(fixture.current().messages).toHaveLength(3);
    expect(fixture.current().messages.every(message => message.createdAt === undefined)).toBe(true);
  }
  fixture.socket.update("s1", { sessionUpdate: "agent_message_chunk", messageId: "live", content: { type: "text", text: "New live response" } } as acp.SessionUpdate);
  await waitFor(() => expect(fixture.current().messages).toHaveLength(4));
  expect(fixture.current().messages.at(-1)?.createdAt).toBeTruthy();
});

test("successful empty or unpriced load clears stale cost rather than reviving the old baseline", async () => {
  const test = await connect();
  for (const history of [[], [{ sessionUpdate: "usage_update", used: 10, size: 1000 } as acp.SessionUpdate]]) {
    updates.set("s1", [priced(0.04)]); await test.connection.loadConversation("s1");
    updates.set("s1", history); await test.connection.loadConversation("s1");
    expect(test.current().usage?.cost).toBeUndefined();
  }
});

test("failed prompt and failed history recovery preserve last received cost", async () => {
  const test = await connect();
  updates.set("s1", [priced(0.01)]); await test.connection.loadConversation("s1");
  onPrompt = async (id, socket) => { socket.update(id, priced(0.02)); throw new Error("prompt interrupted"); };
  onLoad = async () => { throw new Error("history unavailable"); };
  await expect(test.connection.prompt("s1", "hello", [])).rejects.toThrow();
  expect(test.current().usage?.cost?.amount).toBe(0.02);
});

test("overlapping same-session loads share one replay and retain distinct session costs", async () => {
  const test = await connect();
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  onLoad = async (id, socket) => { await pending; socket.update(id, priced(0.03)); return {}; };
  const first = test.connection.loadConversation("s1");
  await waitFor(() => expect(release).toBeTypeOf("function"));
  const second = test.connection.loadConversation("s1");
  await act(async () => { release(); await Promise.all([first, second]); });
  expect(test.socket.requests.filter(r => r.method === "session/load")).toHaveLength(1);
  test.socket.update("s2", priced(0));
  await waitFor(() => expect(test.current("s2").usage?.cost?.amount).toBe(0));
  expect(test.current().usage?.cost?.amount).toBe(0.03);
  const created = await test.connection.createConversation();
  expect(created.usage).toBeUndefined();
});

test("partial failed replay preserves newer context and never overwrites a replayed known cost", async () => {
  const test = await connect();
  for (const cost of [undefined, { amount: 0, currency: "USD" }, { amount: 0.05, currency: "EUR" }]) {
    test.socket.update("s1", priced(0.02));
    await waitFor(() => expect(test.current().usage?.cost?.amount).toBe(0.02));
    onLoad = async (id, socket) => {
      socket.update(id, { sessionUpdate: "usage_update", used: 20, size: 2000, cost });
      throw new Error("Partial history unavailable");
    };
    await expect(test.connection.loadConversation("s1")).rejects.toThrow();
    expect(test.current().usage).toEqual({ used: 20, size: 2000, cost: cost ?? { amount: 0.02, currency: "USD" } });
  }
});

test("failed replay without prior usage does not invent it and a subsequent load can retry", async () => {
  const test = await connect();
  onLoad = async () => { throw new Error("History unavailable"); };
  const failed = await Promise.allSettled([test.connection.loadConversation("s1"), test.connection.loadConversation("s1")]);
  expect(failed.map(result => result.status)).toEqual(["rejected", "rejected"]);
  expect(test.socket.requests.filter(r => r.method === "session/load")).toHaveLength(1);
  expect(test.current().usage).toBeUndefined();
  onLoad = async (id, socket) => { socket.update(id, priced(0)); return {}; };
  await test.connection.loadConversation("s1");
  expect(test.current().usage?.cost?.amount).toBe(0);
});

test("zero context capacity keeps valid cost and freshness is scoped to the replayed Session", async () => {
  const test = await connect();
  test.socket.update("s1", priced(0.02));
  await waitFor(() => expect(test.current().usage?.cost?.amount).toBe(0.02));
  onLoad = async () => { throw new Error("History unavailable"); };
  await expect(test.connection.loadConversation("s1")).rejects.toThrow();
  expect(test.current().usageStale).toBe(true);
  onLoad = async (id, socket) => { socket.update(id, { sessionUpdate: "usage_update", used: 0, size: 0, cost: { amount: 0.03, currency: "USD" } }); return {}; };
  await test.connection.loadConversation("s2");
  expect(test.current("s2").usage?.cost?.amount).toBe(0.03);
  expect(test.current("s2").usageStale).not.toBe(true);
  test.socket.update("s1", priced(0.04));
  await waitFor(() => expect(test.current().usage?.cost?.amount).toBe(0.04));
  expect(test.current().usageStale).not.toBe(true);
});

test("invalid optional cost through the SDK cannot erase a known amount or render metadata", async () => {
  const test = await connect();
  test.socket.update("s1", priced(0.02));
  await waitFor(() => expect(test.current().usage?.cost?.amount).toBe(0.02));
  test.socket.update("s1", { sessionUpdate: "usage_update", used: 200, size: 1000,
    cost: { amount: "bad", currency: "USD", _meta: { private: "secret" } } } as unknown as acp.SessionUpdate);
  await waitFor(() => expect(test.current().usage?.used).toBe(200));
  expect(test.current().usage?.cost?.amount).toBe(0.02);
  expect(JSON.stringify(test.current())).not.toContain("secret");
  test.socket.update("s1", priced(0));
  await waitFor(() => expect(test.current().usage?.cost?.amount).toBe(0));
});

test("a new connection uses replay rather than retaining another Agent's cost", async () => {
  const first = await connect();
  updates.set("s1", [priced(0.02)]); await first.connection.loadConversation("s1");
  first.connection.close();
  updates.clear();
  const next = await connect("agent-2");
  await next.connection.loadConversation("s1");
  expect(next.current().usage).toBeUndefined();
  first.socket.update("s1", priced(1));
  expect(next.current().agentId).toBe("agent-2");
  expect(next.current().usage).toBeUndefined();
});

test("App displays per-session usage, new/unknown states, and disconnect freshness without chat messages", async () => {
  updates.set("s1", [priced(0.03)]);
  updates.set("s2", [{ sessionUpdate: "usage_update", used: 0, size: 1000 }]);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ principal: { user_id: "u1", organization_id: "o1", administrator: false },
    agents: [{ agent_id: "a1", name: "Agent One", availability: "ready" }, { agent_id: "a2", name: "Agent Two", availability: "ready" }] })));
  render(<App />);
  expect(await screen.findByText("USD 0.03")).toBeTruthy();
  expect(screen.getByRole("group", { name: "Session usage" }).textContent).toContain("Known cost");
  expect(document.querySelector(".conversation")?.textContent ?? "").not.toContain("USD 0.03");
  fireEvent.click(screen.getByRole("button", { name: /Chat s2/ }));
  expect(await screen.findByText("Not reported")).toBeTruthy();
  expect(screen.queryByText("USD 0.03")).toBeNull();
  await act(async () => { sockets[0]!.update("s2", priced(0)); });
  expect(await screen.findByText("USD 0")).toBeTruthy();
  await act(async () => { sockets[0]!.close(); });
  expect(await screen.findByText("Last received")).toBeTruthy();
  updates.set("s1", [priced(0.05)]);
  fireEvent.click(screen.getByRole("button", { name: /Agent Two/ }));
  expect(await screen.findByText("USD 0.05")).toBeTruthy();
  expect(screen.queryByText("USD 0")).toBeNull();
  fireEvent.click(screen.getAllByRole("button", { name: "New conversation" })[0]!);
  await waitFor(() => expect(screen.queryByRole("group", { name: "Session usage" })).toBeNull());
});

function appBootstrap() {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ principal: { user_id: "u1", organization_id: "o1", administrator: false },
    agents: [{ agent_id: "a1", name: "Agent One", availability: "ready" }, { agent_id: "a2", name: "Agent Two", availability: "ready" }] })));
}

test("App does not mark fresh usage stale because a different chat failed to load", async () => {
  appBootstrap();
  updates.set("s1", [priced(0.03)]);
  render(<App />);
  await screen.findByText("USD 0.03");
  await act(async () => { sockets[0]!.update("s2", priced(0.01)); });
  onLoad = async (id, socket) => {
    if (id === "s2") throw new Error("History unavailable");
    socket.update(id, priced(0.03)); return {};
  };
  fireEvent.click(screen.getByRole("button", { name: /Chat s2/ }));
  expect(await screen.findByText("Last received")).toBeTruthy();
  expect(screen.getByRole("alert")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Chat s1/ }));
  await screen.findByText("USD 0.03");
  expect(screen.queryByText("Last received")).toBeNull();
  await act(async () => { sockets[0]!.update("s1", priced(0.04)); });
  expect(await screen.findByText("USD 0.04")).toBeTruthy();
  expect(screen.queryByText("Last received")).toBeNull();
});

test("Agent switching disposes pending replay before late same-ID callbacks arrive", async () => {
  appBootstrap();
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  onLoad = async (id, socket) => {
    if (socket.url.includes("/a1/")) await pending;
    socket.update(id, priced(socket.url.includes("/a1/") ? 99 : 0.05)); return {};
  };
  render(<App />);
  await waitFor(() => expect(sockets[0]?.requests.some(r => r.method === "session/load")).toBe(true));
  fireEvent.click(screen.getByRole("button", { name: /Agent Two/ }));
  await screen.findByText("USD 0.05");
  await act(async () => { release(); await pending; });
  expect(screen.queryByText("USD 99")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByText("USD 0.05")).toBeTruthy();
});

test("App keeps input closed until the selected history loads and exposes failed-load retry", async () => {
  appBootstrap();
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  onLoad = async () => { await pending; throw new Error("History unavailable"); };
  render(<App />);
  await waitFor(() => expect(sockets[0]?.requests.some(r => r.method === "session/load")).toBe(true));
  const input = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
  expect(input.disabled).toBe(true);
  await act(async () => release());
  await screen.findByRole("alert");
  expect(input.disabled).toBe(true);
  onLoad = async () => ({});
  fireEvent.click(screen.getByRole("button", { name: "Retry conversation" }));
  await waitFor(() => expect(input.disabled).toBe(false));
  expect(sockets[0]!.requests.filter(r => r.method === "session/prompt")).toHaveLength(0);
});

test("App does not unlock a pending selected history when a previous load finishes", async () => {
  appBootstrap();
  const releases = new Map<string, () => void>();
  onLoad = id => new Promise(resolve => { releases.set(id, () => resolve({})); });
  render(<App />);
  await waitFor(() => expect(releases.has("s1")).toBe(true));
  fireEvent.click(screen.getByRole("button", { name: /Chat s2/ }));
  await waitFor(() => expect(releases.has("s2")).toBe(true));
  await act(async () => releases.get("s1")!());
  expect((screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).disabled).toBe(true);
  await act(async () => releases.get("s2")!());
  await waitFor(() => expect((screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).disabled).toBe(false));
});

const message = (text: string): acp.SessionUpdate => ({ sessionUpdate: "agent_message_chunk", messageId: "reply", content: { type: "text", text } });

test("loading a live Session never replays over its streamed response", async () => {
  const test = await connect();
  let release!: () => void;
  onPrompt = async (id, socket) => {
    socket.update(id, message("Hello"));
    await new Promise<void>(resolve => { release = resolve; });
    socket.update(id, message(" world")); return { stopReason: "end_turn" };
  };
  const pending = test.connection.prompt("s1", "Hi", []);
  await waitFor(() => expect(test.current().messages.at(-1)?.content).toBe("Hello"));
  await Promise.all([test.connection.loadConversation("s1"), test.connection.loadConversation("s1")]);
  expect(test.socket.requests.filter(r => r.method === "session/load")).toHaveLength(0);
  await test.connection.loadConversation("s2");
  release(); await pending;
  expect(test.current().messages.map(m => m.content)).toEqual(["Hi", "Hello world"]);
});

test("a prompt cannot enter while history is loading or another prompt is preparing", async () => {
  const test = await connect();
  let release!: () => void;
  onLoad = () => new Promise(resolve => { release = () => resolve({}); });
  const loading = test.connection.loadConversation("s1");
  await expect(test.connection.prompt("s1", "Too early", [])).rejects.toThrow(/loading/);
  expect(test.current().messages).toEqual([]);
  await waitFor(() => expect(release).toBeTypeOf("function"));
  release(); await loading;
  const first = test.connection.prompt("s1", "Once", []);
  await expect(test.connection.prompt("s1", "Twice", [])).rejects.toThrow(/progress/);
  await first;
  expect(test.socket.requests.filter(r => r.method === "session/prompt")).toHaveLength(1);
});

test("failed replay preserves the complete transcript, while successful replay replaces it", async () => {
  const test = await connect();
  updates.set("s1", [message("Complete history"), { sessionUpdate: "tool_call", toolCallId: "t1", title: "Read", status: "completed", rawOutput: { result: "kept" } }]);
  await test.connection.loadConversation("s1");
  const saved = test.current().messages;
  for (const partial of [false, true]) {
    onLoad = async (id, socket) => { if (partial) socket.update(id, message("Partial")); throw new Error("Unavailable"); };
    await expect(test.connection.loadConversation("s1")).rejects.toThrow();
    expect(test.current().messages).toEqual(saved);
  }
  onLoad = async () => ({});
  await test.connection.loadConversation("s1");
  expect(test.current().messages).toEqual([]);
});

test("failed prompt recovery retains streamed text and releases the prompt guard", async () => {
  const test = await connect();
  onPrompt = async (id, socket) => { socket.update(id, message("Partial answer")); throw new Error("Prompt interrupted"); };
  onLoad = async () => { throw new Error("History unavailable"); };
  await expect(test.connection.prompt("s1", "Question", [])).rejects.toThrow();
  expect(test.current().messages.map(m => m.content)).toEqual(["Question", "Partial answer"]);
  onLoad = async () => ({});
  await test.connection.loadConversation("s1");
  expect(test.current().messages).toEqual([]);
});

test("closing the page during a prompt does not start a new bootstrap request", async () => {
  appBootstrap();
  const view = render(<App />);
  const input = await screen.findByRole("textbox", { name: "Message" });
  await waitFor(() => expect((input as HTMLTextAreaElement).disabled).toBe(false));
  onPrompt = () => new Promise(() => {});
  fireEvent.change(input, { target: { value: "Work" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(sockets[0]!.requests.some(r => r.method === "session/prompt")).toBe(true));
  await act(async () => view.unmount());
  expect(fetch).toHaveBeenCalledTimes(1);
});

test("disconnect retains the transcript and explicit reconnect reads history without resending", async () => {
  appBootstrap();
  updates.set("s1", [message("Saved answer")]);
  render(<App />);
  await screen.findByText("Saved answer");
  await act(async () => sockets[0]!.close());
  expect(screen.getByText("Saved answer")).toBeTruthy();
  expect((screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Refresh workspace" }));
  await waitFor(() => expect(sockets).toHaveLength(2));
  await waitFor(() => expect((screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).disabled).toBe(false));
  expect(screen.getAllByText("Saved answer")).toHaveLength(1);
  expect(sockets.flatMap(socket => socket.requests).filter(r => r.method === "session/prompt")).toHaveLength(0);
});

test("a refreshed access list removes inaccessible Agent history and keeps account exit", async () => {
  appBootstrap();
  updates.set("s1", [message("Private conversation")]);
  render(<App />);
  await screen.findByText("Private conversation");
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ principal: { user_id: "u1", organization_id: "o1", administrator: false }, agents: [] }));
  fireEvent.click(screen.getByRole("button", { name: "Refresh workspace" }));
  await screen.findByText("No Agent available");
  expect(screen.queryByText("Private conversation")).toBeNull();
  expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
  expect(sockets[0]!.readyState).toBe(3);
});

test("stop during attachment preparation prevents a prompt from starting afterward", async () => {
  const test = await connect();
  let release!: (value: ArrayBuffer) => void;
  const file = new File(["text"], "note.txt", { type: "text/plain" });
  file.arrayBuffer = () => new Promise(resolve => { release = resolve; });
  const pending = test.connection.prompt("s1", "Read", [{ id: "a1", name: file.name, kind: "file", sizeLabel: "4 B", file }]);
  await waitFor(() => expect(release).toBeTypeOf("function"));
  await test.connection.cancel("s1");
  release(new TextEncoder().encode("text").buffer);
  await pending;
  expect(test.socket.requests.filter(r => r.method === "session/prompt")).toHaveLength(0);
  expect(test.current().messages).toEqual([]);
});

test("failed replay after reconnect retains the previous connection's transcript", async () => {
  appBootstrap();
  updates.set("s1", [message("Retained answer")]);
  render(<App />);
  await screen.findByText("Retained answer");
  onLoad = async () => { throw new Error("History unavailable"); };
  fireEvent.click(screen.getByRole("button", { name: "Refresh workspace" }));
  await screen.findByRole("button", { name: "Retry conversation" });
  expect(screen.getByText("Retained answer")).toBeTruthy();
  expect((screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).disabled).toBe(true);
});

test("reopened workspace Stop sends standard ACP cancellation for the owned active Session only", async () => {
  appBootstrap();
  render(<App />);
  await waitFor(() => expect((screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).disabled).toBe(false));
  await act(async () => stateSources[0]!.state({ agent_id: "a1", availability: "busy", access_allowed: true, agent_revision: 1, active_session_id: "s1" }));
  fireEvent.click(screen.getByRole("button", { name: /Chat s2/ }));
  fireEvent.click(screen.getByRole("button", { name: "Stop operation" }));
  await waitFor(() => expect(sockets[0]!.requests.filter(r => r.method === "session/cancel").map(r => r.params.sessionId)).toEqual(["s1"]));
  expect((screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).disabled).toBe(true);
  updates.set("s2", [message("Final history")]);
  await act(async () => stateSources[0]!.state({ agent_id: "a1", availability: "ready", access_allowed: true, agent_revision: 1, active_session_id: null }));
  await screen.findByText("Final history");
  expect(sockets.flatMap(s => s.requests).filter(r => r.method === "session/prompt")).toHaveLength(0);
});

test("snapshot recovery reloads history and configuration without replaying a prompt", async () => {
  appBootstrap();
  updates.set("s1", [message("Old history")]);
  render(<App />);
  await screen.findByText("Old history");
  updates.set("s1", [message("New history")]);
  await act(async () => stateSources[0]!.state({ agent_id: "a1", availability: "ready", access_allowed: true, agent_revision: 2, active_session_id: null }));
  await screen.findByText("New history");
  expect(screen.queryByText("Old history")).toBeNull();
  expect(sockets).toHaveLength(2);
  expect(sockets.flatMap(s => s.requests).filter(r => r.method === "session/prompt")).toHaveLength(0);
});

test("ACP disconnection refreshes access and reconnects automatically without repeating work", async () => {
  appBootstrap();
  updates.set("s1", [message("Retained history")]);
  render(<App />);
  await screen.findByText("Retained history");
  await act(async () => sockets[0]!.close());
  expect((screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).disabled).toBe(true);
  await waitFor(() => expect(sockets).toHaveLength(2), { timeout: 2500 });
  await waitFor(() => expect((screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).disabled).toBe(false));
  expect(screen.getAllByText("Retained history")).toHaveLength(1);
  expect(sockets.flatMap(s => s.requests).filter(r => r.method === "session/prompt")).toHaveLength(0);
});

test("invalidated admission during attachment reading prevents a later ACP prompt", async () => {
  const test = await connect();
  let release!: (value: ArrayBuffer) => void;
  const file = new File(["text"], "note.txt", { type: "text/plain" });
  file.arrayBuffer = () => new Promise(resolve => { release = resolve; });
  const admission = new AbortController();
  const pending = test.connection.prompt("s1", "Read", [{ id: "a1", name: file.name, kind: "file", sizeLabel: "4 B", file }], admission.signal);
  const rejected = expect(pending).rejects.toThrow(/status changed/);
  await waitFor(() => expect(release).toBeTypeOf("function"));
  admission.abort();
  release(new TextEncoder().encode("text").buffer);
  await rejected;
  expect(test.socket.requests.filter(r => r.method === "session/prompt")).toHaveLength(0);
});

test("unmount closes a pending authenticated ACP connection before session listing completes", async () => {
  appBootstrap();
  onList = () => new Promise(() => {});
  const view = render(<App />);
  await waitFor(() => expect(sockets[0]?.requests.some(r => r.method === "session/list")).toBe(true));
  await act(async () => view.unmount());
  expect(sockets[0]!.readyState).toBe(3);
});
