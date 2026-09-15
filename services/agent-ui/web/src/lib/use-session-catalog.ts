import { useEffect, useRef, useState } from "react";
import type { ConnectedAgent } from "./client";
import type { Conversation } from "./types";

type CatalogState = {
  connection: ConnectedAgent;
  loading: boolean;
  hasMore: boolean;
  error?: string;
};

export function useSessionCatalog(
  connection: ConnectedAgent | undefined,
  onPage: (sessions: readonly Conversation[]) => void,
) {
  const [state, setState] = useState<CatalogState>();
  const request = useRef<() => void>(() => {});

  useEffect(() => {
    if (!connection) {
      request.current = () => {};
      return;
    }
    let disposed = false;
    let loading = false;
    let hasMore = true;
    const load = () => {
      if (disposed || loading || !hasMore) return;
      loading = true;
      setState({ connection, loading, hasMore });
      void connection
        .loadConversations()
        .then(
          (page) => {
            if (disposed) return;
            hasMore = page.hasMore;
            onPage(connection.conversations);
            setState({ connection, loading: false, hasMore });
          },
          (cause: unknown) => {
            if (disposed) return;
            setState({
              connection,
              loading: false,
              hasMore,
              error:
                cause instanceof Error
                  ? cause.message
                  : "Conversations could not be loaded.",
            });
          },
        )
        .finally(() => {
          loading = false;
        });
    };
    request.current = load;
    load();
    return () => {
      disposed = true;
      request.current = () => {};
    };
  }, [connection]);

  const current = state?.connection === connection ? state : undefined;
  return {
    loading: current?.loading ?? Boolean(connection),
    hasMore: current?.hasMore ?? false,
    error: current?.error,
    loadMore: () => request.current(),
  };
}
