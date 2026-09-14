import { useCallback, useEffect, useRef, useState } from "react";
import type { AuditPage } from "../lib/execution-audit";
import { mergePage } from "../lib/pagination";
import { resourceFailure, type ResourceFailure } from "../lib/resource-failure";
import type { ResourceState } from "../lib/resource-state";

export function useAuditRead<T>(read: (signal: AbortSignal) => Promise<T>) {
  const [state, setState] = useState<ResourceState<T>>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const request = new AbortController();
    setState({ status: "loading" });
    void read(request.signal)
      .then((data) => {
        if (!request.signal.aborted) setState({ status: "ready", data });
      })
      .catch((cause: unknown) => {
        if (!request.signal.aborted)
          setState({ status: "error", failure: resourceFailure(cause) });
      });
    return () => request.abort();
  }, [read, attempt]);
  return { state, retry: () => setAttempt((value) => value + 1) };
}

export function useAuditPage<T>(
  read: (
    cursor: string | undefined,
    signal: AbortSignal,
  ) => Promise<AuditPage<T>>,
  identity: (item: T) => string,
) {
  const [items, setItems] = useState<T[]>();
  const [cursor, setCursor] = useState<string | null>(null);
  const [pending, setPending] = useState(true);
  const [failure, setFailure] = useState<ResourceFailure>();
  const request = useRef<AbortController | undefined>(undefined);
  const busy = useRef(false);
  const load = useCallback(
    async (after?: string) => {
      if (busy.current) return;
      busy.current = true;
      request.current?.abort();
      const current = new AbortController();
      request.current = current;
      setPending(true);
      setFailure(undefined);
      if (!after) setItems(undefined);
      try {
        const page = await read(after, current.signal);
        if (current.signal.aborted) return;
        setItems((old) =>
          after ? mergePage(old ?? [], page.items, identity) : page.items,
        );
        setCursor(page.next_cursor);
      } catch (cause) {
        if (!current.signal.aborted) setFailure(resourceFailure(cause));
      } finally {
        if (!current.signal.aborted) {
          busy.current = false;
          setPending(false);
        }
      }
    },
    [read, identity],
  );
  useEffect(() => {
    void load();
    return () => {
      request.current?.abort();
      busy.current = false;
    };
  }, [load]);
  return {
    items,
    pending,
    failure,
    hasMore: cursor !== null,
    refresh: () => void load(),
    loadMore: () => void load(cursor ?? undefined),
  };
}
