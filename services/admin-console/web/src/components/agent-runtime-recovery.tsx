import { useEffect, useRef, useState } from "react";
import { api, APIError, captureSessionRequest, errorMessage, sessionRequestCurrent, type SessionRequest } from "../lib/api";
import { dateTime } from "../lib/format";
import type { Agent, LifecycleOperation, RuntimeRecoveryInput } from "../lib/types";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { ErrorNotice } from "./ui/feedback";

type RecoveryIntent = {
  agentID: string;
  requestID: string;
  templateName: string;
  input: RuntimeRecoveryInput;
  session: SessionRequest;
};
type Phase = "ready" | "uncertain" | "missing" | "blocked";

function matchesCurrent(intent: RecoveryIntent, agent: Agent): boolean {
  const recovery = agent.runtime_recovery;
  const template = agent.configuration?.template;
  return agent.agent_id === intent.agentID && recovery?.rebuild_request_id === intent.requestID &&
    recovery.barrier_id === intent.input.recovery.barrier_id &&
    recovery.runtime_revision === intent.input.recovery.expected_runtime_revision &&
    agent.runtime?.runtime_revision === recovery.runtime_revision &&
    template?.template_id === intent.input.template_id && template.revision === intent.input.template_revision;
}

function recoveryOperation(value: LifecycleOperation, intent: RecoveryIntent): LifecycleOperation {
  if (!value || value.request_id !== intent.requestID || value.agent_id !== intent.agentID || value.kind !== "rebuild" ||
      !["running", "completed", "failed"].includes(value.state) || typeof value.phase !== "string" || !value.phase)
    throw new APIError(502, "invalid_recovery_receipt", "The recovery receipt does not match this Agent and original request. Refresh before continuing.");
  return value;
}

function recoveryRejected(cause: unknown): boolean {
  return cause instanceof APIError && (cause.code === "invalid_recovery_receipt" ||
    (cause.status >= 400 && cause.status < 500 && cause.status !== 408 && cause.status !== 429));
}

export function AgentRuntimeRecovery({ agent, blocked, acquireMutation, onOperation, onRefresh }: {
  agent: Agent;
  blocked: boolean;
  acquireMutation: () => (() => void) | undefined;
  onOperation: (operation: LifecycleOperation) => void;
  onRefresh: () => Promise<unknown>;
}) {
  const [intent, setIntent] = useState<RecoveryIntent>();
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>("ready");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const flight = useRef<AbortController | undefined>(undefined);
  const mounted = useRef(true);
  const latest = useRef({ agent, blocked, acquireMutation, onOperation, onRefresh });
  latest.current = { agent, blocked, acquireMutation, onOperation, onRefresh };
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; flight.current?.abort(); };
  }, []);

  const recovery = agent.runtime_recovery;
  if (!recovery && !intent) return null;

  function openRecovery() {
    if (flight.current) return;
    if (!intent) {
      const recovery = agent.runtime_recovery;
      const template = agent.configuration?.template;
      if (!recovery || !template) return;
      try {
        setIntent({ agentID: agent.agent_id, requestID: recovery.rebuild_request_id, templateName: template.name,
          input: { template_id: template.template_id, template_revision: template.revision,
            recovery: { barrier_id: recovery.barrier_id, expected_runtime_revision: recovery.runtime_revision } },
          session: captureSessionRequest() });
      } catch (cause) { setFailure(errorMessage(cause)); return; }
      setPhase("ready");
      setFailure("");
    }
    setOpen(true);
  }

  async function resolveRecovery(dispatch: boolean) {
    if (!intent || flight.current) return;
    if (!sessionRequestCurrent(intent.session)) {
      setPhase("blocked");
      setFailure("The account changed. Reload the Agent before recovering its Runtime.");
      return;
    }
    const release = latest.current.acquireMutation();
    if (!release) return;
    const controller = new AbortController();
    flight.current = controller;
    setBusy(true);
    setFailure("");
    const current = () => mounted.current && flight.current === controller && !controller.signal.aborted &&
      sessionRequestCurrent(intent.session) && latest.current.agent.agent_id === intent.agentID;
    const accept = async (value: LifecycleOperation) => {
      const operation = recoveryOperation(value, intent);
      if (!current()) return;
      latest.current.onOperation(operation);
      setOpen(false);
      setIntent(undefined);
      setPhase("ready");
      // Admission and the independent Agent refresh have separate outcomes.
      try { await latest.current.onRefresh(); } catch { /* Agent page owns the read failure. */ }
    };
    try {
      let found: LifecycleOperation | undefined;
      try { found = recoveryOperation(await api.operation(intent.requestID, controller.signal), intent); }
      catch (cause) {
        if (!current()) return;
        if (!(cause instanceof APIError && cause.status === 404 && cause.code === "operation_not_found")) throw cause;
      }
      if (!current()) return;
      if (found) { await accept(found); return; }
      if (!dispatch) {
        if (phase !== "blocked") setPhase("missing");
        setFailure("The original recovery request has no operation receipt. An explicit retry keeps the same request and configuration.");
        return;
      }
      const { agent: currentAgent, blocked: currentBlocked } = latest.current;
      const until = currentAgent.runtime_recovery?.cooldown_until;
      if (phase === "blocked" || currentBlocked || !matchesCurrent(intent, currentAgent) ||
          currentAgent.lifecycle_state !== "created" || currentAgent.desired_state !== "enabled" ||
          currentAgent.activation_state !== "enabled" || currentAgent.active_operation_request_id ||
          currentAgent.failure_code === "lifecycle_invariant_failed" ||
          (until != null && (!Number.isFinite(Date.parse(until)) || Date.parse(until) > Date.now()))) {
        setPhase("blocked");
        setFailure("Recovery is not available for this Agent state. Refresh the Agent; the original request can still be checked.");
        return;
      }
      try { await accept(await api.recoverAgent(intent.agentID, intent.requestID, intent.input, controller.signal)); }
      catch (cause) {
        if (!current()) return;
        setPhase(recoveryRejected(cause) ? "blocked" : "uncertain");
        setFailure(errorMessage(cause));
      }
    } catch (cause) {
      if (current()) { setPhase(recoveryRejected(cause) ? "blocked" : "uncertain"); setFailure(errorMessage(cause)); }
    } finally {
      if (flight.current === controller) flight.current = undefined;
      if (mounted.current) setBusy(false);
      release();
    }
  }

  return <section className="rounded-md border border-amber-200 bg-amber-50/60 p-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold">Runtime recovery required</h2>
        <p className="mt-1 text-sm">An interrupted tool call left this Agent unable to accept new work. Recovery replaces its Runtime using the configured template.</p>
        <p className="mt-1 text-sm">Previous messages and tool calls remain in history.</p>
        {recovery ? <p className="mt-2 text-xs">Recovery mode: {recovery.mode}.</p> : null}
        {recovery?.cooldown_until ? <p className="mt-1 text-xs">New recovery requests are available after {dateTime(recovery.cooldown_until)}. Existing requests can still be checked.</p> : null}
      </div>
      <Button variant="secondary" disabled={busy || (!intent && !agent.configuration?.template)} onClick={openRecovery}>Recover Runtime</Button>
    </div>
    {!open && failure ? <ErrorNotice message={failure} /> : null}
    <Dialog open={open} onOpenChange={setOpen} dismissible={!busy} title="Recover Runtime"
      description="Confirm recovery using this Agent's current configured template. The original recovery request is checked first.">
      {intent ? <div className="grid gap-4">
        <p className="text-sm">{intent.templateName} · revision {intent.input.template_revision}</p>
        {failure ? <ErrorNotice message={failure} /> : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button>
          {phase !== "ready" ? <Button variant="secondary" disabled={busy} onClick={() => void resolveRecovery(false)}>Check recovery request</Button> : null}
          {phase === "ready" || phase === "missing" ? <Button aria-busy={busy} disabled={busy} onClick={() => void resolveRecovery(true)}>
            {phase === "missing" ? "Retry same recovery" : "Confirm recovery"}
          </Button> : null}
        </div>
      </div> : null}
    </Dialog>
  </section>;
}
