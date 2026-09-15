import * as acp from "@agentclientprotocol/sdk";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import {
  appendLocalUserPrompt,
  applySessionUpdate,
  applyConfigurationResponse,
  ConversationReplay,
  restoreFailedReplayUsage,
} from "./acp-state";
import { workspaceFromBootstrap } from "./bootstrap";
import { previewWorkspace } from "./preview";
import {
  readWorkspaceRoute,
  selectWorkspaceRoute,
  workspacePath,
} from "./navigation";
import { buildPromptBlocks } from "./prompt";
import { csrfFromCookie } from "./session";
import { PermissionInbox, type PendingPermission } from "./permissions";
import { watchWorkspaceState, type StateListener } from "./workspace-state";
import type {
  Attachment,
  ConnectionStatus,
  Conversation,
  WorkspaceSnapshot,
} from "./types";

const WORKSPACE_CWD = "/workspace";
type PromptOperation = { phase: "preparing" | "sent" | "cancelled" };
export type ConversationPage = {
  conversations: readonly Conversation[];
  hasMore: boolean;
};

export class WorkspaceUnavailableError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "WorkspaceUnavailableError";
  }
}

export type AgentConnectionListener = {
  onPermissions: (requests: PendingPermission[]) => void;
  onConnection: (status: ConnectionStatus, error?: string) => void;
  onConversation: (conversation: Conversation) => void;
};

export interface ConnectedAgent {
  readonly promptCapabilities: acp.PromptCapabilities;
  answerPermission(id: string, optionId: string): boolean;
  setConfiguration(
    sessionID: string,
    configId: string,
    value: string,
  ): Promise<void>;
  readonly conversations: readonly Conversation[];
  loadConversations(): Promise<ConversationPage>;
  createConversation(): Promise<Conversation>;
  loadConversation(sessionID: string): Promise<void>;
  prompt(
    sessionID: string,
    text: string,
    attachments: readonly Attachment[],
    admission?: AbortSignal,
  ): Promise<void>;
  cancel(sessionID: string): Promise<void>;
  close(): void;
}

export interface AgentUIClient {
  loadWorkspace(signal?: AbortSignal): Promise<WorkspaceSnapshot>;
  watchState(agentID: string, listener: StateListener): () => void;
  connectAgent(
    agentID: string,
    listener: AgentConnectionListener,
    signal?: AbortSignal,
  ): Promise<ConnectedAgent>;
  logout(): Promise<void>;
}

class GatewayClient implements AgentUIClient {
  watchState(agentID: string, listener: StateListener): () => void {
    return watchWorkspaceState(agentID, listener);
  }
  async loadWorkspace(signal?: AbortSignal): Promise<WorkspaceSnapshot> {
    const response = await fetch("/api/app/bootstrap", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      signal,
    });
    if (response.status === 401) {
      window.location.assign(
        `/?${new URLSearchParams({ return_to: workspacePath(readWorkspaceRoute(window.location.search)) })}`,
      );
      throw new WorkspaceUnavailableError(
        "Your session has expired.",
        response.status,
      );
    }
    if (!response.ok) {
      throw new WorkspaceUnavailableError(
        response.status === 404 || response.status === 503
          ? "The Agent workspace is not connected to Edge Gateway yet."
          : "The Agent workspace could not be loaded.",
        response.status,
      );
    }
    return selectWorkspaceRoute(
      workspaceFromBootstrap(await response.json()),
      readWorkspaceRoute(window.location.search),
    );
  }

  connectAgent(
    agentID: string,
    listener: AgentConnectionListener,
    signal?: AbortSignal,
  ): Promise<ConnectedAgent> {
    return GatewayAgentConnection.open(agentID, listener, signal);
  }

  async logout(): Promise<void> {
    const csrf = csrfFromCookie(document.cookie);
    const response = await fetch("/api/session", {
      method: "DELETE",
      credentials: "same-origin",
      headers: csrf ? { "X-Antnest-CSRF-Token": csrf } : {},
    });
    if (!response.ok)
      throw new WorkspaceUnavailableError(
        "Your session could not be closed.",
        response.status,
      );
  }
}

class GatewayAgentConnection implements ConnectedAgent {
  private readonly permissions: PermissionInbox;
  private readonly sessions = new Map<string, Conversation>();
  private readonly loading = new Map<string, Promise<void>>();
  private readonly prompting = new Map<string, PromptOperation>();
  private readonly replaying = new Map<string, ConversationReplay>();
  private readonly catalogCursors = new Set<string>();
  private catalogCursor?: string;
  private catalogComplete = false;
  private catalogLoading?: Promise<ConversationPage>;
  private connection?: acp.ClientConnection;
  private capabilities?: acp.AgentCapabilities;
  private intentionallyClosed = false;

  private constructor(
    private readonly agentID: string,
    private readonly listener: AgentConnectionListener,
  ) {
    this.permissions = new PermissionInbox(listener.onPermissions);
  }

  static async open(
    agentID: string,
    listener: AgentConnectionListener,
    signal?: AbortSignal,
  ): Promise<GatewayAgentConnection> {
    signal?.throwIfAborted();
    const connected = new GatewayAgentConnection(agentID, listener);
    const abort = () => connected.close();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await connected.initialize();
      signal?.throwIfAborted();
      return connected;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  get conversations(): readonly Conversation[] {
    return [...this.sessions.values()].sort(
      (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
    );
  }

  get promptCapabilities(): acp.PromptCapabilities {
    return { ...this.capabilities?.promptCapabilities };
  }

  async createConversation(): Promise<Conversation> {
    const response = await this.agent().request(acp.methods.agent.session.new, {
      cwd: WORKSPACE_CWD,
      mcpServers: [],
    });
    const conversation = {
      ...emptyConversation(response.sessionId, this.agentID),
      updatedAt: new Date().toISOString(),
      configOptions: response.configOptions ?? [],
      currentModeId: response.modes?.currentModeId,
    };
    this.publish(conversation);
    return conversation;
  }

  loadConversation(sessionID: string): Promise<void> {
    if (this.prompting.has(sessionID)) return Promise.resolve();
    const current = this.loading.get(sessionID);
    if (current) return current;
    const pending = this.replayConversation(sessionID).finally(() =>
      this.loading.delete(sessionID),
    );
    this.loading.set(sessionID, pending);
    return pending;
  }

  private async replayConversation(sessionID: string): Promise<void> {
    const agent = this.agent();
    const current =
      this.sessions.get(sessionID) ??
      emptyConversation(sessionID, this.agentID);
    const candidate = new ConversationReplay(current);
    this.replaying.set(sessionID, candidate);
    this.publish({ ...current, usageStale: Boolean(current.usage) }, "loading");
    try {
      const response = await agent.request(acp.methods.agent.session.load, {
        sessionId: sessionID,
        cwd: WORKSPACE_CWD,
        mcpServers: [],
      });
      const loaded = applyConfigurationResponse(
        candidate.snapshot(),
        response.configOptions ?? [],
        current.configurationSequence ?? 0,
      );
      this.replaying.delete(sessionID);
      this.publish(this.withCatalogMetadata(loaded));
    } catch (cause) {
      const recovered = restoreFailedReplayUsage(candidate.snapshot(), current);
      this.replaying.delete(sessionID);
      this.publish(
        {
          ...this.withCatalogMetadata(recovered),
          messages: current.messages,
          plan: current.plan,
        },
        "failed",
      );
      throw cause;
    }
  }

  answerPermission(id: string, optionId: string): boolean {
    return this.permissions.answer(id, optionId);
  }

  async setConfiguration(
    sessionID: string,
    configId: string,
    value: string,
  ): Promise<void> {
    const sequence = this.sessions.get(sessionID)?.configurationSequence ?? 0;
    const result = await this.agent().request(
      acp.methods.agent.session.setConfigOption,
      { sessionId: sessionID, configId, value },
    );
    const current = this.sessions.get(sessionID);
    if (current)
      this.publish(
        applyConfigurationResponse(current, result.configOptions, sequence),
      );
  }

  async prompt(
    sessionID: string,
    text: string,
    attachments: readonly Attachment[],
    admission?: AbortSignal,
  ): Promise<void> {
    if (this.loading.has(sessionID))
      throw new Error("Conversation history is still loading.");
    if (this.prompting.has(sessionID))
      throw new Error("An operation is already in progress.");
    const operation: PromptOperation = { phase: "preparing" };
    this.prompting.set(sessionID, operation);
    try {
      await this.sendPrompt(sessionID, text, attachments, operation, admission);
    } finally {
      this.prompting.delete(sessionID);
    }
  }

  private async sendPrompt(
    sessionID: string,
    text: string,
    attachments: readonly Attachment[],
    operation: PromptOperation,
    admission?: AbortSignal,
  ): Promise<void> {
    const prompt = await buildPromptBlocks(
      text,
      attachments,
      this.capabilities?.promptCapabilities,
    );
    if (operation.phase === "cancelled" || this.intentionallyClosed) return;
    if (admission?.aborted)
      throw new Error("Agent status changed before the message was sent.");
    operation.phase = "sent";
    const current =
      this.sessions.get(sessionID) ??
      emptyConversation(sessionID, this.agentID);
    this.publish(appendLocalUserPrompt(current, text, attachments));
    try {
      await this.agent().request(acp.methods.agent.session.prompt, {
        sessionId: sessionID,
        prompt,
      });
    } catch (cause) {
      try {
        if (!this.connection?.signal.aborted && !this.intentionallyClosed)
          await this.replayConversation(sessionID);
      } catch {
        // Preserve the original prompt failure when authoritative replay is unavailable.
      }
      throw cause;
    }
  }

  async cancel(sessionID: string): Promise<void> {
    const operation = this.prompting.get(sessionID);
    if (operation && operation.phase !== "sent") {
      operation.phase = "cancelled";
      return;
    }
    await this.agent().notify(acp.methods.agent.session.cancel, {
      sessionId: sessionID,
    });
  }

  close(): void {
    this.intentionallyClosed = true;
    this.permissions.clear();
    this.connection?.close();
  }

  private async initialize(): Promise<void> {
    this.listener.onConnection("connecting");
    const application = acp
      .client({ name: "antnest-agent-ui" })
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        const replay = this.replaying.get(params.sessionId);
        if (replay) {
          replay.append(params.update);
          return;
        }
        const current =
          this.sessions.get(params.sessionId) ??
          emptyConversation(params.sessionId, this.agentID);
        this.publish(applySessionUpdate(current, params.update));
      })
      .onRequest(
        acp.methods.client.session.requestPermission,
        ({ params, signal }) => this.permissions.request(params, signal),
      );
    const connection = application.connect(
      createWebSocketStream(agentWebSocketURL(this.agentID), {
        cookies: "include",
      }),
    );
    this.connection = connection;
    void connection.closed.then(
      () => {
        this.permissions.clear();
        if (!this.intentionallyClosed)
          this.listener.onConnection("offline", "The Agent connection closed.");
      },
      () => {
        this.permissions.clear();
        if (!this.intentionallyClosed)
          this.listener.onConnection("offline", "The Agent connection closed.");
      },
    );

    try {
      const initialized = await connection.agent.request(
        acp.methods.agent.initialize,
        {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
          clientInfo: {
            name: "antnest-agent-ui",
            title: "Antnest Agent Workspace",
            version: "0.1.0",
          },
        },
      );
      if (initialized.protocolVersion !== acp.PROTOCOL_VERSION) {
        throw new Error(
          `Unsupported ACP protocol version ${initialized.protocolVersion}`,
        );
      }
      this.capabilities = initialized.agentCapabilities;
      this.agent();
      this.listener.onConnection("ready");
    } catch (cause) {
      this.intentionallyClosed = true;
      connection.close(cause);
      const message =
        cause instanceof Error
          ? cause.message
          : "The Agent connection could not be opened.";
      this.listener.onConnection("offline", message);
      throw new WorkspaceUnavailableError(message);
    }
  }

  async loadConversations(): Promise<ConversationPage> {
    this.agent();
    if (this.catalogLoading) return this.catalogLoading;
    if (
      this.catalogComplete ||
      this.capabilities?.sessionCapabilities?.list === undefined
    ) {
      return { conversations: this.conversations, hasMore: false };
    }
    const pending = this.loadCatalogPage().finally(() => {
      this.catalogLoading = undefined;
    });
    this.catalogLoading = pending;
    return pending;
  }

  private async loadCatalogPage(): Promise<ConversationPage> {
    const result = await this.agent().request(acp.methods.agent.session.list, {
      cursor: this.catalogCursor,
    });
    this.agent();
    const cursor = result.nextCursor || undefined;
    if (cursor && this.catalogCursors.has(cursor))
      throw new Error("ACP session pagination repeated a cursor");
    for (const session of result.sessions) {
      const current = this.sessions.get(session.sessionId);
      const metadata = {
        title: session.title?.trim() || "New conversation",
        updatedAt: session.updatedAt ?? new Date(0).toISOString(),
      };
      this.sessions.set(
        session.sessionId,
        current
          ? mergeCatalogMetadata(current, metadata)
          : {
              ...emptyConversation(session.sessionId, this.agentID),
              ...metadata,
              historyState: "loading",
            },
      );
    }
    if (cursor) this.catalogCursors.add(cursor);
    this.catalogCursor = cursor;
    this.catalogComplete = !cursor;
    return {
      conversations: this.conversations,
      hasMore: !this.catalogComplete,
    };
  }

  private withCatalogMetadata(conversation: Conversation): Conversation {
    const latest = this.sessions.get(conversation.id);
    return latest ? mergeCatalogMetadata(conversation, latest) : conversation;
  }

  private publish(
    conversation: Conversation,
    historyState?: Conversation["historyState"],
  ): void {
    const snapshot = { ...conversation, historyState };
    this.sessions.set(conversation.id, snapshot);
    this.listener.onConversation(snapshot);
  }

  private agent(): acp.ClientContext {
    if (
      !this.connection ||
      this.intentionallyClosed ||
      this.connection.signal.aborted
    )
      throw new Error("The Agent connection is closed");
    return this.connection.agent;
  }
}

class PreviewClient implements AgentUIClient {
  watchState(): () => void {
    return () => {};
  }
  async loadWorkspace(): Promise<WorkspaceSnapshot> {
    return selectWorkspaceRoute(
      previewWorkspace(),
      readWorkspaceRoute(window.location.search),
    );
  }

  async connectAgent(): Promise<ConnectedAgent> {
    throw new WorkspaceUnavailableError(
      "Preview workspaces do not open network connections.",
    );
  }

  async logout(): Promise<void> {}
}

function emptyConversation(sessionID: string, agentID: string): Conversation {
  return {
    id: sessionID,
    agentId: agentID,
    title: "New conversation",
    updatedAt: new Date(0).toISOString(),
    messages: [],
  };
}

function mergeCatalogMetadata(
  current: Conversation,
  metadata: Pick<Conversation, "title" | "updatedAt">,
): Conversation {
  if (Date.parse(current.updatedAt) > Date.parse(metadata.updatedAt))
    return current;
  if (
    current.updatedAt === metadata.updatedAt &&
    current.title !== "New conversation"
  )
    return current;
  return { ...current, title: metadata.title, updatedAt: metadata.updatedAt };
}

function agentWebSocketURL(agentID: string): string {
  const target = new URL(
    `/api/app/agents/${encodeURIComponent(agentID)}/v1/acp`,
    window.location.href,
  );
  target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
  return target.toString();
}

export function createAgentUIClient(): AgentUIClient {
  const preview =
    import.meta.env.DEV &&
    new URLSearchParams(window.location.search).get("preview") === "1";
  return preview ? new PreviewClient() : new GatewayClient();
}
