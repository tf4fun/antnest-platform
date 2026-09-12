import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentUIClient } from "./client";
import type { WorkspaceSnapshot } from "./types";
import type { WorkspaceState } from "./workspace-state";

type Observation = { scope: object; subscription: object; state: WorkspaceState };

export function useWorkspaceState(client: AgentUIClient, agentID: string | undefined, onWorkspace: (workspace: WorkspaceSnapshot, reconnect: boolean) => void) {
  const [observation, setObservation] = useState<Observation>();
  const [attempt, setAttempt] = useState(0);
  const scope = useMemo(() => ({ agentID, attempt }), [agentID, attempt]);
  const refreshAccess = useRef(false);
  const acceptWorkspace = useRef(onWorkspace);
  useEffect(() => { acceptWorkspace.current = onWorkspace; });

  useEffect(() => {
    if (!agentID) return;
    const request = new AbortController();
    let stop = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    let epoch = 0;
    let failures = 0;
    let connectedAt = 0;

    const disconnected = () => {
      if (request.signal.aborted) return;
      epoch++;
      stop();
      clearTimeout(timer);
      setObservation(undefined);
      if (connectedAt && Date.now() - connectedAt >= 30000) failures = 0;
      connectedAt = 0;
      const delay = Math.min(30000, 1000 * 2 ** Math.min(failures++, 5));
      timer = setTimeout(() => { void recover(); }, delay);
    };
    const subscribe = () => {
      if (request.signal.aborted) return;
      const current = ++epoch;
      const subscription = {};
      timer = setTimeout(disconnected, 15000);
      try {
        stop = client.watchState(agentID, {
          onState: state => {
            if (request.signal.aborted || current !== epoch) return;
            clearTimeout(timer);
            connectedAt ||= Date.now();
            setObservation({ scope, subscription, state });
          },
          onDisconnect: () => { if (current === epoch) disconnected(); },
        });
      } catch { disconnected(); }
    };
    const recover = async (reconnect = true) => {
      try {
        const workspace = await client.loadWorkspace(request.signal);
        if (request.signal.aborted) return;
        acceptWorkspace.current(workspace, reconnect);
        subscribe();
      } catch { disconnected(); }
    };

    if (refreshAccess.current) { refreshAccess.current = false; void recover(false); }
    else subscribe();
    return () => { request.abort(); epoch++; stop(); clearTimeout(timer); };
  }, [client, agentID, scope]);

  const refresh = useCallback((authenticate = true) => {
    refreshAccess.current = authenticate;
    setObservation(undefined);
    setAttempt(value => value + 1);
  }, []);
  const selected = observation?.scope === scope ? observation : undefined;
  return { state: selected?.state, subscription: selected?.subscription, refresh };
}
