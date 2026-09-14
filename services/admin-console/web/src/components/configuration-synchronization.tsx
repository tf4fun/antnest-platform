import { useEffect, useState } from "react";
import {
  CheckCircle2,
  CircleHelp,
  Clock3,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";
import { api } from "../lib/api";
import type { ExecutionSynchronization } from "../lib/catalog-availability";
import { dateTime } from "../lib/format";
import { captureResource, type ResourceState } from "../lib/resource-state";
import { Button } from "./ui/button";

export function ConfigurationSynchronization() {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<
    ResourceState<ExecutionSynchronization | null>
  >({ status: "loading" });
  useEffect(() => {
    const changed = () => setAttempt((value) => value + 1);
    window.addEventListener("antnest:configuration-changed", changed);
    return () =>
      window.removeEventListener("antnest:configuration-changed", changed);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    void captureResource(
      async () =>
        (await api.executionSynchronization(controller.signal)).synchronization,
    ).then((result) => {
      if (!controller.signal.aborted) setState(result);
    });
    return () => controller.abort();
  }, [attempt]);

  const view = synchronizationView(state);
  return (
    <section
      className="mb-6 flex min-w-0 items-center gap-3 border-b border-border pb-4"
      aria-label="Execution configuration delivery"
    >
      <view.icon
        className={`h-4 w-4 shrink-0 text-muted-foreground ${state.status === "loading" ? "animate-spin" : ""}`}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1" aria-live="polite">
        <p className="text-sm font-medium">{view.label}</p>
        {view.detail ? (
          <p className="mt-1 break-words text-xs text-muted-foreground">
            {view.detail}
          </p>
        ) : null}
      </div>
      <Button
        size="icon"
        variant="ghost"
        title="Refresh configuration delivery"
        aria-label="Refresh configuration delivery"
        disabled={state.status === "loading"}
        onClick={() => setAttempt((value) => value + 1)}
      >
        <RefreshCw className="h-4 w-4" />
      </Button>
    </section>
  );
}

function synchronizationView(
  state: ResourceState<ExecutionSynchronization | null>,
) {
  if (state.status === "loading")
    return {
      icon: LoaderCircle,
      label: "Checking configuration delivery",
      detail: "",
    };
  if (state.status === "error")
    return {
      icon: CircleHelp,
      label: "Configuration delivery unknown",
      detail: state.failure.message,
    };
  if (state.data === null)
    return {
      icon: CircleHelp,
      label: "No execution configuration published",
      detail: "",
    };
  const { revision, applied_revision: applied, applied_at: at } = state.data;
  if (applied < revision)
    return {
      icon: Clock3,
      label: "Configuration delivery pending",
      detail: `Saved revision ${revision}. Last acknowledged revision: ${applied || "none"}.`,
    };
  return {
    icon: CheckCircle2,
    label: "Configuration acknowledged",
    detail: `Revision ${applied}. Last acknowledgement: ${at ? dateTime(at) : "unknown"}.`,
  };
}
