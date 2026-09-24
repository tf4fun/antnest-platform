import { useEffect, useMemo, useRef, useState } from "react";
import { BridgeAgentController, type BridgeControllerSnapshot } from "./bridge-agent-controller.ts";
import { BridgeSessionCatalog } from "./bridge-catalog.ts";
import { workspaceFromBridgeBootstrap } from "./bootstrap.ts";
import { buildPromptBlocks } from "./prompt.ts";
import { csrfFromCookie } from "./session.ts";
import { describeAttachment, validateAttachmentCount } from "./attachments.ts";
import { formatBytes } from "./presentation.ts";
import { runFailureMessage } from "./run-failure.ts";
import { useSessionPresentation } from "./use-session-presentation.ts";
import { applyConversation, applyDiscovery, applySessionCatalog, sameIdentity } from "./workspace-projection.ts";
import { readWorkspaceRoute, selectWorkspaceRoute, workspacePath, type WorkspaceRoute } from "./navigation.ts";
import { BridgeHttpClient, WorkspaceApiError } from "./workspace-api-client.ts";
import type { AgentStatus, AgentSummary, Attachment, WorkspaceSnapshot } from "./types.ts";

type ControllerFactory = (input: {
  agentId: string;
  api: BridgeHttpClient;
  changed: (snapshot: BridgeControllerSnapshot) => void;
}) => BridgeAgentController;

const defaultController: ControllerFactory = (input) => new BridgeAgentController(input);
const activePhase = (phase: string) => phase !== "completed" && phase !== "failed" && phase !== "cancelled";
const message = (cause: unknown, fallback: string) =>
  cause instanceof Error && cause.message.trim() ? cause.message : fallback;
const loginPath = () => `/?${new URLSearchParams({
  return_to: workspacePath(readWorkspaceRoute(window.location.search)),
})}`;

export function useBridgeWorkspace(options: {
  api?: BridgeHttpClient;
  makeController?: ControllerFactory;
  initialBootstrap?: unknown;
  initialRoute?: WorkspaceRoute;
} = {}) {
  const apiRef = useRef<BridgeHttpClient | undefined>(undefined);
  if (!apiRef.current)
    apiRef.current = options.api ?? new BridgeHttpClient({
      csrf: () => csrfFromCookie(document.cookie),
    });
  const api = apiRef.current;
  const factoryRef = useRef(options.makeController ?? defaultController);
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot | undefined>(() =>
    options.initialBootstrap === undefined ? undefined : selectWorkspaceRoute(
      workspaceFromBridgeBootstrap(options.initialBootstrap),
      options.initialRoute ?? (typeof window === "undefined"
        ? { agentId: "", sessionId: null } : readWorkspaceRoute(window.location.search)),
    ));
  const [error, setError] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [historyError, setHistoryError] = useState<string>();
  const [menuOpen, setMenuOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [configuring, setConfiguring] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [catalogState, setCatalogState] = useState({ loading: false, hasMore: false, error: "" });
  const [bridge, setBridge] = useState<BridgeControllerSnapshot>({
    connection: "offline", view: null, operations: [], permissions: [],
  });
  const controllerRef = useRef<BridgeAgentController | undefined>(undefined);
  const catalogRef = useRef<BridgeSessionCatalog | undefined>(undefined);
  const selectedRef = useRef<string | null | undefined>(undefined);
  const navigationEpoch = useRef(0);
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const previewURLs = useRef(new Set<string>());
  const presentation = useSessionPresentation(
    workspace?.activeAgentId ?? "", workspace?.activeConversationId ?? null,
  );
  useEffect(() => {
    const live = new Set(presentation.allAttachments.flatMap((attachment) =>
      attachment.previewURL ? [attachment.previewURL] : []));
    for (const url of previewURLs.current) {
      if (live.has(url)) continue;
      URL.revokeObjectURL(url);
      previewURLs.current.delete(url);
    }
  });

  const activeAgent = useMemo((): AgentSummary | undefined => {
    const listed = workspace?.agents.find((item) => item.id === workspace.activeAgentId);
    if (!listed) return undefined;
    const status: AgentStatus = bridge.connection === "ready" &&
      bridge.view?.agentId === listed.id &&
      (bridge.view.availability === "ready" || bridge.view.availability === "busy" ||
        bridge.view.availability === "offline") ? bridge.view.availability : "unknown";
    return { ...listed, status };
  }, [workspace?.agents, workspace?.activeAgentId, bridge.connection, bridge.view]);
  const activeConversation = workspace?.conversations.find((item) =>
    item.agentId === workspace.activeAgentId && item.id === workspace.activeConversationId);
  const selected = workspace?.activeConversationId;
  const selectedOperations = bridge.operations.filter((item) => item.sessionId === selected);
  const activeOperation = selectedOperations.find((item) => activePhase(item.phase));
  const latestFailedTurn = [...(activeConversation?.messages ?? [])].reverse().find((item) =>
    item.role === "user" && item.turnOutcome === "failed");
  const latestUserTurn = [...(activeConversation?.messages ?? [])].reverse().find((item) =>
    item.role === "user");
  const failedRun = latestFailedTurn?.id === latestUserTurn?.id && latestFailedTurn
    ? selectedOperations.find((item) => item.phase === "failed" &&
      item.runId === latestFailedTurn.id.slice(0, -":prompt".length)) : undefined;
  const observedFailure = activeOperation ? undefined : runFailureMessage(failedRun?.errorClass);
  const connected = bridge.connection === "ready" && bridge.view?.agentId === workspace?.activeAgentId;
  const conversationReady = connected && bridge.view !== null && Boolean(selected) &&
    bridge.view?.selectedSessionId === selected &&
    bridge.view.selectedView?.historyState === "ready";
  const blockedHistory = connected && bridge.view?.selectedSessionId === selected &&
    bridge.view?.selectedView?.historyState === "blocked";
  const stateReady = connected;
  const sending = submitting || Boolean(activeOperation) ||
    (bridge.view?.activeSessionId !== null && bridge.view?.activeSessionId === selected);
  const sessionWorking = sending;
  const sessionSettled = connected && conversationReady && !sessionWorking;
  const openingHistory = Boolean(selected) && !conversationReady &&
    !historyError && !connectionError &&
    activeConversation?.historyState !== "view_limited" && !activeConversation?.messages.length;
  const cancellable = connected && Boolean(activeOperation?.runId);

  useEffect(() => {
    const request = new AbortController();
    void api.bootstrap(request.signal).then((raw) => {
      if (request.signal.aborted) return;
      const latest = workspaceFromBridgeBootstrap(raw);
      if (workspaceRef.current && !sameIdentity(workspaceRef.current, latest))
        presentation.clear();
      setWorkspace((current) => current && sameIdentity(current, latest)
        ? applyDiscovery(current, latest)
        : selectWorkspaceRoute(latest, readWorkspaceRoute(window.location.search)));
    }).catch((cause: unknown) => {
      if (!request.signal.aborted && cause instanceof WorkspaceApiError &&
        (cause.status === 401 || cause.recovery === "login")) {
        presentation.clear();
        setWorkspace(undefined);
        window.location.assign(loginPath());
      } else if (!request.signal.aborted)
        setError(message(cause, "The Agent workspace could not be loaded."));
    });
    return () => request.abort();
  }, [api]);

  useEffect(() => {
    const pop = () => navigate(readWorkspaceRoute(window.location.search), false);
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  });

  useEffect(() => {
    if (!workspace) return;
    const target = workspacePath({ agentId: workspace.activeAgentId,
      sessionId: workspace.activeConversationId });
    const path = target;
    if (window.location.pathname + window.location.search !== path)
      window.history.replaceState(null, "", path);
  }, [workspace?.activeAgentId, workspace?.activeConversationId]);

  useEffect(() => {
    const agentId = workspace?.activeAgentId;
    if (!agentId) return;
    let disposed = false;
    selectedRef.current = undefined;
    const catalog = new BridgeSessionCatalog(agentId, api);
    catalogRef.current = catalog;
    const controller = factoryRef.current({
      agentId, api,
      changed: (snapshot) => {
        if (disposed) return;
        setBridge(snapshot);
        if (snapshot.unauthenticated) {
          presentation.clear();
          setWorkspace(undefined);
          window.location.assign(loginPath());
          return;
        }
        if (snapshot.revoked) {
          presentation.clear();
          setWorkspace((current) => current?.activeAgentId === agentId ? {
            ...current,
            agents: current.agents.filter((item) => item.id !== agentId),
            conversations: current.conversations.filter((item) => item.agentId !== agentId),
            activeAgentId: "",
            activeConversationId: null,
          } : current);
          return;
        }
        if (snapshot.conversation) {
          catalog.remember(snapshot.conversation);
          setWorkspace((current) => current?.activeAgentId === agentId
            ? applyConversation(current, snapshot.conversation!) : current);
        }
      },
    });
    controllerRef.current = controller;
    setBridge(controller.snapshot);
    setCatalogState({ loading: true, hasMore: true, error: "" });
    void catalog.loadPage().then((page) => {
      if (disposed) return;
      setWorkspace((current) => current?.activeAgentId === agentId
        ? applySessionCatalog(current, agentId, catalog.conversations) : current);
      setCatalogState({ loading: false, hasMore: page.hasMore, error: "" });
    }).catch((cause: unknown) => {
      if (!disposed) setCatalogState({ loading: false, hasMore: true,
        error: message(cause, "Conversations could not be loaded.") });
    });
    return () => {
      disposed = true;
      controller.close();
      if (controllerRef.current === controller) controllerRef.current = undefined;
      if (catalogRef.current === catalog) catalogRef.current = undefined;
    };
  }, [api, workspace?.activeAgentId]);

  useEffect(() => {
    const agentId = workspace?.activeAgentId;
    const sessionId = workspace?.activeConversationId ?? null;
    const controller = controllerRef.current;
    if (!agentId || !controller || selectedRef.current === sessionId) return;
    selectedRef.current = sessionId;
    setHistoryError(undefined);
    void controller.select(sessionId).catch((cause: unknown) => {
      if (controllerRef.current === controller)
        setHistoryError(message(cause, "Conversation history could not be loaded."));
    });
  }, [workspace?.activeAgentId, workspace?.activeConversationId]);

  function navigate(route: WorkspaceRoute, push = true) {
    const current = workspaceRef.current;
    if (!current) return;
    const next = selectWorkspaceRoute(current, route);
    const changed = next.activeAgentId !== current.activeAgentId ||
      next.activeConversationId !== current.activeConversationId;
    if (changed) navigationEpoch.current++;
    if (push && changed)
      window.history.pushState(null, "", workspacePath({
        agentId: next.activeAgentId, sessionId: next.activeConversationId,
      }));
    setWorkspace((latest) => latest ? selectWorkspaceRoute(latest, route) : latest);
    setMenuOpen(false);
  }

  async function loadMoreCatalog() {
    const catalog = catalogRef.current;
    const agentId = workspaceRef.current?.activeAgentId;
    if (!catalog || !agentId || catalogState.loading || !catalogState.hasMore) return;
    setCatalogState((current) => ({ ...current, loading: true, error: "" }));
    try {
      const page = await catalog.loadPage();
      if (catalogRef.current !== catalog) return;
      setWorkspace((current) => current?.activeAgentId === agentId
        ? applySessionCatalog(current, agentId, catalog.conversations) : current);
      setCatalogState({ loading: false, hasMore: page.hasMore, error: "" });
    } catch (cause) {
      if (catalogRef.current === catalog)
        setCatalogState({ loading: false, hasMore: true,
          error: message(cause, "Conversations could not be loaded.") });
    }
  }

  async function newConversation() {
    const agentId = workspaceRef.current?.activeAgentId;
    if (!agentId || creating || submitting) return;
    const startedAtNavigation = navigationEpoch.current;
    setCreating(true);
    setConnectionError("");
    try {
      const raw = await api.createSession(agentId);
      if (!isRecord(raw) || typeof raw.sessionId !== "string" || !raw.sessionId)
        throw new Error("Bridge returned an invalid Session ID");
      if (workspaceRef.current?.activeAgentId !== agentId) return;
      const conversation = { id: raw.sessionId, agentId, title: "New conversation",
        updatedAt: new Date().toISOString(), messages: [] };
      catalogRef.current?.remember(conversation);
      setWorkspace((current) => current?.activeAgentId === agentId
        ? applyConversation(current, conversation) : current);
      if (navigationEpoch.current === startedAtNavigation)
        navigate({ agentId, sessionId: raw.sessionId });
    } catch (cause) {
      setConnectionError(message(cause, "A new conversation could not be created."));
    } finally {
      setCreating(false);
    }
  }

  async function submit() {
    const controller = controllerRef.current;
    const sessionId = workspaceRef.current?.activeConversationId;
    if (!controller || !sessionId || !connected || !conversationReady || submitting ||
      sending || !activeAgent || activeAgent.status !== "ready" ||
      (!presentation.draft.trim() && !presentation.attachments.length)) return;
    const text = presentation.draft;
    const attachments = presentation.attachments;
    setSubmitting(true);
    presentation.setError();
    try {
      const blocks = await buildPromptBlocks(text, attachments, bridge.view?.promptCapabilities);
      if (controllerRef.current !== controller || workspaceRef.current?.activeConversationId !== sessionId)
        return;
      const operation = await controller.submitPrompt(crypto.randomUUID(), blocks);
      presentation.setDraft("");
      presentation.setAttachments([]);
      if (operation.phase === "uncertain")
        presentation.setError("Message status is uncertain. Refresh this conversation to check the original operation.");
    } catch (cause) {
      presentation.setError(message(cause, "The message could not be sent."));
    } finally {
      setSubmitting(false);
    }
  }

  async function cancelRun() {
    const controller = controllerRef.current;
    if (!controller || !connected || !activeOperation?.runId || cancelling) return;
    setCancelling(true);
    try {
      await controller.cancelOperation(activeOperation.sessionId, activeOperation.operationId);
    } catch (cause) {
      setConnectionError(message(cause, "The operation could not be stopped."));
    } finally {
      setCancelling(false);
    }
  }

  async function setConfiguration(id: string, value: string | boolean) {
    const controller = controllerRef.current;
    if (!controller || !connected || !conversationReady || configuring) return;
    setConfiguring(true);
    try { await controller.setConfiguration(id, value); }
    catch (cause) { presentation.setError(message(cause, "Session configuration could not be changed.")); }
    finally { setConfiguring(false); }
  }

  function addFiles(files: FileList) {
    if (!connected || !conversationReady || !activeAgent || activeAgent.status !== "ready") return;
    try {
      validateAttachmentCount(presentation.attachments.length + files.length);
      const additions: Attachment[] = Array.from(files).map((file) => {
        const described = describeAttachment(file, bridge.view?.promptCapabilities);
        const previewURL = described.kind === "image" || described.kind === "audio"
          ? URL.createObjectURL(file) : undefined;
        if (previewURL) previewURLs.current.add(previewURL);
        return { id: crypto.randomUUID(), name: file.name,
          kind: described.kind === "text" || described.kind === "pdf" ? "file" : described.kind,
          sizeLabel: formatBytes(file.size), previewURL, mimeType: described.mimeType, file };
      });
      presentation.setAttachments((current) => [...current, ...additions]);
    } catch (cause) {
      setConnectionError(message(cause, "Files could not be attached."));
    }
  }

  useEffect(() => () => {
    for (const url of previewURLs.current) URL.revokeObjectURL(url);
    previewURLs.current.clear();
  }, []);

  async function refreshWorkspace() {
    if (refreshing) return;
    setRefreshing(true);
    setConnectionError("");
    try {
      const latest = workspaceFromBridgeBootstrap(await api.bootstrap());
      const identityChanged = Boolean(workspaceRef.current &&
        !sameIdentity(workspaceRef.current, latest));
      if (identityChanged)
        presentation.clear();
      setWorkspace((current) => current ? applyDiscovery(current, latest) : latest);
      const controller = controllerRef.current;
      if (!identityChanged && controller)
        await controller.select(workspaceRef.current?.activeConversationId ?? null);
    } catch (cause) {
      setConnectionError(message(cause, "Workspace status could not be refreshed."));
    } finally { setRefreshing(false); }
  }

  async function logout() {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      const csrf = csrfFromCookie(document.cookie);
      const response = await fetch("/api/session", { method: "DELETE", credentials: "same-origin",
        headers: csrf ? { "X-Antnest-CSRF-Token": csrf } : {} });
      if (!response.ok) throw new Error("Your session could not be closed.");
      controllerRef.current?.close();
      window.location.assign("/");
    } catch (cause) {
      setConnectionError(message(cause, "Your session could not be closed."));
      setLoggingOut(false);
    }
  }

  return {
    workspace, error, menuOpen, setMenuOpen,
    draft: presentation.draft, setDraft: presentation.setDraft,
    attachments: presentation.attachments,
    sending, cancelling, loggingOut, connectionError,
    interactionError: presentation.error || observedFailure,
    permissions: [...bridge.permissions], configuring, creating, refreshing,
    history: { ready: conversationReady,
      error: blockedHistory ? "Latest conversation history could not be loaded. Showing saved messages read-only." : historyError,
      retry: () => { const id = workspaceRef.current?.activeConversationId ?? null;
        if (controllerRef.current) void controllerRef.current.select(id).catch((cause: unknown) =>
          setHistoryError(message(cause, "Conversation history could not be loaded."))); } },
    catalog: { loading: catalogState.loading, hasMore: catalogState.hasMore,
      error: catalogState.error || undefined, loadMore: () => { void loadMoreCatalog(); } },
    activeAgent, stateReady, activeConversation, connected, conversationReady,
    preview: false, promptCapabilities: bridge.view?.promptCapabilities,
    refreshWorkspace, logout, navigate,
    selectAgent: (id: string) => navigate({ agentId: id, sessionId: null }),
    selectConversation: (id: string) => navigate({ agentId: workspaceRef.current?.activeAgentId ?? "", sessionId: id }),
    newConversation, setConfiguration, addFiles,
    removeAttachment: (id: string) => presentation.setAttachments((current) =>
      current.filter((item) => item.id !== id)),
    submit, cancelRun, setConnectionError,
    sessionWorking, sessionSettled, openingHistory, cancellable,
    onAnswerPermission: (id: string, optionId: string) => {
      if (!connected) return;
      void controllerRef.current?.decidePermission(id, optionId).catch((cause: unknown) =>
        setConnectionError(message(cause, "This permission request is no longer active.")));
    },
    hasOlderTurns: controllerRef.current?.hasOlderTurns ?? false,
    hasNewerTurns: controllerRef.current?.hasNewerTurns ?? false,
    historyGapAfter: controllerRef.current?.historyGapAfter,
    onLoadOlder: () => controllerRef.current?.loadOlderTurns(),
    onLoadNewer: () => controllerRef.current?.loadNewerTurns(),
    onShowLatest: () => controllerRef.current?.showLatestTurns(),
    onLoadContent: (messageId: string) => {
      void controllerRef.current?.loadMessageContent(messageId).catch((cause: unknown) =>
        setConnectionError(message(cause, "Full message content could not be loaded.")));
    },
    onLoadProcess: (turnId: string) => controllerRef.current?.loadProcess(turnId) ??
      Promise.reject(new Error("No Bridge Session is selected")),
    onUnloadProcess: (turnId: string) => controllerRef.current?.unloadProcess(turnId),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
