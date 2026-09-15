import {
  Bot,
  Check,
  ChevronLeft,
  MessageSquareText,
  PanelLeftClose,
  Plus,
  RefreshCw,
  ChevronDown,
  Search,
} from "lucide-react";
import { useState } from "react";
import type { AgentSummary, Conversation, Principal } from "../lib/types";
import { conversationsForAgent, relativeTime } from "../lib/presentation";
import { Brand } from "./Brand";
import { AgentPresence } from "./AgentPresence";
import { AgentManagementStatus } from "./AgentManagementStatus";
import { NavigationPanel } from "./NavigationPanel";
import { AccountFooter } from "./AccountFooter";

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
  onChooseAgent: () => void;
  catalog: {
    loading: boolean;
    hasMore: boolean;
    error?: string;
    loadMore: () => void;
  };
  catalogDisabled: boolean;
};

export function Sidebar(props: Props) {
  const [query, setQuery] = useState("");
  const activeAgent =
    props.agents.find(({ id }) => id === props.activeAgentId) ??
    props.agents[0];
  const conversations = (
    activeAgent
      ? conversationsForAgent(props.conversations, activeAgent.id)
      : []
  ).filter((session) =>
    session.title
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );

  return (
    <NavigationPanel open={props.open} onClose={props.onClose}>
      <div className="sidebar-brand-row">
        <Brand />
        <button
          className="icon-button sidebar-close"
          type="button"
          onClick={props.onClose}
          title="Close navigation"
          aria-label="Close navigation"
        >
          <PanelLeftClose size={17} aria-hidden="true" />
        </button>
      </div>

      <section className="sidebar-section agent-section">
        <button
          className="back-to-agents"
          type="button"
          onClick={props.onChooseAgent}
        >
          <ChevronLeft size={14} aria-hidden="true" />
          All agents
        </button>
        <div className="agent-list">
          {props.agents.map((agent) => (
            <button
              className={`agent-option ${agent.id === props.activeAgentId ? "active" : ""}`}
              key={agent.id}
              type="button"
              aria-current={
                agent.id === props.activeAgentId ? "true" : undefined
              }
              disabled={
                props.agentSwitchDisabled && agent.id !== props.activeAgentId
              }
              onClick={() => props.onSelectAgent(agent.id)}
            >
              <span className="agent-option-icon">
                <Bot size={15} aria-hidden="true" />
              </span>
              <span className="agent-option-copy">
                <strong>{agent.name}</strong>
                {agent.id === props.activeAgentId ? (
                  <AgentPresence status={agent.status} />
                ) : (
                  <AgentManagementStatus state={agent.managementState} />
                )}
              </span>
              {agent.id === props.activeAgentId ? (
                <Check size={14} aria-hidden="true" />
              ) : null}
            </button>
          ))}
        </div>
      </section>

      <section className="sidebar-section conversation-section">
        <div className="section-heading">
          <span className="section-label">Conversations</span>
          <button
            className="icon-button"
            type="button"
            disabled={props.newConversationDisabled}
            onClick={props.onNewConversation}
            title="New conversation"
            aria-label="New conversation"
          >
            <Plus size={16} aria-hidden="true" />
          </button>
        </div>
        <label className="search-field session-search">
          <Search size={14} aria-hidden="true" />
          <input
            type="search"
            placeholder="Search conversations"
            aria-label="Search conversations"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="conversation-list">
          {conversations.length ? (
            conversations.map((conversation) => (
              <button
                className={`conversation-option ${conversation.id === props.activeConversationId ? "active" : ""}`}
                key={conversation.id}
                type="button"
                aria-current={
                  conversation.id === props.activeConversationId
                    ? "page"
                    : undefined
                }
                onClick={() => props.onSelectConversation(conversation.id)}
              >
                <MessageSquareText size={14} aria-hidden="true" />
                <span>
                  <strong>{conversation.title}</strong>
                  <small>
                    <time
                      dateTime={conversation.updatedAt}
                      title={new Date(conversation.updatedAt).toLocaleString()}
                    >
                      {relativeTime(conversation.updatedAt)}
                    </time>
                  </small>
                </span>
              </button>
            ))
          ) : (
            <p className="sidebar-empty">
              {query
                ? "No matching loaded conversations"
                : props.catalog.loading
                  ? "Loading conversations"
                  : props.catalog.error
                    ? "Conversations unavailable"
                    : "No conversations yet"}
            </p>
          )}
        </div>
        {props.catalog.error ? (
          <p className="catalog-error" role="alert">
            {props.catalog.error}
          </p>
        ) : null}
        {props.catalog.hasMore ||
        props.catalog.loading ||
        props.catalog.error ? (
          <button
            className="catalog-more"
            type="button"
            disabled={props.catalogDisabled || props.catalog.loading}
            onClick={props.catalog.loadMore}
            aria-label={
              props.catalog.error
                ? "Retry conversations"
                : "Load more conversations"
            }
          >
            {props.catalog.error ? (
              <RefreshCw size={14} aria-hidden="true" />
            ) : (
              <ChevronDown size={14} aria-hidden="true" />
            )}
            {props.catalog.loading
              ? "Loading conversations"
              : props.catalog.error
                ? "Retry"
                : "Load more"}
          </button>
        ) : null}
      </section>

      <div className="sidebar-spacer" />
      <AccountFooter
        principal={props.principal}
        onLogout={props.onLogout}
        logoutDisabled={props.logoutDisabled}
      />
    </NavigationPanel>
  );
}
