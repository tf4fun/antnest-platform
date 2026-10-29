import { useEffect, useRef, useState, type FormEvent } from "react";
import { APIError, api, errorMessage } from "../lib/api";
import {
  microsToUSD,
  runBudgetInput,
  usdToMicros,
  type ModelCallPolicy,
  type PeriodCaps,
} from "../lib/model-call-policy";
import { resourceFailure, type ResourceFailure } from "../lib/resource-failure";
import type { ResourceState } from "../lib/resource-state";
import { PageHeader, ResourceFailurePage, Section } from "../components/page";
import { Button } from "../components/ui/button";
import { Field, Input, Select } from "../components/ui/input";
import { RunBudgetEditor } from "../components/model-call-policy";

function periodInput(data: FormData, prefix: string): PeriodCaps {
  const caps: PeriodCaps = {};
  const soft = usdToMicros(String(data.get(`${prefix}_soft_usd`) ?? ""));
  const hard = usdToMicros(String(data.get(`${prefix}_hard_usd`) ?? ""));
  const rawSoft = String(data.get(`${prefix}_soft_usd`) ?? "");
  const rawHard = String(data.get(`${prefix}_hard_usd`) ?? "");
  if (rawSoft.trim() !== "" && soft === undefined) throw new Error(`Enter a valid ${prefix} soft limit in USD or leave it blank.`);
  if (rawHard.trim() !== "" && hard === undefined) throw new Error(`Enter a valid ${prefix} hard limit in USD or leave it blank.`);
  if (soft !== undefined) caps.soft_cost_usd_micros = soft;
  if (hard !== undefined) caps.hard_cost_usd_micros = hard;
  if (soft !== undefined && hard !== undefined && soft > hard) {
    throw new Error(`The ${prefix} soft limit must not exceed its hard limit.`);
  }
  return caps;
}

// Authentication and authorization failures are terminal here even though the
// shared classifier treats bare 401 as transient.
function budgetFailure(cause: unknown): ResourceFailure {
  const failure = resourceFailure(cause);
  return cause instanceof APIError && (cause.status === 401 || cause.status === 403)
    ? { kind: "forbidden", message: failure.message, retryable: false }
    : failure;
}

export function ModelCallPolicyPage({ expectedPrincipal }: { expectedPrincipal: [string, string] }) {
  const [state, setState] = useState<ResourceState<ModelCallPolicy>>({ status: "loading" });
  const [formError, setFormError] = useState("");
  const [success, setSuccess] = useState("");
  const [pending, setPending] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [generation, setGeneration] = useState(0);
  const mounted = useRef(true);
  const sequence = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const request = ++sequence.current;
    setState({ status: "loading" });
    setConflict(false);
    setFormError("");
    setSuccess("");
    // A new read supersedes any in-flight save; without this the stale save's
    // ignored completion would leave the button locked forever.
    setPending(false);
    const controller = new AbortController();
    void (async () => {
      try {
        const policy = await api.modelCallPolicy(controller.signal);
        if (mounted.current && !controller.signal.aborted && sequence.current === request) {
          setState({ status: "ready", data: policy });
        }
      } catch (cause) {
        if (mounted.current && sequence.current === request && !controller.signal.aborted) {
          setState({ status: "error", failure: budgetFailure(cause) });
        }
      }
    })();
    return () => controller.abort();
  }, [generation, expectedPrincipal[0], expectedPrincipal[1]]);

  if (state.status === "loading") {
    return <p className="text-sm text-muted-foreground">Loading organization budget…</p>;
  }
  if (state.status === "error") {
    return (
      <ResourceFailurePage
        eyebrow="Organization"
        resource="Organization budget"
        returnHref="#overview"
        returnLabel="Back to Overview"
        failure={state.failure}
        onRetry={() => setGeneration((current) => current + 1)}
      />
    );
  }
  const policy = state.data;

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || conflict) return;
    const data = new FormData(event.currentTarget);
    let update;
    try {
      update = {
        expected_revision: policy.revision,
        unknown_cost: String(data.get("unknown_cost") ?? "allow") as "allow" | "deny",
        run_caps: runBudgetInput(data),
        daily: periodInput(data, "daily"),
        monthly: periodInput(data, "monthly"),
        expected_principal: expectedPrincipal,
      };
      if (update.unknown_cost !== "allow" && update.unknown_cost !== "deny") {
        throw new Error("Choose whether unknown-cost calls are allowed.");
      }
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : "The budget values are invalid.");
      setSuccess("");
      return;
    }
    const saveSequence = sequence.current;
    setPending(true);
    setFormError("");
    setSuccess("");
    try {
      const saved = await api.setModelCallPolicy(update);
      if (mounted.current && sequence.current === saveSequence) {
        setState({ status: "ready", data: saved });
        setSuccess(`Budget policy saved as revision ${saved.revision}.`);
      }
    } catch (cause) {
      if (!mounted.current || sequence.current !== saveSequence) return;
      if (cause instanceof APIError && cause.status === 409) {
        // A stale CAS keeps the draft visible but blocks saving until the
        // operator explicitly reloads the current policy.
        setConflict(true);
        setFormError(errorMessage(cause));
      } else if (cause instanceof APIError && (cause.status === 401 || cause.status === 403)) {
        setState({ status: "error", failure: budgetFailure(cause) });
      } else {
        // Transient or malformed responses keep the draft and the stored
        // request identity so an explicit resubmit retries exactly.
        setFormError(errorMessage(cause));
      }
    } finally {
      if (mounted.current && sequence.current === saveSequence) setPending(false);
    }
  }

  return (
    <div className="grid gap-6">
      <PageHeader title="Model budgets" detail="Organization limits applied to model calls. UTC daily and monthly caps warn (soft) or deny (hard) billing." />
      <Section title="Organization budget policy">
        <form className="grid gap-5" key={generation} onSubmit={(event) => void save(event)}>
          <Field label="Calls with unknown cost" hint="Deny rejects calls whose cost cannot be proven; other calls are unaffected. Token bounds may also fail closed for unproven providers.">
            <Select name="unknown_cost" defaultValue={policy.unknown_cost} disabled={pending || conflict}>
              <option value="allow">Allow</option>
              <option value="deny">Deny</option>
            </Select>
          </Field>
          <fieldset className="grid gap-4 rounded-md border border-border p-4" disabled={pending || conflict}>
            <legend className="px-1 text-sm font-medium">Per-run caps</legend>
            <RunBudgetEditor initial={policy.run_caps} disabled={pending || conflict} />
          </fieldset>
          <div className="grid gap-4 sm:grid-cols-2">
            <fieldset className="grid gap-4 rounded-md border border-border p-4" disabled={pending || conflict}>
              <legend className="px-1 text-sm font-medium">Daily UTC (USD)</legend>
              <Field label="Soft limit" hint="Warns operators; blank warns on nothing.">
                <Input name="daily_soft_usd" type="text" inputMode="decimal" placeholder="Unlimited"
                  defaultValue={microsToUSD(policy.daily.soft_cost_usd_micros)} />
              </Field>
              <Field label="Hard limit" hint="Denies further calls; blank is unlimited.">
                <Input name="daily_hard_usd" type="text" inputMode="decimal" placeholder="Unlimited"
                  defaultValue={microsToUSD(policy.daily.hard_cost_usd_micros)} />
              </Field>
            </fieldset>
            <fieldset className="grid gap-4 rounded-md border border-border p-4" disabled={pending || conflict}>
              <legend className="px-1 text-sm font-medium">Monthly UTC (USD)</legend>
              <Field label="Soft limit" hint="Warns operators; blank warns on nothing.">
                <Input name="monthly_soft_usd" type="text" inputMode="decimal" placeholder="Unlimited"
                  defaultValue={microsToUSD(policy.monthly.soft_cost_usd_micros)} />
              </Field>
              <Field label="Hard limit" hint="Denies further calls; blank is unlimited.">
                <Input name="monthly_hard_usd" type="text" inputMode="decimal" placeholder="Unlimited"
                  defaultValue={microsToUSD(policy.monthly.hard_cost_usd_micros)} />
              </Field>
            </fieldset>
          </div>
          <p className="text-xs text-muted-foreground">
            Revision {policy.revision}. A token hard bound can reject providers that cannot prove usage.
          </p>
          {formError ? <p role="alert" className="text-sm text-destructive">{formError}</p> : null}
          {success ? <p role="status" className="text-sm text-emerald-600">{success}</p> : null}
          <div className="flex gap-3">
            <Button type="submit" disabled={pending || conflict}>
              {pending ? "Saving…" : "Save budget"}
            </Button>
            {conflict ? (
              <Button type="button" variant="secondary" onClick={() => setGeneration((current) => current + 1)}>
                Reload policy
              </Button>
            ) : null}
          </div>
          {conflict ? (
            <p className="text-xs text-muted-foreground">The policy changed elsewhere. Review your draft, then reload to continue editing.</p>
          ) : null}
        </form>
      </Section>
    </div>
  );
}
