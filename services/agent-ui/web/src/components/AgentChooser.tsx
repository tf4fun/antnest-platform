import { ArrowUpRight, Bot, LogOut, Search, Settings } from "lucide-react";
import { useState } from "react";
import type { WorkspaceSnapshot } from "../lib/types";
import { Brand } from "./Brand";

export function AgentChooser({ workspace, error, onSelect, onLogout, logoutDisabled }: {
  workspace: WorkspaceSnapshot; error?: string; onSelect: (id: string) => void; onLogout: () => void; logoutDisabled: boolean;
}) {
  const [query, setQuery] = useState("");
  const agents = workspace.agents.filter(agent => `${agent.name} ${agent.id}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <main className="agent-chooser">
    <header className="chooser-topbar"><Brand /><nav aria-label="Account">
      {workspace.principal.administrator ? <a className="icon-button" href="/" title="Open Control Center" aria-label="Open Control Center"><Settings size={18} /></a> : null}
      <button className="icon-button" type="button" disabled={logoutDisabled} onClick={onLogout} title="Sign out" aria-label="Sign out"><LogOut size={18} /></button>
    </nav></header>
    <section className="chooser-content">
      <div className="chooser-heading"><h1>Your agents</h1><span>{workspace.agents.length}</span></div>
      {error ? <p className="workspace-alert" role="alert">{error}</p> : null}
      <label className="search-field"><Search size={17} aria-hidden="true" /><input type="search" aria-label="Find an agent" placeholder="Find an agent" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <div className="chooser-list">
        {agents.map(agent => <button className="chooser-agent" key={agent.id} onClick={() => onSelect(agent.id)}>
          <span className="chooser-avatar"><Bot size={23} aria-hidden="true" /></span>
          <span className="chooser-copy"><strong>{agent.name}</strong><small>{agent.id}</small></span>
          <ArrowUpRight size={19} aria-hidden="true" />
        </button>)}
      </div>
      {!agents.length ? <p className="chooser-empty">{workspace.agents.length ? "No matching agents" : "No Agent available"}</p> : null}
    </section>
  </main>;
}
