import { useEffect, useRef, useState } from "react";
import type { ConnectedAgent } from "./client";

type History = { connection: ConnectedAgent; sessionID: string; error?: string };

// Transport readiness and selected-history readiness are separate facts.
export function useConversationHistory(connection: ConnectedAgent | undefined, sessionID: string | null) {
  const [result, setResult] = useState<History>();
  const [attempt, setAttempt] = useState(0);
  const created = useRef<History | undefined>(undefined);
  useEffect(() => {
    if (!connection || !sessionID) return;
    if (created.current?.connection === connection && created.current.sessionID === sessionID) {
      setResult(created.current);
      created.current = undefined;
      return;
    }
    let disposed = false;
    setResult(undefined);
    void connection.loadConversation(sessionID).then(
      () => { if (!disposed) setResult({ connection, sessionID }); },
      (cause: unknown) => {
        if (!disposed) setResult({ connection, sessionID,
          error: cause instanceof Error && cause.message.trim() ? cause.message : "Conversation history could not be loaded." });
      },
    );
    return () => { disposed = true; };
  }, [connection, sessionID, attempt]);

  const selected = result?.connection === connection && result?.sessionID === sessionID ? result : undefined;
  return {
    ready: !sessionID || Boolean(selected && !selected.error),
    error: selected?.error,
    acceptCreated: (id: string) => {
      if (!connection) return;
      created.current = { connection, sessionID: id };
      setResult(created.current);
    },
    retry: () => { setResult(undefined); setAttempt(current => current + 1); },
  };
}
