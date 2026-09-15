import {
  Bot,
  LogOut,
  Menu,
  Plus,
  RefreshCw,
  Settings,
  WifiOff,
} from "lucide-react";
import { Composer } from "./components/Composer";
import { Thread } from "./components/Thread";
import { Sidebar } from "./components/Sidebar";
import { PermissionRequests } from "./components/PermissionRequests";
import { SessionSettings } from "./components/SessionSettings";
import { SessionUsage } from "./components/SessionUsage";
import { AgentChooser } from "./components/AgentChooser";
import { AgentPresence } from "./components/AgentPresence";
import { attachmentAccept } from "./lib/attachments";
import { useWorkspace } from "./lib/use-workspace";

export default function App() {
  const {
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
    interactionError,
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
  } = useWorkspace();
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
  const sessionWorking =
    (sending &&
      (!activePrompt || activePrompt.sessionID === activeConversation?.id)) ||
    Boolean(
      activeConversation &&
      (activePrompt?.sessionID === activeConversation.id ||
        (observation.state?.availability === "busy" &&
          observation.state.active_session_id === activeConversation.id)),
    );
  const sessionSettled =
    !sessionWorking &&
    connected &&
    conversationReady &&
    (preview ||
      observation.state?.availability === "ready" ||
      (observation.state?.availability === "busy" &&
        Boolean(observation.state.active_session_id) &&
        observation.state.active_session_id !== activeConversation?.id));
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
        newConversationDisabled={creating || sending || !connected}
        logoutDisabled={loggingOut}
        onNewConversation={() => {
          void newConversation();
        }}
        onLogout={() => {
          void logout();
        }}
        onSelectAgent={selectAgent}
        onSelectConversation={selectConversation}
        onChooseAgent={() => navigate({ agentId: "", sessionId: null })}
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
            <AgentPresence status={activeAgent.status} />
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
              className="icon-button"
              type="button"
              disabled={creating || sending || !connected}
              onClick={() => {
                void newConversation();
              }}
              title="New conversation"
              aria-label="New conversation"
            >
              <Plus size={17} aria-hidden="true" />
            </button>
          </div>
        </header>
        <section className="thread-region">
          <Thread
            agent={activeAgent}
            conversation={activeConversation}
            working={sessionWorking}
            settled={sessionSettled}
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
          {history.error && !preview ? (
            <div className="workspace-alert" role="alert">
              {history.error}{" "}
              <button
                className="icon-button"
                type="button"
                disabled={!connected}
                title="Retry conversation"
                aria-label="Retry conversation"
                onClick={history.retry}
              >
                <RefreshCw size={15} aria-hidden="true" />
              </button>
            </div>
          ) : null}
          <PermissionRequests
            requests={permissions}
            conversations={workspace.conversations}
            onOpen={selectConversation}
            onAnswer={(id, optionId) => {
              if (!connection?.answerPermission(id, optionId))
                setConnectionError(
                  "This permission request is no longer active.",
                );
            }}
          />
          <Composer
            sessionControls={
              <SessionSettings
                options={activeConversation?.configOptions ?? []}
                disabled={
                  !connected ||
                  !conversationReady ||
                  !stateReady ||
                  activeAgent.status !== "ready" ||
                  creating ||
                  configuring ||
                  sending
                }
                onChange={(id, value) => {
                  void setConfiguration(id, value);
                }}
              />
            }
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
            agentStatus={activeAgent.status}
            attachments={attachments}
            connected={connected}
            cancelling={cancelling}
            cancellable={
              Boolean(
                activePrompt ||
                (observation.state?.access_allowed &&
                  observation.state.active_session_id),
              ) && connected
            }
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
