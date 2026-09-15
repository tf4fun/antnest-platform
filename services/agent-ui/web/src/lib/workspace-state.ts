import { z } from "zod";

const schema = z.object({
  agent_id: z.string().min(1),
  availability: z.enum(["ready", "busy", "offline"]),
  access_allowed: z.boolean(),
  configuration_revision: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  unavailable_reason: z.enum(["access_denied", "agent_unavailable", "runtime_barrier_required"]).nullable(),
  active_session_id: z.string().trim().min(1).max(200).nullable(),
}).strict();

export type WorkspaceState = z.infer<typeof schema>;
export type StateListener = { onState: (state: WorkspaceState) => void; onDisconnect: () => void };

export function parseWorkspaceState(data: string, agentID: string): WorkspaceState {
  if (data.length > 65536) throw new Error("Workspace state is too large.");
  const state = schema.parse(JSON.parse(data));
  if (state.agent_id !== agentID || !validState(state)) throw new Error("Invalid workspace state.");
  return state;
}

function validState(state: WorkspaceState): boolean {
  if (!state.access_allowed) return state.availability === "offline" && state.active_session_id === null &&
    state.configuration_revision === null && state.unavailable_reason === "access_denied";
  if (!state.configuration_revision) return false;
  switch (state.availability) {
    case "ready": return state.active_session_id === null && state.unavailable_reason === null;
    case "busy": return state.unavailable_reason === null || state.unavailable_reason === "agent_unavailable";
    case "offline": return state.active_session_id === null &&
      (state.unavailable_reason === "agent_unavailable" || state.unavailable_reason === "runtime_barrier_required");
  }
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
