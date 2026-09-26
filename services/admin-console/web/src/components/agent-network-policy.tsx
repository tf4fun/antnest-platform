import { useCallback, useEffect, useRef, useState } from "react";
import { Globe, LoaderCircle, RefreshCw } from "lucide-react";
import { api, APIError, errorMessage } from "../lib/api";
import {
  clearPendingNetwork,
  networkFailureUncertain,
  pendingNetworkKey,
  readPendingNetwork,
  savePendingNetwork,
  type NetworkPolicy,
  type PendingNetwork,
} from "../lib/network-policy";
import type { Agent } from "../lib/types";
import { Section } from "./page";
import { Button } from "./ui/button";
import { ErrorNotice, SuccessNotice } from "./ui/feedback";

type Props = { agent: Agent; scope?: string; refreshRevision?: number };
type Problem = {
  kind: "uncertain" | "conflict" | "definite" | "identity";
  message: string;
};

export function AgentNetworkPolicy({ agent, scope, refreshRevision }: Props) {
  if (
    agent.desired_state === "deleted" ||
    agent.lifecycle_state === "deleted"
  )
    return null;
  return (
    <NetworkPolicyControl
      key={JSON.stringify([scope, agent.agent_id])}
      agent={agent}
      scope={scope}
      refreshRevision={refreshRevision}
    />
  );
}

function NetworkPolicyControl({ agent, scope, refreshRevision }: Props) {
  const [policy, setPolicy] = useState<NetworkPolicy>();
  const [intent, setIntent] = useState<PendingNetwork>();
  const [problem, setProblem] = useState<Problem>();
  const [readError, setReadError] = useState("");
  const [storageError, setStorageError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const live = useRef(true);
  const busy = useRef(false);
  const refreshQueued = useRef(false);
  const readSequence = useRef(0);
  const readController = useRef<AbortController | undefined>(undefined);

  const restoreIntent = useCallback(() => {
    if (scope && live.current) {
      try {
        const pending = readPendingNetwork(
          window.localStorage,
          scope,
          agent.agent_id,
        );
        setIntent(pending);
        setProblem((current) =>
          current?.kind === "identity"
            ? current
            : pending
              ? {
                  kind: "uncertain",
                  message: "The previous network update is unconfirmed.",
                }
              : undefined,
        );
      } catch (cause) {
        setStorageError(errorMessage(cause));
      }
    }
  }, [scope, agent.agent_id]);

  useEffect(() => {
    live.current = true;
    restoreIntent();
    return () => {
      live.current = false;
      readSequence.current += 1;
      readController.current?.abort();
    };
  }, [restoreIntent]);

  const refresh = useCallback(async () => {
    if (busy.current) {
      refreshQueued.current = true;
      return;
    }
    const sequence = ++readSequence.current;
    readController.current?.abort();
    const controller = new AbortController();
    readController.current = controller;
    setLoading(true);
    try {
      const result = await api.networkPolicy(agent.agent_id, controller.signal);
      if (!live.current || sequence !== readSequence.current) return;
      setPolicy(result);
      setReadError("");
      setProblem((current) =>
        current?.kind === "conflict" ? undefined : current,
      );
    } catch (cause) {
      if (live.current && sequence === readSequence.current)
        setReadError(errorMessage(cause));
    } finally {
      if (live.current && sequence === readSequence.current) setLoading(false);
    }
  }, [agent.agent_id]);

  useEffect(() => {
    void refresh();
  }, [
    refresh,
    agent.lifecycle_state,
    agent.activation_state,
    agent.runtime?.runtime_revision,
    refreshRevision,
  ]);

  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (
        !scope ||
        (event.key !== null &&
          !event.key.startsWith(pendingNetworkKey(scope, agent.agent_id)))
      )
        return;
      if (!busy.current) restoreIntent();
      void refresh();
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, [scope, agent.agent_id, restoreIntent, refresh]);

  async function send(next: PendingNetwork) {
    if (!scope || busy.current) return;
    try {
      savePendingNetwork(window.localStorage, scope, agent.agent_id, next);
    } catch (cause) {
      setStorageError(errorMessage(cause));
      return;
    }
    busy.current = true;
    readSequence.current += 1;
    setLoading(false);
    setSaving(true);
    setSaved(false);
    setIntent(next);
    setProblem(undefined);
    try {
      const result = await api.setNetworkPolicy(agent.agent_id, next, scope);
      if (!live.current) return;
      clearPendingNetwork(window.localStorage, scope, agent.agent_id, next);
      setPolicy((current) => (current ? { ...current, ...result } : current));
      restoreIntent();
      setSaved(true);
    } catch (cause) {
      if (!live.current) return;
      if (cause instanceof APIError && cause.code === "principal_changed") {
        setProblem({ kind: "identity", message: errorMessage(cause) });
        return;
      }
      const uncertain = networkFailureUncertain(cause);
      if (!uncertain) {
        try {
          clearPendingNetwork(window.localStorage, scope, agent.agent_id, next);
          restoreIntent();
        } catch (failure) {
          setStorageError(errorMessage(failure));
        }
      }
      const conflict =
        cause instanceof APIError && cause.code === "resource_version_conflict";
      setProblem({
        kind: uncertain ? "uncertain" : conflict ? "conflict" : "definite",
        message: errorMessage(cause),
      });
    } finally {
      busy.current = false;
      if (live.current) {
        setSaving(false);
        if (refreshQueued.current) {
          refreshQueued.current = false;
          void refresh();
        }
      }
    }
  }

  const disabled =
    !scope ||
    !policy ||
    loading ||
    saving ||
    Boolean(intent || readError || storageError) ||
    problem?.kind === "conflict" ||
    problem?.kind === "identity";
  const allowed = policy?.action === "allow_all";
  const displayedProblem =
    problem ??
    (intent && !saving
      ? {
          kind: "uncertain",
          message: "The previous network update is unconfirmed.",
        }
      : undefined);
  return (
    <Section title="Network">
      <div className="flex min-w-0 items-center justify-between gap-4 border-y border-border py-4">
        <div className="flex min-w-0 items-center gap-3">
          <Globe
            className="h-5 w-5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <div className="min-w-0">
            <p
              className="text-sm font-medium"
              id={`network-label-${agent.agent_id}`}
            >
              Public internet access
            </p>
            <p
              className="mt-1 text-xs text-muted-foreground"
              role="status"
              aria-label="Network policy status"
            >
              {saving
                ? "Saving network policy..."
                : loading
                  ? "Loading network policy..."
                  : policy
                    ? allowed
                      ? "Allowed"
                      : "Blocked"
                    : "Unavailable"}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            role="switch"
            aria-checked={allowed}
            aria-labelledby={`network-label-${agent.agent_id}`}
            disabled={disabled}
            className={`inline-flex h-6 w-11 shrink-0 items-center rounded-full border-2 border-transparent transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${allowed ? "bg-primary" : "bg-slate-300"}`}
            onClick={() => {
              if (!disabled && policy)
                void send({
                  action: allowed ? "deny_all" : "allow_all",
                  expected_resource_version: policy.resource_version,
                  idempotency_key: crypto.randomUUID(),
                });
            }}
          >
            <span
              className={`pointer-events-none block h-5 w-5 rounded-full bg-white shadow-xs transition-transform ${allowed ? "translate-x-5" : "translate-x-0"}`}
            />
          </button>
          <Button
            variant="ghost"
            size="icon"
            title="Refresh network policy"
            aria-label="Refresh network policy"
            disabled={loading || saving}
            onClick={() => void refresh()}
          >
            {loading ? (
              <LoaderCircle className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
          </Button>
        </div>
      </div>
      <div className="mt-3 grid gap-3">
        {policy?.attachment.state === "closed" ||
        agent.activation_state === "disabled" ? (
          <p className="text-sm text-muted-foreground">
            Agent network is paused.
          </p>
        ) : null}
        {saved ? (
          <SuccessNotice
            message="Network policy saved."
            onDismiss={() => setSaved(false)}
          />
        ) : null}
        {readError ? <ErrorNotice message={readError} /> : null}
        {storageError ? <ErrorNotice message={storageError} /> : null}
        {displayedProblem ? (
          <ErrorNotice
            message={
              displayedProblem.kind === "uncertain"
                ? `Network update is unconfirmed. ${displayedProblem.message}`
                : displayedProblem.message
            }
            action={
              intent &&
              !storageError &&
              displayedProblem.kind !== "identity" ? (
                <Button
                  variant="secondary"
                  disabled={saving || loading}
                  onClick={() => void send(intent)}
                >
                  Retry network update
                </Button>
              ) : undefined
            }
          />
        ) : null}
      </div>
    </Section>
  );
}
