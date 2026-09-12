import { z } from "zod";

const schema = z.object({
  agent_id: z.string().min(1),
  availability: z.enum(["ready", "busy", "offline"]),
  access_allowed: z.boolean(),
  agent_revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  active_session_id: z.string().trim().min(1).max(200).nullable(),
}).strict();

export type WorkspaceState = z.infer<typeof schema>;
export type StateListener = { onState: (state: WorkspaceState) => void; onDisconnect: () => void };

export function parseWorkspaceState(data: string, agentID: string): WorkspaceState {
  if (data.length > 65536) throw new Error("Workspace state is too large.");
  const state = schema.parse(JSON.parse(data));
  if (state.agent_id !== agentID || (!state.access_allowed && (state.availability !== "offline" || state.active_session_id !== null)) ||
    (state.availability === "ready" && state.active_session_id !== null)) throw new Error("Invalid workspace state.");
  return state;
}

// Own one stream only. Recovery belongs to the observer, not EventSource's implicit retry.
export function watchWorkspaceState(agentID: string, listener: StateListener): () => void {
  const source = new EventSource(`/api/app/agents/${encodeURIComponent(agentID)}/state/watch`);
  let closed = false;
  const close = () => { closed = true; source.close(); };
  const disconnect = () => { if (closed) return; close(); listener.onDisconnect(); };
  source.addEventListener("workspace_state", event => {
    if (closed) return;
    let state: WorkspaceState;
    try { state = parseWorkspaceState((event as MessageEvent<string>).data, agentID); }
    catch { disconnect(); return; }
    if (!state.access_allowed) close();
    listener.onState(state);
  });
  source.addEventListener("error", disconnect);
  return close;
}
