import { Bot, LogOut, Menu, Plus, RefreshCw, Settings, WifiOff } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Composer } from "./components/Composer";
import { Conversation } from "./components/Conversation";
import { Sidebar } from "./components/Sidebar";
import { createAgentUIClient, type ConnectedAgent } from "./lib/client";
import { conversationTitle, formatBytes } from "./lib/presentation";
import type { Attachment, Conversation as ConversationModel, Message, WorkspaceSnapshot } from "./lib/types";

function freshID(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function previewResponse(): Message {
  return {
    id: freshID("message"),
    role: "assistant",
    createdAt: new Date().toISOString(),
    content: "I have the message and attachments. The production ACP bridge will replace this development preview response.",
    activities: [
      {
        id: freshID("activity"),
        label: "Inspect request context",
        tool: "read",
        status: "completed",
        summary: "Prepared the development preview response",
        durationMs: 96,
      },
    ],
  };
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.trim() ? cause.message : fallback;
}

function releaseAttachmentPreviews(attachments: readonly Attachment[], tracked: Set<string>): void {
  for (const attachment of attachments) {
    if (!attachment.previewURL) continue;
    URL.revokeObjectURL(attachment.previewURL);
    tracked.delete(attachment.previewURL);
  }
}

export default function App() {
  const client = useMemo(createAgentUIClient, []);
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot>();
  const [error, setError] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [sending, setSending] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [connectionError, setConnectionError] = useState("");
  const previewURLs = useRef(new Set<string>());
  const connection = useRef<ConnectedAgent | undefined>(undefined);
  const selectedConversationID = useRef<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    client.loadWorkspace(controller.signal).then(setWorkspace).catch((cause: unknown) => {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setError(cause instanceof Error ? cause.message : "The Agent workspace could not be loaded.");
    });
    return () => controller.abort();
  }, [client]);

  useEffect(() => () => {
    previewURLs.current.forEach((previewURL) => URL.revokeObjectURL(previewURL));
    previewURLs.current.clear();
  }, []);

  useEffect(() => {
    selectedConversationID.current = workspace?.activeConversationId ?? null;
  }, [workspace?.activeConversationId]);

  useEffect(() => {
    const agentID = workspace?.activeAgentId;
    if (!workspace || workspace.preview || !agentID) return;

    let disposed = false;
    connection.current?.close();
    connection.current = undefined;
    setConnectionError("");
    setWorkspace((current) => current ? { ...current, connection: "connecting" } : current);

    void client.connectAgent(agentID, {
      onConnection: (status, cause) => {
        if (disposed) return;
        setWorkspace((current) => current ? { ...current, connection: status } : current);
        if (cause) setConnectionError(cause);
      },
      onConversation: (conversation) => {
        if (disposed) return;
        setWorkspace((current) => current ? {
          ...current,
          conversations: [
            conversation,
            ...current.conversations.filter(({ id }) => id !== conversation.id),
          ],
        } : current);
      },
    }).then((connected) => {
      if (disposed) {
        connected.close();
        return;
      }
      connection.current = connected;
      const conversations = [...connected.conversations];
      const selected = conversations.some(({ id }) => id === workspace.activeConversationId)
        ? workspace.activeConversationId
        : conversations[0]?.id ?? null;
      setWorkspace((current) => current ? {
        ...current,
        activeConversationId: current.activeAgentId === agentID ? selected : current.activeConversationId,
        conversations: [
          ...conversations,
          ...current.conversations.filter(({ agentId }) => agentId !== agentID),
        ],
      } : current);
      if (selected) {
        void connected.loadConversation(selected).catch((cause: unknown) => {
          if (!disposed) setConnectionError(errorMessage(cause, "Conversation history could not be loaded."));
        });
      }
    }).catch((cause: unknown) => {
      if (!disposed) setConnectionError(errorMessage(cause, "The Agent connection could not be opened."));
    });

    return () => {
      disposed = true;
      connection.current?.close();
      connection.current = undefined;
    };
  }, [client, workspace?.activeAgentId, workspace?.preview]);

  async function logout() {
    if (loggingOut) return;
    setLoggingOut(true);
    setConnectionError("");
    try {
      connection.current?.close();
      await client.logout();
      window.location.assign("/");
    } catch (cause) {
      setConnectionError(errorMessage(cause, "Your session could not be closed."));
      setLoggingOut(false);
    }
  }

  if (error) {
    return (
      <main className="unavailable-page">
        <div className="unavailable-panel">
          <span><WifiOff size={20} aria-hidden="true" /></span>
          <h1>Workspace unavailable</h1>
          <p>{error}</p>
          <button type="button" onClick={() => window.location.reload()}><RefreshCw size={15} /> Retry</button>
        </div>
      </main>
    );
  }

  if (!workspace) return <main className="loading-page"><span className="loading-mark" /><p>Opening workspace</p></main>;

  const activeAgent = workspace.agents.find(({ id }) => id === workspace.activeAgentId) ?? workspace.agents[0];
  if (!activeAgent) {
    return (
      <main className="unavailable-page">
        <div className="unavailable-panel">
          <span><Bot size={20} aria-hidden="true" /></span>
          <h1>No Agent available</h1>
          <p>{workspace.principal.administrator
            ? "Create an Agent or assign one to this account in Control Center."
            : "Your organization has not assigned an Agent to this account yet."}</p>
          {connectionError ? <div className="workspace-alert" role="alert">{connectionError}</div> : null}
          <div className="unavailable-actions">
            {workspace.principal.administrator ? <a href="/"><Settings size={15} /> Control Center</a> : null}
            <button type="button" disabled={loggingOut} onClick={() => { void logout(); }}><LogOut size={15} /> Sign out</button>
          </div>
        </div>
      </main>
    );
  }
  const activeConversation = workspace.conversations.find(({ id }) => id === workspace.activeConversationId);
  const connected = workspace.connection === "ready";
  const preview = workspace.preview;

  function updateWorkspace(update: (current: WorkspaceSnapshot) => WorkspaceSnapshot) {
    setWorkspace((current) => current ? update(current) : current);
  }

  function selectAgent(agentID: string) {
    if (sending) return;
    updateWorkspace((current) => {
      const firstConversation = current.conversations
        .filter(({ agentId }) => agentId === agentID)
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
      return { ...current, activeAgentId: agentID, activeConversationId: firstConversation?.id ?? null };
    });
    setMenuOpen(false);
  }

  async function newConversation() {
    if (!preview && !sending) {
      if (!connection.current || !connected) return;
      try {
        setConnectionError("");
        const conversation = await connection.current.createConversation();
        updateWorkspace((current) => ({ ...current, activeConversationId: conversation.id }));
        setMenuOpen(false);
      } catch (cause) {
        setConnectionError(errorMessage(cause, "A new conversation could not be created."));
      }
      return;
    }
    const conversation: ConversationModel = {
      id: freshID("conversation"),
      agentId: activeAgent.id,
      title: "New conversation",
      updatedAt: new Date().toISOString(),
      messages: [],
    };
    updateWorkspace((current) => ({
      ...current,
      activeConversationId: conversation.id,
      conversations: [conversation, ...current.conversations],
    }));
    setMenuOpen(false);
  }

  function selectConversation(id: string) {
    updateWorkspace((current) => ({ ...current, activeConversationId: id }));
    setMenuOpen(false);
    if (!preview) {
      void connection.current?.loadConversation(id).catch((cause: unknown) => {
        setConnectionError(errorMessage(cause, "Conversation history could not be loaded."));
      });
    }
  }

  function addFiles(files: FileList) {
    const additions = Array.from(files).slice(0, Math.max(0, 6 - attachments.length)).map((file) => {
      const previewURL = file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined;
      if (previewURL) previewURLs.current.add(previewURL);
      return {
        id: freshID("attachment"),
        name: file.name,
        kind: file.type.startsWith("image/") ? "image" as const : "file" as const,
        sizeLabel: formatBytes(file.size),
        previewURL,
        mimeType: file.type,
        file,
      };
    });
    setAttachments((current) => [...current, ...additions]);
  }

  function removeAttachment(id: string) {
    setAttachments((current) => {
      const removed = current.find((attachment) => attachment.id === id);
      if (removed?.previewURL) {
        URL.revokeObjectURL(removed.previewURL);
        previewURLs.current.delete(removed.previewURL);
      }
      return current.filter((attachment) => attachment.id !== id);
    });
  }

  async function submit() {
    if (!workspace || sending || !connected || activeAgent.status !== "ready" || (!draft.trim() && !attachments.length)) return;
    if (!workspace.preview) {
      await submitToAgent();
      return;
    }
    const conversation = activeConversation ?? {
      id: freshID("conversation"),
      agentId: activeAgent.id,
      title: "New conversation",
      updatedAt: new Date().toISOString(),
      messages: [],
    };
    const message: Message = {
      id: freshID("message"),
      role: "user",
      content: draft.trim(),
      createdAt: new Date().toISOString(),
      attachments,
    };
    const updatedConversation = {
      ...conversation,
      title: conversation.messages.length ? conversation.title : conversationTitle(draft || attachments[0]?.name || ""),
      updatedAt: message.createdAt,
      messages: [...conversation.messages, message],
    };
    updateWorkspace((current) => ({
      ...current,
      activeConversationId: conversation.id,
      agents: current.agents.map((agent) => agent.id === activeAgent.id ? { ...agent, status: "busy" } : agent),
      conversations: [updatedConversation, ...current.conversations.filter(({ id }) => id !== conversation.id)],
    }));
    setDraft("");
    setAttachments([]);
    setSending(true);
    window.setTimeout(() => {
      updateWorkspace((current) => ({
        ...current,
        agents: current.agents.map((agent) => agent.id === activeAgent.id ? { ...agent, status: "ready" } : agent),
        conversations: current.conversations.map((item) => item.id === conversation.id
          ? { ...item, updatedAt: new Date().toISOString(), messages: [...item.messages, previewResponse()] }
          : item),
      }));
      setSending(false);
    }, 850);
  }

  async function submitToAgent() {
    const connectedAgent = connection.current;
    if (!connectedAgent) return;
    const submittedText = draft;
    const submittedAttachments = attachments;
    setConnectionError("");
    setSending(true);
    let promptedSessionID: string | undefined;
    updateWorkspace((current) => ({
      ...current,
      agents: current.agents.map((agent) => agent.id === activeAgent.id ? { ...agent, status: "busy" } : agent),
    }));
    try {
      const conversation = activeConversation ?? await connectedAgent.createConversation();
      promptedSessionID = conversation.id;
      if (!activeConversation) {
        updateWorkspace((current) => ({ ...current, activeConversationId: conversation.id }));
      }
      setDraft("");
      setAttachments([]);
      await connectedAgent.prompt(conversation.id, submittedText, submittedAttachments);
      releaseAttachmentPreviews(submittedAttachments, previewURLs.current);
    } catch (cause) {
      setConnectionError(errorMessage(cause, "The message could not be completed."));
      setDraft((current) => current || submittedText);
      setAttachments((current) => current.length ? current : submittedAttachments);
    } finally {
      updateWorkspace((current) => ({
        ...current,
        agents: current.agents.map((agent) => agent.id === activeAgent.id ? { ...agent, status: "ready" } : agent),
      }));
      setSending(false);
      setCancelling(false);
      const selected = selectedConversationID.current;
      if (selected && promptedSessionID && selected !== promptedSessionID) {
        void connectedAgent.loadConversation(selected).catch((cause: unknown) => {
          setConnectionError(errorMessage(cause, "Conversation history could not be loaded."));
        });
      }
    }
  }

  async function cancelRun() {
    if (!activeConversation || !connection.current || cancelling) return;
    setCancelling(true);
    try {
      await connection.current.cancel(activeConversation.id);
    } catch (cause) {
      setConnectionError(errorMessage(cause, "The operation could not be stopped."));
      setCancelling(false);
    }
  }

  return (
    <div className="app-shell">
      {menuOpen ? <button className="mobile-scrim" type="button" aria-label="Close navigation" onClick={() => setMenuOpen(false)} /> : null}
      <Sidebar
        activeAgentId={activeAgent.id}
        activeConversationId={workspace.activeConversationId}
        agentSwitchDisabled={sending}
        agents={workspace.agents}
        conversations={workspace.conversations}
        open={menuOpen}
        principal={workspace.principal}
        onClose={() => setMenuOpen(false)}
        newConversationDisabled={sending || !connected}
        logoutDisabled={loggingOut}
        onNewConversation={() => { void newConversation(); }}
        onLogout={() => { void logout(); }}
        onSelectAgent={selectAgent}
        onSelectConversation={selectConversation}
      />
      <main className="workspace-main">
        <header className="workspace-topbar">
          <button className="icon-button mobile-menu" type="button" onClick={() => setMenuOpen(true)} aria-label="Open navigation">
            <Menu size={18} aria-hidden="true" />
          </button>
          <div className="topbar-agent">
            <div>
              <strong>{activeAgent.name}</strong>
              <small>{activeConversation?.title ?? "New conversation"}</small>
            </div>
            <span className={`presence presence-${activeAgent.status}`}>{activeAgent.status === "ready" ? "Available" : activeAgent.status === "busy" ? "Working" : "Offline"}</span>
          </div>
          <div className="topbar-actions">
            {workspace.preview ? <span className="preview-label">Preview</span> : null}
            <button className="icon-button" type="button" disabled={sending || !connected} onClick={() => { void newConversation(); }} title="New conversation" aria-label="New conversation">
              <Plus size={17} aria-hidden="true" />
            </button>
          </div>
        </header>
        <section className="thread-region">
          <div className="thread-scroll">
            <div className="thread-width">
              <Conversation agent={activeAgent} conversation={activeConversation} />
            </div>
          </div>
          {connectionError ? <div className="workspace-alert" role="alert">{connectionError}</div> : null}
          <Composer
            agentStatus={activeAgent.status}
            attachments={attachments}
            connected={connected}
            cancelling={cancelling}
            sending={sending}
            value={draft}
            onChange={setDraft}
            onFiles={addFiles}
            onRemoveAttachment={removeAttachment}
            onCancel={() => { void cancelRun(); }}
            onSubmit={() => { void submit(); }}
          />
        </section>
      </main>
    </div>
  );
}
