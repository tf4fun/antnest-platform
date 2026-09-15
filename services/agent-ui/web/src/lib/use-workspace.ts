import { useEffect, useMemo, useRef, useState } from "react";
import type { PendingPermission } from "./permissions";
import { createAgentUIClient, type ConnectedAgent } from "./client";
import { conversationTitle, formatBytes } from "./presentation";
import { describeAttachment, validateAttachmentCount } from "./attachments";
import { useConversationHistory } from "./use-conversation-history";
import { useSessionCatalog } from "./use-session-catalog";
import {
  applyDiscovery,
  applyConversation,
  applySessionCatalog,
  sameIdentity,
} from "./workspace-projection";
import { useWorkspaceState } from "./use-workspace-state";
import type { WorkspaceState } from "./workspace-state";
import type {
  Attachment,
  Conversation as ConversationModel,
  Message,
  WorkspaceSnapshot,
} from "./types";
import {
  readWorkspaceRoute,
  selectWorkspaceRoute,
  workspacePath,
  type WorkspaceRoute,
} from "./navigation";
import { useSessionPresentation } from "./use-session-presentation";

function freshID(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function previewResponse(): Message {
  return {
    id: freshID("message"),
    role: "assistant",
    createdAt: new Date().toISOString(),
    content:
      "I have the message and attachments. The production ACP bridge will replace this development preview response.",
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
  return cause instanceof Error && cause.message.trim()
    ? cause.message
    : fallback;
}

export function useWorkspace() {
  const client = useMemo(createAgentUIClient, []);
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot>();
  const [error, setError] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const presentation = useSessionPresentation(
    workspace?.activeAgentId ?? "",
    workspace?.activeConversationId ?? null,
  );
  const {
    draft,
    setDraft,
    attachments,
    setAttachments,
    sending,
    setSending,
    configuring,
    setConfiguring,
  } = presentation;
  const [cancelling, setCancelling] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [connectionError, setConnectionError] = useState("");
  const [permissions, setPermissions] = useState<PendingPermission[]>([]);
  const [creating, setCreating] = useState(false);
  const creation = useRef<{ connection: ConnectedAgent } | undefined>(
    undefined,
  );
  const preparedRoute = useRef<string | undefined>(undefined);
  const liveConnection = useRef<ConnectedAgent | undefined>(undefined);
  const previewURLs = useRef(new Set<string>());
  const [inFlightAttachments, setInFlightAttachments] = useState<
    readonly Attachment[]
  >([]);
  const [connection, setConnection] = useState<ConnectedAgent>();
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [activePrompt, setActivePrompt] = useState<{
    connection: ConnectedAgent;
    sessionID: string;
  }>();
  const refreshRequest = useRef<AbortController | undefined>(undefined);
  const mounted = useRef(false);
  const disposeConnection = useRef(() => {});
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const [recoverHistory, setRecoverHistory] = useState(false);
  const recoveryRequested = useRef(false);
  function requestHistoryRecovery() {
    recoveryRequested.current = true;
    setRecoverHistory(true);
  }
  const previousState = useRef<WorkspaceState | undefined>(undefined);
  const accessEpoch = useRef(0);
  const navigationEpoch = useRef(0);
  const preparation = useRef<AbortController | undefined>(undefined);
  const reconnectFailures = useRef(0);
  const routeHandler = useRef<((route: WorkspaceRoute) => void) | undefined>(
    undefined,
  );
  const observation = useWorkspaceState(
    client,
    workspace?.preview ? undefined : workspace?.activeAgentId || undefined,
    acceptBootstrap,
  );
  const history = useConversationHistory(
    connection,
    workspace?.activeConversationId ?? null,
  );
  const catalog = useSessionCatalog(connection, (sessions) => {
    const agentID = workspace?.activeAgentId;
    if (agentID)
      setWorkspace((current) =>
        current?.activeAgentId === agentID && sameIdentity(current, workspace)
          ? applySessionCatalog(current, agentID, sessions)
          : current,
      );
  });
  useEffect(() => {
    setCancelling(false);
  }, [observation.subscription, connection]);

  useEffect(() => {
    const pop = () =>
      routeHandler.current?.(readWorkspaceRoute(window.location.search));
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);

  useEffect(() => {
    if (!workspace) return;
    const target = workspacePath({
      agentId: workspace.activeAgentId,
      sessionId: workspace.activeConversationId,
    });
    const url = new URL(target, window.location.origin);
    if (workspace.preview) url.searchParams.set("preview", "1");
    if (
      window.location.pathname + window.location.search !==
      url.pathname + url.search
    )
      window.history.replaceState(null, "", url.pathname + url.search);
  }, [
    workspace?.activeAgentId,
    workspace?.activeConversationId,
    workspace?.preview,
  ]);

  function acceptBootstrap(latest: WorkspaceSnapshot, reconnect = false) {
    const current = workspaceRef.current;
    if (!current) return;
    const changedIdentity = !sameIdentity(current, latest);
    const visible = new Set(latest.agents.map((agent) => agent.id));
    const lostAccess =
      Boolean(current.activeAgentId) && !visible.has(current.activeAgentId);
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
      presentation.clear();
      setConnectionAttempt((value) => value + 1);
    } else if (reconnect && current.connection === "offline") {
      setConnectionAttempt((value) => value + 1);
    } else if (reconnect) requestHistoryRecovery();
    setWorkspace(applyDiscovery(current, latest));
  }

  useEffect(() => {
    const state = observation.state;
    if (!state?.access_allowed || state.availability !== "ready")
      preparation.current?.abort();
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
      presentation.clear();
      setWorkspace((current) => {
        if (!current || current.activeAgentId !== state.agent_id)
          return current;
        const agents = current.agents.filter(
          (agent) => agent.id !== state.agent_id,
        );
        return {
          ...current,
          agents,
          activeAgentId: "",
          activeConversationId: null,
          conversations: current.conversations.filter(
            (conversation) => conversation.agentId !== state.agent_id,
          ),
          connection: "offline",
        };
      });
      return;
    }
    if (
      previous?.agent_id === state.agent_id &&
      (previous.configuration_revision !== state.configuration_revision ||
        (previous.availability !== "ready" && state.availability === "ready"))
    )
      requestHistoryRecovery();
    if (
      !state.active_session_id ||
      previous?.active_session_id !== state.active_session_id
    )
      setCancelling(false);
  }, [observation.state]);

  useEffect(() => {
    if (
      !recoverHistory ||
      sending ||
      observation.state?.availability !== "ready"
    )
      return;
    setRecoverHistory(false);
    disposeConnection.current();
    setConnection(undefined);
    setPermissions([]);
    recoveryRequested.current = false;
    setConnectionAttempt((value) => value + 1);
  }, [recoverHistory, sending, observation.state]);

  useEffect(() => {
    if (workspace?.connection === "ready") reconnectFailures.current = 0;
    if (
      !workspace ||
      workspace.preview ||
      !workspace.activeAgentId ||
      workspace.connection !== "offline" ||
      sending ||
      refreshing ||
      loggingOut
    )
      return;
    const delay = Math.min(
      30000,
      1000 * 2 ** Math.min(reconnectFailures.current++, 5),
    );
    const timer = setTimeout(() => {
      void refreshWorkspace();
    }, delay);
    return () => clearTimeout(timer);
  }, [
    workspace?.connection,
    workspace?.activeAgentId,
    workspace?.preview,
    sending,
    refreshing,
    loggingOut,
  ]);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    client
      .loadWorkspace(controller.signal)
      .then(setWorkspace)
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError")
          return;
        setError(
          cause instanceof Error
            ? cause.message
            : "The Agent workspace could not be loaded.",
        );
      });
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, [client]);

  useEffect(
    () => () => {
      refreshRequest.current?.abort();
      previewURLs.current.forEach((previewURL) =>
        URL.revokeObjectURL(previewURL),
      );
      previewURLs.current.clear();
    },
    [],
  );

  const previewSnapshot = useMemo(() => {
    const history =
      workspace?.conversations.flatMap((conversation) =>
        conversation.messages.flatMap((message) => message.attachments ?? []),
      ) ?? [];
    return {
      candidates: [...previewURLs.current],
      referenced: new Set(
        [
          ...presentation.allAttachments,
          ...inFlightAttachments,
          ...history,
        ].map((attachment) => attachment.previewURL),
      ),
    };
  }, [
    presentation.allAttachments,
    inFlightAttachments,
    workspace?.conversations,
  ]);

  useEffect(() => {
    for (const url of previewSnapshot.candidates) {
      if (
        previewSnapshot.referenced.has(url) ||
        !previewURLs.current.delete(url)
      )
        continue;
      URL.revokeObjectURL(url);
    }
  }, [previewSnapshot]);

  useEffect(() => {
    const agentID = workspace?.activeAgentId;
    if (!workspace || workspace.preview || !agentID) return;

    let disposed = false;
    const opening = new AbortController();
    let ownedConnection: ConnectedAgent | undefined;
    const dispose = () => {
      disposed = true;
      if (liveConnection.current === ownedConnection)
        liveConnection.current = undefined;
      opening.abort();
      ownedConnection?.close();
    };
    disposeConnection.current = dispose;
    setConnection(undefined);
    setConnectionError("");
    setPermissions([]);
    setWorkspace((current) =>
      current ? { ...current, connection: "connecting" } : current,
    );

    void client
      .connectAgent(
        agentID,
        {
          onPermissions: (requests) => {
            if (!disposed) setPermissions(requests);
          },
          onConnection: (status, cause) => {
            if (disposed) return;
            setWorkspace((current) =>
              current ? { ...current, connection: status } : current,
            );
            if (cause) setConnectionError(cause);
          },
          onConversation: (conversation) => {
            if (disposed) return;
            setWorkspace((current) =>
              current ? applyConversation(current, conversation) : current,
            );
          },
        },
        opening.signal,
      )
      .then((connected) => {
        if (disposed) {
          connected.close();
          return;
        }
        ownedConnection = connected;
        liveConnection.current = connected;
        setConnection(connected);
      })
      .catch((cause: unknown) => {
        if (!disposed)
          setConnectionError(
            errorMessage(cause, "The Agent connection could not be opened."),
          );
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
    setWorkspace((current) =>
      current ? { ...current, connection: "offline" } : current,
    );
    try {
      await refreshAvailability();
      observation.refresh(false);
      setConnectionAttempt((current) => current + 1);
    } catch (cause) {
      setConnectionError(
        errorMessage(cause, "Workspace status could not be refreshed."),
      );
    } finally {
      setRefreshing(false);
    }
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
      setConnectionError(
        errorMessage(cause, "Your session could not be closed."),
      );
      setLoggingOut(false);
    }
  }

  function navigate(route: WorkspaceRoute, push = true) {
    const current = workspaceRef.current;
    if (!current) return;
    const next = selectWorkspaceRoute(current, route);
    navigationEpoch.current++;
    if (next.activeAgentId !== current.activeAgentId) {
      accessEpoch.current++;
      preparation.current?.abort();
      disposeConnection.current();
      presentation.disconnect(current.activeAgentId);
      setConnection(undefined);
      setPermissions([]);
      setActivePrompt(undefined);
      setInFlightAttachments([]);
      setConnectionError("");
      setCancelling(false);
      setCreating(false);
      setRecoverHistory(false);
      recoveryRequested.current = false;
      previousState.current = undefined;
      next.connection = current.preview ? "ready" : "connecting";
    }
    if (
      push &&
      (next.activeAgentId !== current.activeAgentId ||
        next.activeConversationId !== current.activeConversationId)
    ) {
      const url = new URL(
        workspacePath({
          agentId: next.activeAgentId,
          sessionId: next.activeConversationId,
        }),
        window.location.origin,
      );
      if (current.preview) url.searchParams.set("preview", "1");
      window.history.pushState(null, "", url.pathname + url.search);
    }
    workspaceRef.current = next;
    setWorkspace((latest) => {
      if (!latest || !sameIdentity(latest, current)) return latest;
      const selected = selectWorkspaceRoute(latest, route);
      return {
        ...selected,
        connection:
          next.activeAgentId !== current.activeAgentId
            ? next.connection
            : latest.connection,
      };
    });
    setMenuOpen(false);
  }
  routeHandler.current = (route) => navigate(route, false);

  const listedAgent = workspace?.agents.find(
    ({ id }) => id === workspace.activeAgentId,
  );
  const activeAgent = listedAgent
    ? workspace?.preview
      ? listedAgent
      : {
          ...listedAgent,
          status: observation.state?.availability ?? ("unknown" as const),
        }
    : undefined;
  const stateReady =
    workspace?.preview || observation.state?.access_allowed === true;
  const activeConversation = workspace?.conversations.find(
    ({ id, agentId }) =>
      id === workspace.activeConversationId && agentId === activeAgent?.id,
  );
  const connected =
    workspace?.connection === "ready" &&
    (workspace.preview || Boolean(connection)) &&
    !refreshing;
  const conversationReady =
    workspace?.preview || (history.ready && !recoverHistory);
  const preview = workspace?.preview ?? false;
  const promptCapabilities = preview
    ? { image: true, audio: true, embeddedContext: true }
    : connection?.promptCapabilities;

  useEffect(() => {
    if (
      preview ||
      !activeAgent ||
      workspace?.activeConversationId !== null ||
      !connected ||
      !stateReady ||
      activeAgent.status !== "ready" ||
      creating ||
      sending ||
      configuring ||
      recoverHistory ||
      recoveryRequested.current ||
      liveConnection.current !== connection
    )
      return;
    const route = `${accessEpoch.current}:${navigationEpoch.current}`;
    if (preparedRoute.current === route) return;
    preparedRoute.current = route;
    void newConversation(true);
  }, [
    preview,
    connected,
    stateReady,
    activeAgent?.id,
    activeAgent?.status,
    workspace?.activeConversationId,
    creating,
    sending,
    configuring,
    recoverHistory,
  ]);

  async function setConfiguration(id: string, value: string) {
    if (!activeAgent) return;
    if (
      !activeConversation ||
      !connection ||
      !conversationReady ||
      !connected ||
      !stateReady ||
      activeAgent.status !== "ready" ||
      sending ||
      configuring
    )
      return;
    setConfiguring(true);
    presentation.setError();
    const epoch = accessEpoch.current;
    try {
      await connection.setConfiguration(activeConversation.id, id, value);
    } catch (cause) {
      if (epoch === accessEpoch.current)
        presentation.setError(
          errorMessage(cause, "Session configuration could not be changed."),
        );
    } finally {
      if (epoch === accessEpoch.current) setConfiguring(false);
    }
  }

  function updateWorkspace(
    update: (current: WorkspaceSnapshot) => WorkspaceSnapshot,
  ) {
    setWorkspace((current) => (current ? update(current) : current));
  }

  function selectAgent(agentID: string) {
    if (refreshing) return;
    if (agentID === workspace?.activeAgentId) {
      setMenuOpen(false);
      return;
    }
    navigate({ agentId: agentID, sessionId: null });
    setMenuOpen(false);
  }

  async function newConversation(preserveDraft = false) {
    if (!activeAgent) return;
    if (
      (creation.current && creation.current.connection === connection) ||
      creating ||
      sending ||
      configuring
    )
      return;
    const epoch = accessEpoch.current;
    const navigation = navigationEpoch.current;
    if (!preview && !sending) {
      if (!connection || !connected) return;
      const operation = { connection };
      creation.current = operation;
      setCreating(true);
      try {
        setConnectionError("");
        const conversation = await connection.createConversation();
        if (
          epoch !== accessEpoch.current ||
          !mounted.current ||
          liveConnection.current !== connection
        )
          return;
        // Navigation may run before React commits the creation notification.
        if (workspaceRef.current)
          workspaceRef.current = applyConversation(
            workspaceRef.current,
            conversation,
          );
        if (navigation === navigationEpoch.current) {
          history.acceptCreated(conversation.id);
          if (preserveDraft) presentation.move(conversation.id);
          navigate(
            { agentId: activeAgent.id, sessionId: conversation.id },
            !preserveDraft,
          );
        }
        setMenuOpen(false);
      } catch (cause) {
        if (
          epoch === accessEpoch.current &&
          navigation === navigationEpoch.current &&
          liveConnection.current === connection
        )
          setConnectionError(
            errorMessage(cause, "A new conversation could not be created."),
          );
      } finally {
        if (creation.current === operation) creation.current = undefined;
        if (epoch === accessEpoch.current) setCreating(false);
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
    if (!activeAgent) return;
    if (id === workspace?.activeConversationId) {
      history.retry();
      setMenuOpen(false);
      return;
    }
    navigate({ agentId: activeAgent.id, sessionId: id });
    setMenuOpen(false);
  }

  function addFiles(files: FileList) {
    if (!activeAgent) return;
    if (
      !connected ||
      !conversationReady ||
      creating ||
      configuring ||
      sending ||
      activeAgent.status !== "ready"
    )
      return;
    try {
      validateAttachmentCount(attachments.length + files.length);
      const selected = Array.from(files).map((file) => ({
        file,
        ...describeAttachment(file, promptCapabilities),
      }));
      const additions: Attachment[] = selected.map(
        ({ file, kind, mimeType }) => {
          const previewURL =
            kind === "image" || kind === "audio"
              ? URL.createObjectURL(file)
              : undefined;
          if (previewURL) previewURLs.current.add(previewURL);
          return {
            id: freshID("attachment"),
            name: file.name,
            kind: kind === "text" || kind === "pdf" ? "file" : kind,
            sizeLabel: formatBytes(file.size),
            previewURL,
            mimeType,
            file,
          };
        },
      );
      setAttachments((current) => [...current, ...additions]);
      setConnectionError("");
    } catch (cause) {
      setConnectionError(errorMessage(cause, "Files could not be attached."));
    }
  }

  function removeAttachment(id: string) {
    setAttachments((current) =>
      current.filter((attachment) => attachment.id !== id),
    );
  }

  async function submit() {
    if (!activeAgent) return;
    if (
      !workspace ||
      creating ||
      configuring ||
      sending ||
      !connected ||
      !conversationReady ||
      activeAgent.status !== "ready" ||
      (!draft.trim() && !attachments.length)
    )
      return;
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
      title: conversation.messages.length
        ? conversation.title
        : conversationTitle(draft || attachments[0]?.name || ""),
      updatedAt: now,
      messages: [...conversation.messages, message],
    };
    updateWorkspace((current) => ({
      ...current,
      activeConversationId: conversation.id,
      agents: current.agents.map((agent) =>
        agent.id === activeAgent.id ? { ...agent, status: "busy" } : agent,
      ),
      conversations: [
        updatedConversation,
        ...current.conversations.filter(({ id }) => id !== conversation.id),
      ],
    }));
    setDraft("");
    setAttachments([]);
    setSending(true);
    window.setTimeout(() => {
      updateWorkspace((current) => ({
        ...current,
        agents: current.agents.map((agent) =>
          agent.id === activeAgent.id ? { ...agent, status: "ready" } : agent,
        ),
        conversations: current.conversations.map((item) =>
          item.id === conversation.id
            ? {
                ...item,
                updatedAt: new Date().toISOString(),
                messages: [...item.messages, previewResponse()],
              }
            : item,
        ),
      }));
      setSending(false);
    }, 850);
  }

  async function submitToAgent() {
    if (!activeAgent || !activeConversation) return;
    const connectedAgent = connection;
    if (!connectedAgent) return;
    const epoch = accessEpoch.current;
    const admission = new AbortController();
    preparation.current = admission;
    const submittedText = draft;
    const submittedAttachments = attachments;
    const submittedSession = activeConversation.id;
    setInFlightAttachments(submittedAttachments);
    presentation.setError();
    setSending(true);
    try {
      const conversation = activeConversation;
      if (epoch !== accessEpoch.current || !mounted.current) return;
      if (admission.signal.aborted)
        throw new Error("Agent status changed before the message was sent.");
      setActivePrompt({
        connection: connectedAgent,
        sessionID: conversation.id,
      });
      setDraft("");
      setAttachments([]);
      await connectedAgent.prompt(
        conversation.id,
        submittedText,
        submittedAttachments,
        admission.signal,
      );
    } catch (cause) {
      if (epoch !== accessEpoch.current || !mounted.current) return;
      presentation.restore(
        submittedSession,
        submittedText,
        submittedAttachments,
        errorMessage(cause, "The message could not be completed."),
      );
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
    const target =
      activePrompt ??
      (connection &&
      observation.state?.access_allowed &&
      observation.state.active_session_id
        ? { connection, sessionID: observation.state.active_session_id }
        : undefined);
    if (!target || !connected || cancelling) return;
    setCancelling(true);
    try {
      await target.connection.cancel(target.sessionID);
    } catch (cause) {
      setConnectionError(
        errorMessage(cause, "The operation could not be stopped."),
      );
      setCancelling(false);
    }
  }

  return {
    workspace,
    error,
    menuOpen,
    setMenuOpen,
    draft,
    setDraft,
    attachments,
    sending,
    cancelling,
    loggingOut,
    connectionError,
    interactionError: presentation.error,
    permissions,
    configuring,
    creating,
    connection,
    refreshing,
    activePrompt,
    observation,
    history,
    catalog,
    activeAgent,
    stateReady,
    activeConversation,
    connected,
    conversationReady,
    preview,
    promptCapabilities,
    refreshWorkspace,
    logout,
    navigate,
    selectAgent,
    selectConversation,
    newConversation,
    setConfiguration,
    addFiles,
    removeAttachment,
    submit,
    cancelRun,
    setConnectionError,
  };
}
