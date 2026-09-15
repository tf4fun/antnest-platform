import {
  ArrowUpRight,
  Bot,
  LogOut,
  RefreshCw,
  Search,
  Settings,
  X,
} from "lucide-react";
import { useId, useState } from "react";
import type { WorkspaceSnapshot } from "../lib/types";
import { workspacePath } from "../lib/navigation";
import { Brand } from "./Brand";
import { AgentManagementStatus } from "./AgentManagementStatus";

export function AgentChooser({
  workspace,
  error,
  onSelect,
  onLogout,
  logoutDisabled,
  onRefresh,
  refreshing,
}: {
  workspace: WorkspaceSnapshot;
  error?: string;
  onSelect: (id: string) => void;
  onLogout: () => void;
  logoutDisabled: boolean;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const [query, setQuery] = useState("");
  const statusId = useId();
  const filtering = query.trim().length > 0;
  const agents = workspace.agents.filter((agent) =>
    `${agent.name} ${agent.id}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );
  return (
    <main className="agent-chooser">
      <section
        className="chooser-content"
        aria-labelledby="agent-directory-heading"
      >
        <div className="chooser-brand-row">
          <Brand />
          <span className="chooser-account">
            {workspace.principal.displayName}
          </span>
        </div>
        <header className="chooser-header">
          <div>
            <p className="chooser-kicker">
              {workspace.principal.organizationName}
            </p>
            <h1 id="agent-directory-heading">Your agents</h1>
          </div>
          <nav className="chooser-actions" aria-label="Workspace actions">
            <button
              className="icon-button"
              type="button"
              onClick={onRefresh}
              disabled={refreshing}
              title="Refresh agents"
              aria-label="Refresh agents"
            >
              <RefreshCw
                size={17}
                aria-hidden="true"
                className={refreshing ? "spin" : undefined}
              />
            </button>
            {workspace.principal.administrator ? (
              <a
                className="icon-button"
                href="/"
                title="Open Control Center"
                aria-label="Open Control Center"
              >
                <Settings size={17} aria-hidden="true" />
              </a>
            ) : null}
            <button
              className="icon-button"
              type="button"
              onClick={onLogout}
              disabled={logoutDisabled}
              title="Sign out"
              aria-label="Sign out"
            >
              <LogOut size={17} aria-hidden="true" />
            </button>
          </nav>
        </header>
        {error ? (
          <p className="workspace-alert" role="alert">
            {error}
          </p>
        ) : null}
        <div className="search-field chooser-search" role="search">
          <Search size={16} aria-hidden="true" />
          <input
            type="search"
            aria-label="Find an agent"
            placeholder="Find an agent"
            aria-describedby={statusId}
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && query) {
                event.preventDefault();
                setQuery("");
              }
            }}
          />
          {query ? (
            <button
              className="icon-button"
              type="button"
              aria-label="Clear search"
              title="Clear search"
              onClick={() => setQuery("")}
            >
              <X size={16} aria-hidden="true" />
            </button>
          ) : null}
        </div>
        <p className="chooser-count" id={statusId} role="status">
          {filtering
            ? `${agents.length} of ${workspace.agents.length} agents`
            : `${agents.length} ${agents.length === 1 ? "agent" : "agents"}`}
        </p>
        <div className="chooser-list" aria-busy={refreshing}>
          {agents.map((agent) => (
            <a
              className="chooser-agent"
              key={agent.id}
              href={workspacePath({ agentId: agent.id, sessionId: null })}
              onClick={(event) => {
                if (
                  event.button !== 0 ||
                  event.metaKey ||
                  event.ctrlKey ||
                  event.shiftKey ||
                  event.altKey
                )
                  return;
                event.preventDefault();
                onSelect(agent.id);
              }}
            >
              <span className="chooser-avatar">
                <Bot size={21} aria-hidden="true" />
              </span>
              <strong className="chooser-title">{agent.name}</strong>
              <ArrowUpRight
                className="chooser-arrow"
                size={16}
                aria-hidden="true"
              />
              <span className="chooser-id">{agent.id}</span>
              <span className="chooser-meta">
                <AgentManagementStatus state={agent.managementState} />
              </span>
            </a>
          ))}
        </div>
        {!agents.length ? (
          <div className="chooser-empty">
            <Bot size={28} aria-hidden="true" />
            <h2>{filtering ? "No matching agents" : "No Agent available"}</h2>
          </div>
        ) : null}
      </section>
    </main>
  );
}
