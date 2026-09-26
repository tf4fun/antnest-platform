import {
  Bot,
  LogOut,
  Menu,
  Plus,
  RefreshCw,
  Settings,
  WifiOff,
} from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import { Composer } from "./components/Composer";
import { CommandResponse } from "./components/CommandResponse";
import { Thread } from "./components/Thread";
import { Sidebar } from "./components/Sidebar";
import { PermissionRequests } from "./components/PermissionRequests";
import { SessionSettings } from "./components/SessionSettings";
import { SessionUsage } from "./components/SessionUsage";
import { AgentChooser } from "./components/AgentChooser";
import { AgentPresence } from "./components/AgentPresence";
import { attachmentAccept } from "./lib/attachments";
import type { useBridgeWorkspace } from "./lib/use-bridge-workspace";

export type WorkspacePageModel = ReturnType<typeof useBridgeWorkspace>;

export function WorkspacePage({ model }: { model: WorkspacePageModel }) {
  const composerRoot = useRef<HTMLDivElement>(null);
  const retryConversation = useRef<HTMLButtonElement>(null);
  const composerHadFocus = useRef(false);
  const retryHadFocus = useRef(false);
  const pendingMobileFocus = useRef<string | null>(null);
  const {
    workspace,
    error,
    menuOpen,
    setMenuOpen,
    draft,
    commands,
    allowControlInput,
    controlInput,
    controlEnabled,
    commanding,
    commandFeedback,
    dismissCommandFeedback,
    setDraft,
    attachments,
    sending,
    cancelling,
    loggingOut,
    connectionError,
    interactionError,
    permissions,
    configuring,
    creating,
    refreshing,
    history,
    catalog,
    activeAgent,
    stateReady,
    activeConversation,
    connected,
    conversationReady,
    creationUncertain,
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
    sessionWorking,
    sessionSettled,
    openingHistory,
    cancellable,
    onAnswerPermission,
    hasOlderTurns,
    hasNewerTurns,
    historyGapAfter,
    onLoadOlder,
    onLoadNewer,
    onShowLatest,
    onLoadContent,
    onLoadProcess,
    onCancelProcess,
    onUnloadProcess,
  } = model;
  const focusAfterMobileNavigation = (selector: string) => {
    if (!menuOpen) return;
    pendingMobileFocus.current = selector;
  };
  const focusAfterDialogClose = () => {
    const selector = pendingMobileFocus.current;
    pendingMobileFocus.current = null;
    if (!selector) return;
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true });
    });
  };
  const startNewConversation = () => {
    if (menuOpen) pendingMobileFocus.current = 'textarea[aria-label="Message"]';
    void newConversation();
    setMenuOpen(false);
    if (!menuOpen) window.requestAnimationFrame(() =>
      composerRoot.current?.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')
        ?.focus({ preventScroll: true }));
  };
  useLayoutEffect(() => {
    const focused = document.activeElement;
    if (activeConversation?.historyState === "blocked") {
      if (
        composerHadFocus.current &&
        retryConversation.current &&
        composerRoot.current &&
        (focused === document.body ||
          (focused && composerRoot.current.contains(focused)))
      ) {
        retryConversation.current.focus({ preventScroll: true });
        composerHadFocus.current = false;
      }
    } else if (
      conversationReady &&
      retryHadFocus.current &&
      focused === document.body
    ) {
      composerRoot.current
        ?.querySelector<HTMLTextAreaElement>(
          'textarea[aria-label="Message"]:not([disabled])',
        )
        ?.focus({ preventScroll: true });
      retryHadFocus.current = false;
    }
  }, [activeConversation?.historyState, conversationReady]);
  if (error) {
    return (
      <main className="unavailable-page">
        <div className="unavailable-panel">
          <span>
            <WifiOff size={20} aria-hidden="true" />
          </span>
          <h1>Workspace unavailable</h1>
          <p>{error}</p>
          <button
            className="action-button unavailable-retry"
            type="button"
            onClick={() => window.location.reload()}
          >
            <RefreshCw size={15} /> Retry
          </button>
        </div>
      </main>
    );
  }

  if (!workspace)
    return (
      <main className="loading-page">
        <span className="loading-mark" aria-hidden="true" />
        <p role="status">Opening workspace</p>
      </main>
    );

  if (!activeAgent && workspace.agents.length)
    return (
      <AgentChooser
        workspace={workspace}
        error={connectionError}
        onSelect={(id) => navigate({ agentId: id, sessionId: null })}
        onLogout={() => {
          void logout();
        }}
        logoutDisabled={loggingOut}
        onRefresh={() => {
          void refreshWorkspace();
        }}
        refreshing={refreshing}
      />
    );
  if (!activeAgent) {
    return (
      <main className="unavailable-page">
        <div className="unavailable-panel">
          <span>
            <Bot size={20} aria-hidden="true" />
          </span>
          <h1>No Agent available</h1>
          <p>
            {workspace.principal.administrator
              ? "Create an Agent or assign one to this account in Control Center."
              : "Your organization has not assigned an Agent to this account yet."}
          </p>
          {connectionError ? (
            <div className="workspace-alert" role="alert">
              {connectionError}
            </div>
          ) : null}
          <div className="unavailable-actions">
            {workspace.principal.administrator ? (
              <a href="/">
                <Settings size={15} /> Control Center
              </a>
            ) : null}
            <button
              type="button"
              disabled={loggingOut}
              onClick={() => {
                void logout();
              }}
            >
              <LogOut size={15} /> Sign out
            </button>
          </div>
        </div>
      </main>
    );
  }

  const openingFailure = !preview && workspace.activeConversationId &&
    !conversationReady && !activeConversation?.messages.length
    ? history.error : undefined;
  return (
    <div className="app-shell">
      <Sidebar
        catalog={catalog}
        catalogDisabled={!connected}
        activeAgentId={activeAgent.id}
        activeConversationId={workspace.activeConversationId}
        agentSwitchDisabled={refreshing}
        agents={workspace.agents.map((agent) =>
          agent.id === activeAgent.id ? activeAgent : agent,
        )}
        conversations={workspace.conversations}
        open={menuOpen}
        principal={workspace.principal}
        onClose={() => setMenuOpen(false)}
        onClosed={focusAfterDialogClose}
        newConversationDisabled={creating || sending || !connected}
        logoutDisabled={loggingOut}
        onNewConversation={startNewConversation}
        onLogout={() => {
          void logout();
        }}
        onSelectAgent={(id) => {
          selectAgent(id);
          focusAfterMobileNavigation("#conversation-main");
        }}
        onSelectConversation={(sessionId) => {
          selectConversation(sessionId);
          focusAfterMobileNavigation(
            '[role="region"][aria-label="Conversation messages"]',
          );
        }}
        onChooseAgent={() => {
          navigate({ agentId: "", sessionId: null });
          focusAfterMobileNavigation('input[aria-label="Find a workspace"]');
        }}
      />
      <a className="skip-link" href="#conversation-main">
        Skip to conversation
      </a>
      <main className="workspace-main" id="conversation-main" tabIndex={-1}>
        <header className="workspace-topbar">
          <button
            className="icon-button mobile-menu"
            type="button"
            onClick={() => setMenuOpen(true)}
            aria-label="Open navigation"
            title="Open navigation"
            aria-haspopup="dialog"
            aria-expanded={menuOpen}
          >
            <Menu size={18} aria-hidden="true" />
          </button>
          <div className="topbar-agent">
            <div>
              <h1>{activeAgent.name}</h1>
              <small>{activeConversation?.title ?? "New conversation"}</small>
            </div>
            <AgentPresence status={activeAgent.status} announce />
          </div>
          <div className="topbar-actions">
            {!preview ? (
              <button
                className="icon-button"
                type="button"
                disabled={sending || refreshing}
                onClick={() => {
                  void refreshWorkspace();
                }}
                title="Refresh workspace"
                aria-label="Refresh workspace"
              >
                <RefreshCw
                  size={17}
                  className={refreshing ? "spin" : undefined}
                  aria-hidden="true"
                />
              </button>
            ) : null}
            {workspace.preview ? (
              <span className="preview-label">Preview</span>
            ) : null}
            <button
              className="icon-button topbar-new-conversation"
              type="button"
              disabled={creating || sending || !connected}
              onClick={startNewConversation}
              title="New conversation"
              aria-label="New conversation"
            >
              <Plus size={17} aria-hidden="true" />
            </button>
          </div>
        </header>
        <section
          className={`thread-region${workspace.activeConversationId === null ? " thread-draft" : ""}`}
          onFocusCapture={(event) => {
            composerHadFocus.current =
              composerRoot.current?.contains(event.target) ?? false;
          }}
          onBlurCapture={(event) => {
            if (
              event.relatedTarget &&
              !composerRoot.current?.contains(event.relatedTarget)
            )
              composerHadFocus.current = false;
          }}
        >
          <Thread
            agent={activeAgent}
            conversation={activeConversation}
            working={sessionWorking}
            settled={sessionSettled}
            opening={openingHistory || Boolean(openingFailure)}
            openingError={openingFailure}
            onRetryOpening={history.retry}
            onBackOpening={() => navigate({ agentId: activeAgent.id, sessionId: null })}
            hasOlderTurns={hasOlderTurns}
            hasNewerTurns={hasNewerTurns}
            historyGapAfter={historyGapAfter}
            onLoadOlder={onLoadOlder}
            onLoadNewer={onLoadNewer}
            onShowLatest={onShowLatest}
            onLoadContent={onLoadContent}
            onLoadProcess={onLoadProcess}
            onCancelProcess={onCancelProcess}
            onUnloadProcess={onUnloadProcess}
          />
          {connectionError ? (
            <div className="workspace-alert" role="alert">
              {connectionError}
            </div>
          ) : null}
          {interactionError ? (
            <div className="workspace-alert" role="alert">
              {interactionError}
            </div>
          ) : null}
          {history.error && !preview && !openingFailure ? (
            <div className="workspace-alert" role="alert">
              {history.error}{" "}
              <button
                ref={retryConversation}
                className="icon-button"
                type="button"
                disabled={!connected}
                title="Retry conversation"
                aria-label="Retry conversation"
                onClick={history.retry}
                onFocus={() => {
                  retryHadFocus.current = true;
                }}
                onBlur={(event) => {
                  if (event.relatedTarget) retryHadFocus.current = false;
                }}
              >
                <RefreshCw size={15} aria-hidden="true" />
              </button>
            </div>
          ) : null}
          <PermissionRequests
            requests={permissions}
            disabled={!connected}
            conversations={workspace.conversations}
            onOpen={selectConversation}
            onAnswer={onAnswerPermission}
          />
          <Composer
            rootRef={composerRoot}
            commandScope={JSON.stringify([activeAgent.id, workspace.activeConversationId])}
            commands={commands ?? (conversationReady ? activeConversation?.availableCommands ?? [] : [])}
            allowControlInput={allowControlInput}
            controlInput={controlInput}
            controlEnabled={controlEnabled}
            commanding={commanding}
            feedback={commandFeedback ? <CommandResponse result={commandFeedback} onDismiss={dismissCommandFeedback} /> : undefined}
            sessionControls={workspace.activeConversationId === null ?
              <span className="draft-defaults">Agent defaults</span> :
              <SessionSettings
                options={activeConversation?.configOptions ?? []}
                disabled={
                  !connected ||
                  !conversationReady ||
                  !stateReady ||
                  activeAgent.status !== "ready" ||
                  creating ||
                  configuring ||
                  commanding ||
                  sending
                }
                onChange={(id, value) => {
                  void setConfiguration(id, value);
                }}
              />}
            usage={
              <SessionUsage
                key={JSON.stringify([activeAgent.id, activeConversation?.id])}
                usage={activeConversation?.usage}
                stale={!connected || activeConversation?.usageStale === true}
              />
            }
            fileAccept={attachmentAccept(promptCapabilities)}
            configuring={configuring}
            preparing={creating}
            historyReady={
              conversationReady && (preview || Boolean(activeConversation))
            }
            draftMode={workspace.activeConversationId === null}
            sendBlocked={workspace.activeConversationId === null && creationUncertain}
            openingHistory={openingHistory}
            openingFailure={Boolean(openingFailure)}
            agentStatus={activeAgent.status}
            attachments={attachments}
            connected={connected}
            cancelling={cancelling}
            cancellable={cancellable}
            sending={sending}
            value={draft}
            onChange={setDraft}
            onFiles={addFiles}
            onRemoveAttachment={removeAttachment}
            onCancel={() => {
              void cancelRun();
            }}
            onSubmit={() => {
              void submit();
            }}
          />
        </section>
      </main>
    </div>
  );
}
