import { Bot, LogOut, Menu, Plus, RefreshCw, Settings, WifiOff } from "lucide-react";
import { Composer } from "./components/Composer";
import { Thread } from "./components/Thread";
import { Sidebar } from "./components/Sidebar";
import { PermissionRequests } from "./components/PermissionRequests";
import { SessionSettings } from "./components/SessionSettings";
import { SessionUsage } from "./components/SessionUsage";
import { AgentChooser } from "./components/AgentChooser";
import { attachmentAccept } from "./lib/attachments";
import { useWorkspace } from "./lib/use-workspace";

export default function App() {
  const { workspace, error, menuOpen, setMenuOpen, draft, setDraft, attachments, sending, cancelling, loggingOut,
    connectionError, interactionError, permissions, configuring, creating, connection, refreshing, activePrompt, observation, history,
    activeAgent, stateReady, activeConversation, connected, conversationReady, preview, promptCapabilities,
    refreshWorkspace, logout, navigate, selectAgent, selectConversation, newConversation, setConfiguration,
    addFiles, removeAttachment, submit, cancelRun, setConnectionError } = useWorkspace();
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

  if (!activeAgent && workspace.agents.length) return <AgentChooser workspace={workspace} error={connectionError}
    onSelect={id => navigate({ agentId: id, sessionId: null })} onLogout={() => { void logout(); }} logoutDisabled={loggingOut} />;
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
  return (
    <div className="app-shell">
      {menuOpen ? <button className="mobile-scrim" type="button" aria-label="Close navigation" onClick={() => setMenuOpen(false)} /> : null}
      <Sidebar
        activeAgentId={activeAgent.id}
        activeConversationId={workspace.activeConversationId}
        agentSwitchDisabled={refreshing}
        agents={workspace.agents.map(agent => agent.id === activeAgent.id ? activeAgent : agent)}
        conversations={workspace.conversations}
        open={menuOpen}
        principal={workspace.principal}
        onClose={() => setMenuOpen(false)}
        newConversationDisabled={creating || sending || !connected}
        logoutDisabled={loggingOut}
        onNewConversation={() => { void newConversation(); }}
        onLogout={() => { void logout(); }}
        onSelectAgent={selectAgent}
        onSelectConversation={selectConversation}
        onChooseAgent={() => navigate({ agentId: "", sessionId: null })}
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
          <Thread agent={activeAgent} conversation={activeConversation} working={sending && (!activePrompt || activePrompt.sessionID === activeConversation?.id)} />
          {connectionError ? <div className="workspace-alert" role="alert">{connectionError}</div> : null}
          {interactionError ? <div className="workspace-alert" role="alert">{interactionError}</div> : null}
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
