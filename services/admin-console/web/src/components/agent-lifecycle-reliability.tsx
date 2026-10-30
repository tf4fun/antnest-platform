import { useEffect, useRef, useState } from "react";
import {
  api,
  APIError,
  captureSessionRequest,
  errorMessage,
  onSessionRequestCancelled,
  sessionRequestCurrent,
  type SessionRequest,
} from "../lib/api";
import type { Agent, LifecycleOperation } from "../lib/types";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { ErrorNotice } from "./ui/feedback";

type CancelIntent = {
  agentID: string;
  operationRequestID: string;
  operationKind: string;
  session: SessionRequest;
};

type ClearIntent = {
  agentID: string;
  expectedAggregateSequence: number;
  session: SessionRequest;
};

type Flight = {
  controller: AbortController;
  release: () => void;
};

function cancellationReceipt(
  value: LifecycleOperation,
  intent: CancelIntent,
): LifecycleOperation {
  if (
    !value ||
    value.agent_id !== intent.agentID ||
    value.request_id !== intent.operationRequestID ||
    value.kind !== intent.operationKind ||
    !["running", "completed", "failed"].includes(value.state) ||
    typeof value.phase !== "string" ||
    !value.phase
  ) {
    throw new APIError(
      502,
      "invalid_cancel_receipt",
      "The cancellation receipt does not match this Agent and original request. Refresh before continuing.",
    );
  }
  return value;
}

function clearReceipt(value: Agent, intent: ClearIntent): Agent {
  if (
    !value ||
    value.agent_id !== intent.agentID ||
    !Number.isSafeInteger(value.aggregate_sequence) ||
    value.aggregate_sequence <= intent.expectedAggregateSequence ||
    Boolean(value.failure_code) ||
    Boolean(value.failure_stage) ||
    value.runtime_state !== "unknown" ||
    value.active_operation_request_id ||
    value.executable_execution_revision ||
    value.readiness === "ready"
  ) {
    throw new APIError(
      502,
      "invalid_clear_receipt",
      "The cleared Agent does not match the expected cleared state. Refresh before continuing.",
    );
  }
  return value;
}

function clearEligible(agent: Agent): boolean {
  return (
    agent.failure_code === "lifecycle_invariant_failed" &&
    agent.lifecycle_state === "created" &&
    !agent.active_operation_request_id &&
    Number.isSafeInteger(agent.aggregate_sequence) &&
    agent.aggregate_sequence > 0 &&
    Boolean(agent.agent_spec_revision && agent.runtime?.runtime_revision)
  );
}

function cancelEligible(agent: Agent, operation?: LifecycleOperation): boolean {
  return Boolean(
    operation &&
    operation.state === "running" &&
    operation.agent_id === agent.agent_id &&
    agent.lifecycle_state !== "deleted" &&
    (!agent.active_operation_request_id ||
      agent.active_operation_request_id === operation.request_id),
  );
}

function cancelAcknowledgement(operation: LifecycleOperation): string {
  if (operation.state === "completed") {
    return "Operation already completed; no cancellation cleanup was requested.";
  }
  if (operation.state === "failed") {
    return operation.error_code === "lifecycle_cancelled"
      ? `Cancellation recorded for ${operation.request_id}.`
      : "The operation already ended before the cancellation request.";
  }
  return "Cancellation requested; cleanup may continue asynchronously.";
}

export function AgentLifecycleReliability({
  agent,
  operation,
  blocked,
  acquireMutation,
  onOperation,
  onAgent,
  onRefresh,
}: {
  agent: Agent;
  operation?: LifecycleOperation;
  blocked: boolean;
  acquireMutation: () => (() => void) | undefined;
  onOperation: (operation: LifecycleOperation) => void;
  onAgent: (agent: Agent) => unknown;
  onRefresh: () => Promise<Agent | undefined>;
}) {
  const [intent, setIntent] = useState<
    CancelIntent | ClearIntent | undefined
  >();
  const [dialog, setDialog] = useState<"cancel" | "clear" | "">("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [acknowledgement, setAcknowledgement] = useState("");
  const flight = useRef<Flight | undefined>(undefined);
  const mounted = useRef(true);
  const previousAgentID = useRef(agent.agent_id);
  const latest = useRef({
    agent,
    operation,
    blocked,
    acquireMutation,
    onOperation,
    onAgent,
    onRefresh,
  });
  latest.current = {
    agent,
    operation,
    blocked,
    acquireMutation,
    onOperation,
    onAgent,
    onRefresh,
  };

  function abortActive() {
    const active = flight.current;
    flight.current = undefined;
    if (!active) return;
    active.controller.abort();
    active.release();
  }

  function discardContext() {
    setDialog("");
    setIntent(undefined);
    setFailure("");
    setNeedsRefresh(false);
    setAcknowledgement("");
    setBusy(false);
  }

  useEffect(() => {
    mounted.current = true;
    return () => {
      abortActive();
      mounted.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // An Agent switch discards the whole old confirmation context and any flight.
  useEffect(() => {
    if (previousAgentID.current === agent.agent_id) return;
    previousAgentID.current = agent.agent_id;
    abortActive();
    discardContext();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.agent_id]);

  // A session cancellation discards old confirmation state; the parent owns the
  // authoritative reread for the new account.
  useEffect(() => {
    if (!intent) return;
    return onSessionRequestCancelled(intent.session, () => {
      abortActive();
      discardContext();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intent?.session]);

  const canCancel = cancelEligible(agent, operation);
  const canClear =
    clearEligible(agent) && !(operation && operation.state === "running");
  if (
    !canCancel &&
    !canClear &&
    !intent &&
    !acknowledgement &&
    !failure &&
    !needsRefresh
  )
    return null;

  function beginCancel() {
    if (flight.current || needsRefresh) return;
    const { agent: a, operation: o } = latest.current;
    if (!cancelEligible(a, o)) return;
    setIntent({
      agentID: a.agent_id,
      operationRequestID: o!.request_id,
      operationKind: o!.kind,
      session: captureSessionRequest(),
    });
    setFailure("");
    setDialog("cancel");
  }

  function beginClear() {
    if (flight.current || needsRefresh) return;
    const a = latest.current.agent;
    if (!clearEligible(a)) return;
    setIntent({
      agentID: a.agent_id,
      expectedAggregateSequence: a.aggregate_sequence,
      session: captureSessionRequest(),
    });
    setFailure("");
    setDialog("clear");
  }

  function cancelIntentStillValid(i: CancelIntent): string {
    const { agent: a, operation: o, blocked: b } = latest.current;
    if (!sessionRequestCurrent(i.session))
      return "The account changed. Reload the Agent before cancelling.";
    if (a.agent_id !== i.agentID || a.lifecycle_state === "deleted" || b) {
      return "The operation context changed. Confirm the current state before cancelling.";
    }
    if (
      !cancelEligible(a, o) ||
      o!.request_id !== i.operationRequestID ||
      o!.kind !== i.operationKind
    ) {
      return "The running operation changed. Confirm the current operation before cancelling.";
    }
    return "";
  }

  function clearIntentStillValid(i: ClearIntent): string {
    const { agent: a, operation: o, blocked: b } = latest.current;
    if (!sessionRequestCurrent(i.session))
      return "The account changed. Reload the Agent before clearing.";
    if (
      a.agent_id !== i.agentID ||
      a.aggregate_sequence !== i.expectedAggregateSequence ||
      b ||
      !clearEligible(a) ||
      (o && o.state === "running")
    ) {
      return "The Agent changed since this confirmation opened. Refresh and confirm again.";
    }
    return "";
  }

  function openFlight(releaseParent: (() => void) | undefined): Flight {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      releaseParent?.();
    };
    const local = { controller: new AbortController(), release };
    flight.current = local;
    return local;
  }

  function settleFlight(local: Flight) {
    local.release();
    if (flight.current === local) {
      flight.current = undefined;
      if (mounted.current) setBusy(false);
    }
  }

  async function refreshAuthoritative(): Promise<void> {
    const i = intent;
    if (!i || flight.current) return;
    const local = openFlight(undefined);
    setBusy(true);
    setFailure("");
    const current = () =>
      mounted.current &&
      flight.current === local &&
      !local.controller.signal.aborted &&
      sessionRequestCurrent(i.session) &&
      latest.current.agent.agent_id === i.agentID;
    try {
      const read = await latest.current.onRefresh();
      if (!current()) return;
      if (read && read.agent_id === i.agentID) {
        // A successful same-Agent read ends the old intent and requires a fresh confirmation.
        setNeedsRefresh(false);
        setDialog("");
        setIntent(undefined);
      } else {
        setFailure(
          "The Agent could not be refreshed. The previous confirmation remains unresolved.",
        );
      }
    } catch (cause) {
      if (!current()) return;
      setFailure(errorMessage(cause));
    } finally {
      settleFlight(local);
    }
  }

  async function confirmCancel() {
    const i = intent as CancelIntent | undefined;
    if (needsRefresh || !i || !("operationRequestID" in i) || flight.current)
      return;
    let stale = cancelIntentStillValid(i);
    if (stale) {
      setFailure(stale);
      setDialog("");
      setIntent(undefined);
      return;
    }
    const release = latest.current.acquireMutation();
    if (!release) return;
    const local = openFlight(release);
    setBusy(true);
    setFailure("");
    const current = () =>
      mounted.current &&
      flight.current === local &&
      !local.controller.signal.aborted &&
      sessionRequestCurrent(i.session) &&
      latest.current.agent.agent_id === i.agentID;
    try {
      stale = cancelIntentStillValid(i);
      if (stale) throw new APIError(400, "stale_confirmation", stale);
      const receipt = cancellationReceipt(
        await api.cancelLifecycleOperation(
          i.agentID,
          i.operationRequestID,
          local.controller.signal,
        ),
        i,
      );
      if (!current()) return;
      setDialog("");
      setIntent(undefined);
      // A different active operation (e.g. the child delete) means the old receipt
      // must not be applied; the independent refresh reconciles instead.
      const activeNow = latest.current.agent.active_operation_request_id;
      if (!activeNow || activeNow === i.operationRequestID) {
        latest.current.onOperation(receipt);
      }
      setAcknowledgement(cancelAcknowledgement(receipt));
      try {
        await latest.current.onRefresh();
      } catch {
        /* the page owns the read failure */
      }
    } catch (cause) {
      if (!current()) return;
      setFailure(errorMessage(cause));
      setNeedsRefresh(true);
    } finally {
      settleFlight(local);
    }
  }

  async function confirmClear() {
    const i = intent as ClearIntent | undefined;
    if (
      needsRefresh ||
      !i ||
      !("expectedAggregateSequence" in i) ||
      flight.current
    )
      return;
    let stale = clearIntentStillValid(i);
    if (stale) {
      setFailure(stale);
      setDialog("");
      setIntent(undefined);
      return;
    }
    const release = latest.current.acquireMutation();
    if (!release) return;
    const local = openFlight(release);
    setBusy(true);
    setFailure("");
    const current = () =>
      mounted.current &&
      flight.current === local &&
      !local.controller.signal.aborted &&
      sessionRequestCurrent(i.session) &&
      latest.current.agent.agent_id === i.agentID;
    try {
      stale = clearIntentStillValid(i);
      if (stale) throw new APIError(400, "stale_confirmation", stale);
      const receipt = clearReceipt(
        await api.clearLifecycleQuarantine(
          i.agentID,
          i.expectedAggregateSequence,
          local.controller.signal,
        ),
        i,
      );
      if (!current()) return;
      latest.current.onAgent(receipt);
      setDialog("");
      setIntent(undefined);
      setAcknowledgement(
        "Quarantine cleared; the Agent remains not-ready until a normal rebuild or enable succeeds.",
      );
      try {
        await latest.current.onRefresh();
      } catch {
        /* the page owns the read failure */
      }
    } catch (cause) {
      if (!current()) return;
      setFailure(errorMessage(cause));
      setNeedsRefresh(true);
    } finally {
      settleFlight(local);
    }
  }

  function closeDialog() {
    // Dismissal never reuses the intent. A needs-refresh intent stays captured so
    // the explicit refresh can still resolve it; a clean dismiss discards it.
    setDialog("");
    if (!needsRefresh) setIntent(undefined);
  }

  const confirmDisabled = busy || needsRefresh || blocked;
  return (
    <div
      className="flex flex-col gap-3 rounded-md border border-border bg-white p-4 shadow-xs"
      data-testid="lifecycle-reliability"
    >
      {failure && dialog === "" ? <ErrorNotice message={failure} /> : null}
      {acknowledgement ? (
        <p role="status" className="text-sm text-muted-foreground break-all">
          {acknowledgement}
        </p>
      ) : null}
      {canCancel && operation ? (
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 min-w-0">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">
              Cancel the running lifecycle operation
            </p>
            <p className="text-sm text-muted-foreground break-all">
              Request cancellation of{" "}
              <span className="font-mono break-all">
                {operation.request_id}
              </span>
              . Create cleanup uses the normal delete lifecycle and may continue
              asynchronously; non-create cancellation has no guaranteed resource
              inverse.
            </p>
          </div>
          <Button
            variant="secondary"
            disabled={blocked || busy || needsRefresh}
            onClick={beginCancel}
          >
            Cancel operation
          </Button>
        </div>
      ) : null}
      {canClear ? (
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 min-w-0">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">
              Clear the lifecycle quarantine
            </p>
            <p className="text-sm text-muted-foreground break-all">
              The Controller accepts a clear only with matching non-running
              Runtime proof. Fix the reported root cause first; the current
              sequence{" "}
              <span className="font-mono">{agent.aggregate_sequence}</span> is
              captured at confirmation and a conflict requires a fresh read.
            </p>
          </div>
          <Button
            variant="secondary"
            disabled={blocked || busy || needsRefresh}
            onClick={beginClear}
          >
            Clear quarantine
          </Button>
        </div>
      ) : null}
      {needsRefresh ? (
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => void refreshAuthoritative()}
        >
          Refresh Agent
        </Button>
      ) : null}
      <Dialog
        open={dialog === "cancel"}
        onOpenChange={(open) => !busy && !open && closeDialog()}
        title="Cancel lifecycle operation"
        description="This requests cancellation only; it does not prove any resource is gone."
      >
        {failure && dialog === "cancel" ? (
          <ErrorNotice message={failure} />
        ) : null}
        <p className="text-sm text-muted-foreground">
          Cancel the running{" "}
          {intent && "operationRequestID" in intent ? intent.operationKind : ""}{" "}
          operation{" "}
          <span className="font-mono break-all">
            {intent && "operationRequestID" in intent
              ? intent.operationRequestID
              : ""}
          </span>
          ? A completed operation racing the cancel still wins and is not
          cleaned up; a committed cancelled create starts one deterministic
          delete which must complete its own proof.
        </p>
        <div className="flex justify-end gap-2">
          {needsRefresh ? (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => void refreshAuthoritative()}
            >
              Refresh Agent
            </Button>
          ) : null}
          <Button variant="ghost" disabled={busy} onClick={closeDialog}>
            Back
          </Button>
          <Button
            disabled={confirmDisabled}
            onClick={() => void confirmCancel()}
            aria-busy={busy}
          >
            Confirm cancel
          </Button>
        </div>
      </Dialog>
      <Dialog
        open={dialog === "clear"}
        onOpenChange={(open) => !busy && !open && closeDialog()}
        title="Clear lifecycle quarantine"
        description="Clearing requires matching non-running Runtime proof and leaves the Agent not-ready."
      >
        {failure && dialog === "clear" ? (
          <ErrorNotice message={failure} />
        ) : null}
        <p className="text-sm text-muted-foreground">
          Clear the quarantine on Agent{" "}
          <span className="font-mono break-all">{intent?.agentID}</span> at
          sequence{" "}
          <span className="font-mono">
            {intent && "expectedAggregateSequence" in intent
              ? intent.expectedAggregateSequence
              : ""}
          </span>
          ? Clearing only succeeds when the retained sequence still matches, the
          Agent has no running operation, and the Controller proves the Runtime
          is absent or exited.
        </p>
        <div className="flex justify-end gap-2">
          {needsRefresh ? (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => void refreshAuthoritative()}
            >
              Refresh Agent
            </Button>
          ) : null}
          <Button variant="ghost" disabled={busy} onClick={closeDialog}>
            Back
          </Button>
          <Button
            disabled={confirmDisabled}
            onClick={() => void confirmClear()}
            aria-busy={busy}
          >
            Confirm clear
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
