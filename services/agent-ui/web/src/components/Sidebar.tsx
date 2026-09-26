import {
  MessageSquareText,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RefreshCw,
  ChevronDown,
  Search,
} from "lucide-react";
import { useState } from "react";
import type { AgentSummary, Conversation, Principal } from "../lib/types";
import { conversationsForAgent, relativeTime } from "../lib/presentation";
import { Brand } from "./Brand";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { NavigationPanel, useMobileNavigation } from "./NavigationPanel";
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
  onClosed?: () => void;
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
  const [collapsed, setCollapsed] = useState(false);
  const mobile = useMobileNavigation();
  const compact = collapsed && !mobile;
  const activeAgent =
    props.agents.find(({ id }) => id === props.activeAgentId) ??
    props.agents[0];
  const switcher = (
    <WorkspaceSwitcher
      key={`${activeAgent?.id}:${compact}:${props.open}`}
      agents={props.agents}
      activeAgent={activeAgent}
      compact={compact}
      disabled={props.agentSwitchDisabled}
      onSelect={props.onSelectAgent}
      onBrowse={props.onChooseAgent}
    />
  );

  return (
    <NavigationPanel
      open={props.open}
      onClose={props.onClose}
      onClosed={props.onClosed}
      collapsed={compact}
    >
      {compact ? (
        <button
          className="icon-button"
          type="button"
          aria-label="Expand sidebar"
          title="Expand sidebar"
          onClick={() => setCollapsed(false)}
        >
          <PanelLeftOpen size={18} aria-hidden="true" />
        </button>
      ) : (
        <div className="sidebar-title-row">
          <Brand subtitle={switcher} />
          <button
            className="icon-button sidebar-collapse"
            type="button"
            onClick={() => setCollapsed(true)}
            title="Collapse sidebar"
            aria-label="Collapse sidebar"
          >
            <PanelLeftClose size={17} aria-hidden="true" />
          </button>
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
      )}
      {compact ? switcher : null}
      {compact ? (
        <button
          className="icon-button"
          type="button"
          aria-label="New conversation"
          title="New conversation"
          disabled={props.newConversationDisabled}
          onClick={props.onNewConversation}
        >
          <Plus size={18} aria-hidden="true" />
        </button>
      ) : null}
      <ConversationNavigation
        key={activeAgent?.id}
        {...props}
        agent={activeAgent}
        compact={compact}
      />
      {!compact ? (
        <>
          <div className="sidebar-spacer" />
          <AccountFooter
            principal={props.principal}
            onLogout={props.onLogout}
            logoutDisabled={props.logoutDisabled}
          />
        </>
      ) : null}
    </NavigationPanel>
  );
}

function ConversationNavigation({
  agent,
  compact,
  ...props
}: Props & { agent: AgentSummary | undefined; compact: boolean }) {
  const [query, setQuery] = useState("");
  if (compact) return null;
  const conversations = (
    agent ? conversationsForAgent(props.conversations, agent.id) : []
  ).filter((session) =>
    session.title
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );

  return (
    <section
      className="sidebar-section conversation-section"
      aria-label={`Conversations in ${agent?.name ?? "workspace"}`}
    >
      <button
        className="sidebar-new-conversation"
        type="button"
        disabled={props.newConversationDisabled}
        onClick={props.onNewConversation}
      >
        <Plus size={17} aria-hidden="true" />
        New conversation
      </button>
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
      <div className="section-heading">
        <span className="section-label">Conversations</span>
      </div>
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
      {props.catalog.hasMore || props.catalog.loading || props.catalog.error ? (
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
  );
}
