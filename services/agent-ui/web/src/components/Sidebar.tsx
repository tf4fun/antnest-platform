import { Bot, Check, LogOut, MessageSquareText, PanelLeftClose, Plus, Settings, X } from "lucide-react";
import type { AgentSummary, Conversation, Principal } from "../lib/types";
import { conversationsForAgent, relativeTime } from "../lib/presentation";
import { Brand } from "./Brand";

type Props = {
  agents: AgentSummary[];
  conversations: Conversation[];
  activeAgentId: string;
  activeConversationId: string | null;
  principal: Principal;
  open: boolean;
  agentSwitchDisabled: boolean;
  newConversationDisabled: boolean;
  logoutDisabled: boolean;
  onClose: () => void;
  onSelectAgent: (id: string) => void;
  onSelectConversation: (id: string) => void;
  onNewConversation: () => void;
  onLogout: () => void;
};

const statusLabel: Record<AgentSummary["status"], string> = {
  ready: "Ready",
  busy: "Working",
  offline: "Offline",
};

export function Sidebar(props: Props) {
  const activeAgent = props.agents.find(({ id }) => id === props.activeAgentId) ?? props.agents[0];
  const conversations = activeAgent ? conversationsForAgent(props.conversations, activeAgent.id) : [];
  const initials = props.principal.displayName.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();

  return (
    <aside className={`sidebar ${props.open ? "sidebar-open" : ""}`}>
      <div className="sidebar-brand-row">
        <Brand />
        <button className="icon-button sidebar-close" type="button" onClick={props.onClose} aria-label="Close navigation">
          <PanelLeftClose size={17} aria-hidden="true" />
        </button>
      </div>

      <section className="sidebar-section agent-section">
        <span className="section-label">Agent</span>
        <div className="agent-list">
          {props.agents.map((agent) => (
            <button
              className={`agent-option ${agent.id === props.activeAgentId ? "active" : ""}`}
              key={agent.id}
              type="button"
              disabled={props.agentSwitchDisabled && agent.id !== props.activeAgentId}
              onClick={() => props.onSelectAgent(agent.id)}
            >
              <span className="agent-option-icon"><Bot size={15} aria-hidden="true" /></span>
              <span className="agent-option-copy">
                <strong>{agent.name}</strong>
                <small>{statusLabel[agent.status]} · {agent.modelLabel}</small>
              </span>
              {agent.id === props.activeAgentId ? <Check size={14} aria-hidden="true" /> : <span className={`status-dot status-${agent.status}`} />}
            </button>
          ))}
        </div>
      </section>

      <section className="sidebar-section conversation-section">
        <div className="section-heading">
          <span className="section-label">Conversations</span>
          <button className="icon-button" type="button" disabled={props.newConversationDisabled} onClick={props.onNewConversation} title="New conversation" aria-label="New conversation">
            <Plus size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="conversation-list">
          {conversations.length ? conversations.map((conversation) => (
            <button
              className={`conversation-option ${conversation.id === props.activeConversationId ? "active" : ""}`}
              key={conversation.id}
              type="button"
              onClick={() => props.onSelectConversation(conversation.id)}
            >
              <MessageSquareText size={14} aria-hidden="true" />
              <span><strong>{conversation.title}</strong><small>{relativeTime(conversation.updatedAt)}</small></span>
            </button>
          )) : <p className="sidebar-empty">No conversations yet</p>}
        </div>
      </section>

      <div className="sidebar-spacer" />
      <footer className="profile-row">
        <span className="profile-avatar">{initials}</span>
        <span className="profile-copy"><strong>{props.principal.displayName}</strong><small>{props.principal.organizationName}</small></span>
        <span className="profile-actions">
          {props.principal.administrator ? (
            <a className="icon-button" href="/" title="Open Control Center" aria-label="Open Control Center">
              <Settings size={15} aria-hidden="true" />
            </a>
          ) : null}
          <button className="icon-button" type="button" disabled={props.logoutDisabled} onClick={props.onLogout} title="Sign out" aria-label="Sign out">
            <LogOut size={15} aria-hidden="true" />
          </button>
        </span>
      </footer>
      <button className="sidebar-overlay-close" type="button" onClick={props.onClose} aria-label="Close navigation"><X /></button>
    </aside>
  );
}
