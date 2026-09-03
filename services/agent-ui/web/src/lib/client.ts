import * as acp from "@agentclientprotocol/sdk";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import { appendLocalUserPrompt, applySessionUpdate } from "./acp-state";
import { workspaceFromBootstrap } from "./bootstrap";
import { previewWorkspace } from "./preview";
import { buildPromptBlocks } from "./prompt";
import { csrfFromCookie } from "./session";
import type { Attachment, ConnectionStatus, Conversation, WorkspaceSnapshot } from "./types";

const WORKSPACE_CWD = "/workspace";
const MAX_SESSION_PAGES = 100;

export class WorkspaceUnavailableError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "WorkspaceUnavailableError";
  }
}

export type AgentConnectionListener = {
  onConnection: (status: ConnectionStatus, error?: string) => void;
  onConversation: (conversation: Conversation) => void;
};

export interface ConnectedAgent {
  readonly conversations: readonly Conversation[];
  createConversation(): Promise<Conversation>;
  loadConversation(sessionID: string): Promise<void>;
  prompt(sessionID: string, text: string, attachments: readonly Attachment[]): Promise<void>;
  cancel(sessionID: string): Promise<void>;
  close(): void;
}

export interface AgentUIClient {
  loadWorkspace(signal?: AbortSignal): Promise<WorkspaceSnapshot>;
  connectAgent(agentID: string, listener: AgentConnectionListener): Promise<ConnectedAgent>;
  logout(): Promise<void>;
}

class GatewayClient implements AgentUIClient {
  async loadWorkspace(signal?: AbortSignal): Promise<WorkspaceSnapshot> {
    const response = await fetch("/api/app/bootstrap", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      signal,
    });
    if (response.status === 401) {
      window.location.assign("/?return_to=%2Fworkspace%2F");
      throw new WorkspaceUnavailableError("Your session has expired.", response.status);
    }
    if (!response.ok) {
      throw new WorkspaceUnavailableError(
        response.status === 404 || response.status === 503
          ? "The Agent workspace is not connected to Edge Gateway yet."
          : "The Agent workspace could not be loaded.",
        response.status,
      );
    }
    return workspaceFromBootstrap(await response.json());
  }

  connectAgent(agentID: string, listener: AgentConnectionListener): Promise<ConnectedAgent> {
    return GatewayAgentConnection.open(agentID, listener);
  }

  async logout(): Promise<void> {
    const csrf = csrfFromCookie(document.cookie);
    const response = await fetch("/api/session", {
      method: "DELETE",
      credentials: "same-origin",
      headers: csrf ? { "X-Antnest-CSRF-Token": csrf } : {},
    });
    if (!response.ok) throw new WorkspaceUnavailableError("Your session could not be closed.", response.status);
  }
}

class GatewayAgentConnection implements ConnectedAgent {
  private readonly sessions = new Map<string, Conversation>();
  private connection?: acp.ClientConnection;
  private capabilities?: acp.AgentCapabilities;
  private intentionallyClosed = false;

  private constructor(
    private readonly agentID: string,
    private readonly listener: AgentConnectionListener,
  ) {}

  static async open(agentID: string, listener: AgentConnectionListener): Promise<GatewayAgentConnection> {
    const connected = new GatewayAgentConnection(agentID, listener);
    await connected.initialize();
    return connected;
  }

  get conversations(): readonly Conversation[] {
    return [...this.sessions.values()].sort(
      (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
    );
  }

  async createConversation(): Promise<Conversation> {
    const response = await this.agent().request(acp.methods.agent.session.new, {
      cwd: WORKSPACE_CWD,
      mcpServers: [],
    });
    const conversation = emptyConversation(response.sessionId, this.agentID);
    this.publish(conversation);
    return conversation;
  }

  async loadConversation(sessionID: string): Promise<void> {
    const current = this.sessions.get(sessionID) ?? emptyConversation(sessionID, this.agentID);
    this.publish({ ...current, messages: [] });
    await this.agent().request(acp.methods.agent.session.load, {
      sessionId: sessionID,
      cwd: WORKSPACE_CWD,
      mcpServers: [],
    });
  }

  async prompt(sessionID: string, text: string, attachments: readonly Attachment[]): Promise<void> {
    const prompt = await buildPromptBlocks(text, attachments, this.capabilities?.promptCapabilities);
    const current = this.sessions.get(sessionID) ?? emptyConversation(sessionID, this.agentID);
    this.publish(appendLocalUserPrompt(current, text, attachments));
    try {
      await this.agent().request(acp.methods.agent.session.prompt, { sessionId: sessionID, prompt });
    } catch (cause) {
      try {
        await this.loadConversation(sessionID);
      } catch {
        // Preserve the original prompt failure when authoritative replay is unavailable.
      }
      throw cause;
    }
  }

  async cancel(sessionID: string): Promise<void> {
    await this.agent().notify(acp.methods.agent.session.cancel, { sessionId: sessionID });
  }

  close(): void {
    this.intentionallyClosed = true;
    this.connection?.close();
  }

  private async initialize(): Promise<void> {
    this.listener.onConnection("connecting");
    const application = acp
      .client({ name: "antnest-agent-ui" })
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        const current = this.sessions.get(params.sessionId) ?? emptyConversation(params.sessionId, this.agentID);
        this.publish(applySessionUpdate(current, params.update));
      })
      .onRequest(acp.methods.client.session.requestPermission, () => ({
        outcome: { outcome: "cancelled" },
      }));
    const connection = application.connect(createWebSocketStream(agentWebSocketURL(this.agentID), {
      cookies: "include",
    }));
    this.connection = connection;
    void connection.closed.then(
      () => {
        if (!this.intentionallyClosed) this.listener.onConnection("offline", "The Agent connection closed.");
      },
      () => {
        if (!this.intentionallyClosed) this.listener.onConnection("offline", "The Agent connection closed.");
      },
    );

    try {
      const initialized = await connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "antnest-agent-ui", title: "Antnest Agent Workspace", version: "0.1.0" },
      });
      if (initialized.protocolVersion !== acp.PROTOCOL_VERSION) {
        throw new Error(`Unsupported ACP protocol version ${initialized.protocolVersion}`);
      }
      this.capabilities = initialized.agentCapabilities;
      await this.loadSessionList();
      this.listener.onConnection("ready");
    } catch (cause) {
      this.intentionallyClosed = true;
      connection.close(cause);
      const message = cause instanceof Error ? cause.message : "The Agent connection could not be opened.";
      this.listener.onConnection("offline", message);
      throw new WorkspaceUnavailableError(message);
    }
  }

  private async loadSessionList(): Promise<void> {
    if (this.capabilities?.sessionCapabilities?.list === undefined) return;
    let cursor: string | null | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < MAX_SESSION_PAGES; page += 1) {
      const result = await this.agent().request(acp.methods.agent.session.list, { cursor });
      for (const session of result.sessions) {
        this.sessions.set(session.sessionId, {
          id: session.sessionId,
          agentId: this.agentID,
          title: session.title?.trim() || "New conversation",
          updatedAt: session.updatedAt ?? new Date(0).toISOString(),
          messages: [],
        });
      }
      cursor = result.nextCursor;
      if (!cursor) return;
      if (seen.has(cursor)) throw new Error("ACP session pagination repeated a cursor");
      seen.add(cursor);
    }
    throw new Error("ACP session pagination exceeded its safety limit");
  }

  private publish(conversation: Conversation): void {
    this.sessions.set(conversation.id, conversation);
    this.listener.onConversation(conversation);
  }

  private agent(): acp.ClientContext {
    if (!this.connection) throw new Error("The Agent connection is not open");
    return this.connection.agent;
  }
}

class PreviewClient implements AgentUIClient {
  async loadWorkspace(): Promise<WorkspaceSnapshot> {
    return previewWorkspace();
  }

  async connectAgent(): Promise<ConnectedAgent> {
    throw new WorkspaceUnavailableError("Preview workspaces do not open network connections.");
  }

  async logout(): Promise<void> {}
}

function emptyConversation(sessionID: string, agentID: string): Conversation {
  return {
    id: sessionID,
    agentId: agentID,
    title: "New conversation",
    updatedAt: new Date().toISOString(),
    messages: [],
  };
}

function agentWebSocketURL(agentID: string): string {
  const target = new URL(`/api/app/agents/${encodeURIComponent(agentID)}/acp`, window.location.href);
  target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
  return target.toString();
}

export function createAgentUIClient(): AgentUIClient {
  const preview = import.meta.env.DEV && new URLSearchParams(window.location.search).get("preview") === "1";
  return preview ? new PreviewClient() : new GatewayClient();
}
