import { Bot, LogOut, Menu, Plus, RefreshCw, Settings, WifiOff } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Composer } from "./components/Composer";
import { Conversation } from "./components/Conversation";
import { Sidebar } from "./components/Sidebar";
import { PermissionRequests } from "./components/PermissionRequests";
import { SessionSettings } from "./components/SessionSettings";
import { SessionUsage } from "./components/SessionUsage";
import type { PendingPermission } from "./lib/permissions";
import { createAgentUIClient, type ConnectedAgent } from "./lib/client";
import { conversationTitle, formatBytes } from "./lib/presentation";
import { attachmentAccept, describeAttachment, validateAttachmentCount } from "./lib/attachments";
import { useConversationHistory } from "./lib/use-conversation-history";
import { mergeConversationHistory } from "./lib/conversation-history";
import { useWorkspaceState } from "./lib/use-workspace-state";
import type { WorkspaceState } from "./lib/workspace-state";
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
  const [permissions, setPermissions] = useState<PendingPermission[]>([]);
  const [configuring, setConfiguring] = useState(false);
  const previewURLs = useRef(new Set<string>());
  const [inFlightAttachments, setInFlightAttachments] = useState<readonly Attachment[]>([]);
  const [connection, setConnection] = useState<ConnectedAgent>();
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [activePrompt, setActivePrompt] = useState<{ connection: ConnectedAgent; sessionID: string }>();
  const refreshRequest = useRef<AbortController | undefined>(undefined);
  const mounted = useRef(false);
  const disposeConnection = useRef(() => {});
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const [recoverHistory, setRecoverHistory] = useState(false);
  const previousState = useRef<WorkspaceState | undefined>(undefined);
  const accessEpoch = useRef(0);
  const preparation = useRef<AbortController | undefined>(undefined);
  const reconnectFailures = useRef(0);
  const observation = useWorkspaceState(client, workspace?.preview ? undefined : workspace?.activeAgentId || undefined, acceptBootstrap);
  const history = useConversationHistory(connection, workspace?.activeConversationId ?? null);
  useEffect(() => { setCancelling(false); }, [observation.subscription, connection]);

  function acceptBootstrap(latest: WorkspaceSnapshot, reconnect = false) {
    const current = workspaceRef.current;
    if (!current) return;
    const changedIdentity = current.principal.userId !== latest.principal.userId || current.principal.organizationId !== latest.principal.organizationId;
    const visible = new Set(latest.agents.map(agent => agent.id));
    const lostAccess = !visible.has(current.activeAgentId);
    if (changedIdentity || lostAccess) {
      accessEpoch.current++;
      disposeConnection.current();
      setConnection(undefined);
      setPermissions([]);
      setDraft("");
      setAttachments([]);
      setActivePrompt(undefined);
      setCancelling(false);
      setSending(false);
      setInFlightAttachments([]);
      setConnectionAttempt(value => value + 1);
    } else if (reconnect && current.connection === "offline") {
      setConnectionAttempt(value => value + 1);
    } else if (reconnect) setRecoverHistory(true);
    const activeAgentId = !changedIdentity && visible.has(current.activeAgentId) ? current.activeAgentId : latest.activeAgentId;
    setWorkspace({ ...current, principal: latest.principal, agents: latest.agents, activeAgentId,
      activeConversationId: !changedIdentity && activeAgentId === current.activeAgentId ? current.activeConversationId : null,
      conversations: changedIdentity ? [] : current.conversations.filter(conversation => visible.has(conversation.agentId)) });
  }

  useEffect(() => {
    const state = observation.state;
    if (!state?.access_allowed || state.availability !== "ready") preparation.current?.abort();
    if (!state) return;
    const previous = previousState.current;
    previousState.current = state;
    if (!state.access_allowed) {
      accessEpoch.current++;
      disposeConnection.current();
      setConnection(undefined);
      setPermissions([]);
      setDraft("");
      setAttachments([]);
      setActivePrompt(undefined);
      setCancelling(false);
      setSending(false);
      setInFlightAttachments([]);
      setWorkspace(current => {
        if (!current || current.activeAgentId !== state.agent_id) return current;
        const agents = current.agents.filter(agent => agent.id !== state.agent_id);
        return { ...current, agents, activeAgentId: agents[0]?.id ?? "", activeConversationId: null,
          conversations: current.conversations.filter(conversation => conversation.agentId !== state.agent_id), connection: "offline" };
      });
      return;
    }
    if (previous?.agent_id === state.agent_id && (previous.agent_revision !== state.agent_revision ||
      (previous.availability !== "ready" && state.availability === "ready"))) setRecoverHistory(true);
    if (!state.active_session_id || previous?.active_session_id !== state.active_session_id) setCancelling(false);
  }, [observation.state]);

  useEffect(() => {
    if (!recoverHistory || sending || observation.state?.availability !== "ready") return;
    setRecoverHistory(false);
    disposeConnection.current();
    setConnection(undefined);
    setPermissions([]);
    setConnectionAttempt(value => value + 1);
  }, [recoverHistory, sending, observation.state]);

  useEffect(() => {
    if (workspace?.connection === "ready") reconnectFailures.current = 0;
    if (!workspace || workspace.preview || !workspace.activeAgentId || workspace.connection !== "offline" || sending || refreshing || loggingOut) return;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(reconnectFailures.current++, 5));
    const timer = setTimeout(() => { void refreshWorkspace(); }, delay);
    return () => clearTimeout(timer);
  }, [workspace?.connection, workspace?.activeAgentId, workspace?.preview, sending, refreshing, loggingOut]);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    client.loadWorkspace(controller.signal).then(setWorkspace).catch((cause: unknown) => {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setError(cause instanceof Error ? cause.message : "The Agent workspace could not be loaded.");
    });
    return () => { mounted.current = false; controller.abort(); };
  }, [client]);

  useEffect(() => () => {
    refreshRequest.current?.abort();
    previewURLs.current.forEach((previewURL) => URL.revokeObjectURL(previewURL));
    previewURLs.current.clear();
  }, []);

  const previewSnapshot = useMemo(() => {
    const history = workspace?.conversations.flatMap(conversation =>
      conversation.messages.flatMap(message => message.attachments ?? [])) ?? [];
    return {
      candidates: [...previewURLs.current],
      referenced: new Set([...attachments, ...inFlightAttachments, ...history].map(attachment => attachment.previewURL)),
    };
  }, [attachments, inFlightAttachments, workspace?.conversations]);

  useEffect(() => {
    for (const url of previewSnapshot.candidates) {
      if (previewSnapshot.referenced.has(url) || !previewURLs.current.delete(url)) continue;
      URL.revokeObjectURL(url);
    }
  }, [previewSnapshot]);

  useEffect(() => {
    const agentID = workspace?.activeAgentId;
    if (!workspace || workspace.preview || !agentID) return;

    let disposed = false;
    const opening = new AbortController();
    let ownedConnection: ConnectedAgent | undefined;
    const dispose = () => { disposed = true; opening.abort(); ownedConnection?.close(); };
    disposeConnection.current = dispose;
    setConnection(undefined);
    setConnectionError("");
    setPermissions([]);
    setWorkspace((current) => current ? { ...current, connection: "connecting" } : current);

    void client.connectAgent(agentID, {
      onPermissions: (requests) => { if (!disposed) setPermissions(requests); },
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
            mergeConversationHistory(current.conversations.find(({ id, agentId }) => id === conversation.id && agentId === conversation.agentId), conversation),
            ...current.conversations.filter(({ id, agentId }) => id !== conversation.id || agentId !== conversation.agentId),
          ],
        } : current);
      },
    }, opening.signal).then((connected) => {
      if (disposed) {
        connected.close();
        return;
      }
      ownedConnection = connected;
      setConnection(connected);
      const conversations = [...connected.conversations];
      setWorkspace((current) => {
        if (!current) return current;
        const selected = conversations.some(({ id }) => id === current.activeConversationId)
          ? current.activeConversationId : conversations[0]?.id ?? null;
        return { ...current,
          activeConversationId: current.activeAgentId === agentID ? selected : current.activeConversationId,
          conversations: [
            ...conversations.map(incoming => mergeConversationHistory(current.conversations.find(cached => cached.id === incoming.id && cached.agentId === incoming.agentId), { ...incoming, historyState: "loading" })),
            ...current.conversations.filter(({ agentId }) => agentId !== agentID),
          ],
        };
      });
    }).catch((cause: unknown) => {
      if (!disposed) setConnectionError(errorMessage(cause, "The Agent connection could not be opened."));
    });

    return dispose;
  }, [client, workspace?.activeAgentId, workspace?.preview, connectionAttempt]);

  async function refreshAvailability() {
    if (!mounted.current) return;
    refreshRequest.current?.abort();
    const request = new AbortController();
    refreshRequest.current = request;
    const latest = await client.loadWorkspace(request.signal);
    if (!request.signal.aborted && mounted.current) acceptBootstrap(latest);
  }

  async function refreshWorkspace() {
    if (sending || refreshing) return;
    setRefreshing(true);
    setConnectionError("");
    disposeConnection.current();
    setPermissions([]);
    setConnection(undefined);
    setWorkspace(current => current ? { ...current, connection: "offline" } : current);
    try {
      await refreshAvailability();
      observation.refresh(false);
      setConnectionAttempt(current => current + 1);
    } catch (cause) {
      setConnectionError(errorMessage(cause, "Workspace status could not be refreshed."));
    } finally { setRefreshing(false); }
  }

  async function logout() {
    if (loggingOut) return;
    setLoggingOut(true);
    setConnectionError("");
    try {
      connection?.close();
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

  const listedAgent = workspace.agents.find(({ id }) => id === workspace.activeAgentId) ?? workspace.agents[0];
  if (!listedAgent) {
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
  const activeAgent = workspace.preview ? listedAgent : { ...listedAgent, status: observation.state?.availability ?? "unknown" as const };
  const stateReady = workspace.preview || observation.state?.access_allowed === true;
  const activeConversation = workspace.conversations.find(({ id, agentId }) => id === workspace.activeConversationId && agentId === activeAgent.id);
  const connected = workspace.connection === "ready" && (workspace.preview || Boolean(connection)) && !refreshing;
  const conversationReady = workspace.preview || (history.ready && !recoverHistory);
  const preview = workspace.preview;
  const promptCapabilities = preview ? { image: true, audio: true, embeddedContext: true } : connection?.promptCapabilities;

  async function setConfiguration(id: string, value: string) {
    if (!activeConversation || !connection || !conversationReady || !connected || !stateReady || activeAgent.status !== "ready" || sending || configuring) return;
    setConfiguring(true);
    setConnectionError("");
    try { await connection.setConfiguration(activeConversation.id, id, value); }
    catch (cause) { setConnectionError(errorMessage(cause, "Session configuration could not be changed.")); }
    finally { setConfiguring(false); }
  }

  function updateWorkspace(update: (current: WorkspaceSnapshot) => WorkspaceSnapshot) {
    setWorkspace((current) => current ? update(current) : current);
  }

  function selectAgent(agentID: string) {
    if (sending || refreshing) return;
    if (agentID === workspace?.activeAgentId) { setMenuOpen(false); return; }
    updateWorkspace((current) => {
      const firstConversation = current.conversations
        .filter(({ agentId }) => agentId === agentID)
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
      return { ...current, connection: current.preview ? "ready" : "connecting", activeAgentId: agentID, activeConversationId: firstConversation?.id ?? null };
    });
    setMenuOpen(false);
  }

  async function newConversation() {
    if (!preview && !sending) {
      if (!connection || !connected) return;
      try {
        setConnectionError("");
        const conversation = await connection.createConversation();
        history.acceptCreated(conversation.id);
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
    if (id === workspace?.activeConversationId) { history.retry(); setMenuOpen(false); return; }
    updateWorkspace((current) => ({ ...current, activeConversationId: id }));
    setMenuOpen(false);
  }

  function addFiles(files: FileList) {
    if (!connected || !conversationReady || configuring || sending || activeAgent.status !== "ready") return;
    try {
      validateAttachmentCount(attachments.length + files.length);
      const selected = Array.from(files).map(file => ({ file, ...describeAttachment(file, promptCapabilities) }));
      const additions: Attachment[] = selected.map(({ file, kind, mimeType }) => {
        const previewURL = kind === "image" || kind === "audio" ? URL.createObjectURL(file) : undefined;
        if (previewURL) previewURLs.current.add(previewURL);
        return { id: freshID("attachment"), name: file.name, kind: kind === "text" || kind === "pdf" ? "file" : kind,
          sizeLabel: formatBytes(file.size), previewURL, mimeType, file };
      });
      setAttachments(current => [...current, ...additions]);
      setConnectionError("");
    } catch (cause) {
      setConnectionError(errorMessage(cause, "Files could not be attached."));
    }
  }

  function removeAttachment(id: string) {
    setAttachments(current => current.filter(attachment => attachment.id !== id));
  }

  async function submit() {
    if (!workspace || configuring || sending || !connected || !conversationReady || activeAgent.status !== "ready" || (!draft.trim() && !attachments.length)) return;
    if (!workspace.preview) {
      await submitToAgent();
      return;
    }
    const now = new Date().toISOString();
    const conversation = activeConversation ?? {
      id: freshID("conversation"),
      agentId: activeAgent.id,
      title: "New conversation",
      updatedAt: now,
      messages: [],
    };
    const message: Message = {
      id: freshID("message"),
      role: "user",
      content: draft.trim(),
      createdAt: now,
      attachments,
    };
    const updatedConversation = {
      ...conversation,
      title: conversation.messages.length ? conversation.title : conversationTitle(draft || attachments[0]?.name || ""),
      updatedAt: now,
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
    const connectedAgent = connection;
    if (!connectedAgent) return;
    const epoch = accessEpoch.current;
    const admission = new AbortController();
    preparation.current = admission;
    const submittedText = draft;
    const submittedAttachments = attachments;
    setInFlightAttachments(submittedAttachments);
    setConnectionError("");
    setSending(true);
    try {
      const conversation = activeConversation ?? await connectedAgent.createConversation();
      if (epoch !== accessEpoch.current || !mounted.current) return;
      if (admission.signal.aborted) throw new Error("Agent status changed before the message was sent.");
      setActivePrompt({ connection: connectedAgent, sessionID: conversation.id });
      if (!activeConversation) {
        history.acceptCreated(conversation.id);
        updateWorkspace((current) => ({ ...current, activeConversationId: conversation.id }));
      }
      setDraft("");
      setAttachments([]);
      await connectedAgent.prompt(conversation.id, submittedText, submittedAttachments, admission.signal);
    } catch (cause) {
      if (epoch !== accessEpoch.current || !mounted.current) return;
      setConnectionError(errorMessage(cause, "The message could not be completed."));
      setDraft((current) => current || submittedText);
      setAttachments((current) => current.length ? current : submittedAttachments);
    } finally {
      if (preparation.current === admission) preparation.current = undefined;
      if (epoch === accessEpoch.current) {
        setActivePrompt(undefined);
        if (mounted.current) observation.refresh();
        setInFlightAttachments([]);
        setSending(false);
        setCancelling(false);
      }
    }
  }

  async function cancelRun() {
    const target = activePrompt ?? (connection && observation.state?.access_allowed && observation.state.active_session_id
      ? { connection, sessionID: observation.state.active_session_id } : undefined);
    if (!target || !connected || cancelling) return;
    setCancelling(true);
    try {
      await target.connection.cancel(target.sessionID);
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
        agentSwitchDisabled={sending || refreshing}
        agents={workspace.agents.map(agent => agent.id === activeAgent.id ? activeAgent : agent)}
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
            <span className={`presence presence-${activeAgent.status}`}>{activeAgent.status === "ready" ? "Available" : activeAgent.status === "busy" ? "Working" : activeAgent.status === "unknown" ? "Synchronizing" : "Offline"}</span>
          </div>
          <div className="topbar-actions">
            {!preview ? <button className="icon-button" type="button" disabled={sending || refreshing} onClick={() => { void refreshWorkspace(); }} title="Refresh workspace" aria-label="Refresh workspace"><RefreshCw size={17} aria-hidden="true" /></button> : null}
            {workspace.preview ? <span className="preview-label">Preview</span> : null}
            <button className="icon-button" type="button" disabled={sending || !connected} onClick={() => { void newConversation(); }} title="New conversation" aria-label="New conversation">
              <Plus size={17} aria-hidden="true" />
            </button>
          </div>
        </header>
        <SessionSettings options={activeConversation?.configOptions ?? []}
          disabled={!connected || !conversationReady || !stateReady || activeAgent.status !== "ready" || configuring || sending} onChange={(id, value) => { void setConfiguration(id, value); }} />
        <SessionUsage usage={activeConversation?.usage} stale={!connected || activeConversation?.usageStale === true} />
        <section className="thread-region">
          <div className="thread-scroll">
            <div className="thread-width">
              <Conversation agent={activeAgent} conversation={activeConversation} />
            </div>
          </div>
          {connectionError ? <div className="workspace-alert" role="alert">{connectionError}</div> : null}
          {history.error && !preview ? <div className="workspace-alert" role="alert">{history.error} <button className="icon-button" type="button" disabled={!connected} title="Retry conversation" aria-label="Retry conversation" onClick={history.retry}><RefreshCw size={15} aria-hidden="true" /></button></div> : null}
          <PermissionRequests requests={permissions} conversations={workspace.conversations} onOpen={selectConversation} onAnswer={(id, optionId) => {
            if (!connection?.answerPermission(id, optionId)) setConnectionError("This permission request is no longer active.");
          }} />
          <Composer
            fileAccept={attachmentAccept(promptCapabilities)}
            configuring={configuring}
            historyReady={conversationReady}
            agentStatus={activeAgent.status}
            attachments={attachments}
            connected={connected}
            cancelling={cancelling}
            cancellable={Boolean(activePrompt || (observation.state?.access_allowed && observation.state.active_session_id)) && connected}
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
