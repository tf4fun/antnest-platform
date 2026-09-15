import { useEffect, useRef, useState } from "react";
import { LoaderCircle, RefreshCw } from "lucide-react";
import { api, APIError, errorMessage } from "../lib/api";
import {
  catalogLabels,
  referenceLinks,
  type AvailabilityChange,
  type CatalogKind,
} from "../lib/catalog-availability";
import { Button } from "./ui/button";
import { ErrorNotice, SuccessNotice } from "./ui/feedback";

type Props = {
  kind: CatalogKind;
  resourceID: string;
  enabled: boolean;
  disabled?: boolean;
  onReload: (signal: AbortSignal) => Promise<void>;
  onBusyChange?: (busy: boolean) => void;
};
type State =
  | { kind: "idle" | "saving" | "refreshing" | "saved" }
  | { kind: "uncertain"; intent: AvailabilityChange; message: string }
  | { kind: "rejected"; cause: unknown }
  | { kind: "refresh_failed"; saved: boolean; message: string };

export function CatalogAvailabilityControl(props: Props) {
  return (
    <AvailabilityControl key={`${props.kind}:${props.resourceID}`} {...props} />
  );
}

function AvailabilityControl({
  kind,
  resourceID,
  enabled,
  disabled,
  onReload,
  onBusyChange,
}: Props) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const live = useRef(true);
  const busy = useRef(false);
  const readController = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      readController.current?.abort();
    };
  }, []);

  const blocksEditing = [
    "saving",
    "refreshing",
    "uncertain",
    "refresh_failed",
  ].includes(state.kind);
  useEffect(() => {
    onBusyChange?.(blocksEditing);
    return () => onBusyChange?.(false);
  }, [blocksEditing, onBusyChange]);

  async function reload(saved: boolean) {
    setState({ kind: "refreshing" });
    const controller = new AbortController();
    readController.current = controller;
    try {
      await onReload(controller.signal);
      if (live.current) setState({ kind: saved ? "saved" : "idle" });
    } catch (cause) {
      if (live.current)
        setState({
          kind: "refresh_failed",
          saved,
          message: errorMessage(cause),
        });
    }
  }

  async function refresh(saved: boolean) {
    if (busy.current || disabled) return;
    busy.current = true;
    try {
      await reload(saved);
    } finally {
      busy.current = false;
    }
  }

  async function send(intent: AvailabilityChange) {
    if (busy.current || disabled) return;
    busy.current = true;
    setState({ kind: "saving" });
    try {
      await api.setCatalogAvailability(kind, resourceID, intent);
      if (live.current) await reload(true);
    } catch (cause) {
      if (!live.current) return;
      const definite =
        cause instanceof APIError &&
        cause.status >= 400 &&
        cause.status < 500 &&
        ![408, 429].includes(cause.status);
      setState(
        definite
          ? { kind: "rejected", cause }
          : { kind: "uncertain", intent, message: errorMessage(cause) },
      );
    } finally {
      busy.current = false;
    }
  }

  const pending = state.kind === "saving" || state.kind === "refreshing";
  const toggleDisabled = disabled || !["idle", "saved"].includes(state.kind);
  const label = `${catalogLabels[kind]} enabled`;
  return (
    <section
      className="grid min-w-0 gap-3 border-y border-border py-4"
      aria-label={`${catalogLabels[kind]} availability`}
    >
      <div className="flex min-w-0 items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium">{label}</p>
          <p className="mt-1 text-xs text-muted-foreground" aria-live="polite">
            {pending
              ? state.kind === "saving"
                ? "Saving..."
                : "Refreshing current state..."
              : enabled
                ? "Enabled"
                : "Disabled"}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            role="switch"
            aria-label={label}
            aria-checked={enabled}
            title={kind === "provider-connections" && enabled ? "Disable immediately, including active requests" : label}
            disabled={toggleDisabled}
            className={`inline-flex h-6 w-11 shrink-0 items-center rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 ${enabled ? "bg-primary" : "bg-slate-300"}`}
            onClick={() =>
              void send({ expected_enabled: enabled, enabled: !enabled })
            }
          >
            <span
              className={`pointer-events-none block h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${enabled ? "translate-x-5" : "translate-x-0"}`}
            />
          </button>
          <Button
            size="icon"
            variant="ghost"
            title="Refresh current state"
            aria-label="Refresh current state"
            disabled={disabled || pending || state.kind === "uncertain"}
            onClick={() =>
              void refresh(
                state.kind === "saved" ||
                  (state.kind === "refresh_failed" && state.saved),
              )
            }
          >
            {pending ? (
              <LoaderCircle className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
          </Button>
        </div>
      </div>
      {state.kind === "saved" ? (
        <SuccessNotice
          message="Availability change saved."
          onDismiss={() => setState({ kind: "idle" })}
        />
      ) : null}
      {state.kind === "uncertain" ? (
        <ErrorNotice
          message={`Change is unconfirmed. ${state.message}`}
          action={
            <Button
              variant="secondary"
              disabled={disabled}
              onClick={() => void send(state.intent)}
            >
              Retry change
            </Button>
          }
        />
      ) : null}
      {state.kind === "rejected" ? (
        <CatalogFailure cause={state.cause} />
      ) : null}
      {state.kind === "refresh_failed" ? (
        <ErrorNotice
          message={`${state.saved ? "Saved, but current state could not be refreshed." : "Current state could not be refreshed."} ${state.message}`}
          action={
            <Button
              variant="secondary"
              disabled={disabled}
              onClick={() => void refresh(state.saved)}
            >
              Retry refresh
            </Button>
          }
        />
      ) : null}
    </section>
  );
}

function CatalogFailure({ cause }: { cause: unknown }) {
  const references =
    cause instanceof APIError && cause.code === "resource_in_use"
      ? referenceLinks(cause.details)
      : undefined;
  return (
    <div className="grid min-w-0 gap-3">
      <ErrorNotice message={errorMessage(cause)} />
      {references ? (
        <div className="min-w-0 text-sm">
          <ul className="grid gap-2">
            {references.items.map((item, index) => (
              <li key={`${item.href}:${index}`}>
                <a
                  className="break-all font-medium text-primary underline underline-offset-4"
                  href={item.href}
                >
                  {item.label}
                </a>
              </li>
            ))}
          </ul>
          {references.incomplete ? (
            <p className="mt-2 text-muted-foreground">
              Reference list is incomplete.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
