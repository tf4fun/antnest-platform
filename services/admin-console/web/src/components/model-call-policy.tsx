import { useState } from "react";
import {
  DEFAULT_MODEL_RETRY,
  microsToUSD,
  type PeriodCaps,
  type RunBudget,
  type TemplateModelPolicy,
} from "../lib/model-call-policy";
import { Field, Input, Select } from "./ui/input";

export function RunBudgetEditor({ initial, prefix = "run_", disabled = false }: {
  initial?: RunBudget;
  prefix?: string;
  disabled?: boolean;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <Field label="Input token limit" hint="Per-run aggregate. Blank sets no bound; providers may still limit.">
        <Input name={`${prefix}max_input_tokens`} type="text" inputMode="numeric" placeholder="Unlimited"
          defaultValue={initial?.max_input_tokens !== undefined ? String(initial.max_input_tokens) : ""}
          disabled={disabled} />
      </Field>
      <Field label="Output token limit" hint="Per-run aggregate. Blank sets no bound; providers may still limit.">
        <Input name={`${prefix}max_output_tokens`} type="text" inputMode="numeric" placeholder="Unlimited"
          defaultValue={initial?.max_output_tokens !== undefined ? String(initial.max_output_tokens) : ""}
          disabled={disabled} />
      </Field>
      <Field label="Cost limit per run (USD)" hint="Exact decimal; blank sets no bound, 0 forbids positive-priced consumption.">
        <Input name={`${prefix}max_cost_usd`} type="text" inputMode="decimal" placeholder="Unlimited"
          defaultValue={microsToUSD(initial?.max_cost_usd_micros)}
          disabled={disabled} />
      </Field>
    </div>
  );
}

export function TemplateModelPolicyEditor({ initial, disabled = false }: {
  initial?: TemplateModelPolicy;
  disabled?: boolean;
}) {
  const [customRetry, setCustomRetry] = useState(initial?.model_retry !== undefined);
  const retry = initial?.model_retry ?? DEFAULT_MODEL_RETRY;
  return (
    <fieldset className="grid gap-4 rounded-md border border-border p-4" disabled={disabled}>
      <legend className="px-1 text-sm font-medium">Model call policy</legend>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Retry policy" hint={`Platform default allows ${DEFAULT_MODEL_RETRY.max} retries (${DEFAULT_MODEL_RETRY.base_ms}–${DEFAULT_MODEL_RETRY.cap_ms} ms).`}>
          <Select name="retry_mode" value={customRetry ? "custom" : "default"}
            onChange={(event) => setCustomRetry(event.target.value === "custom")}>
            <option value="default">Platform default</option>
            <option value="custom">Custom</option>
          </Select>
        </Field>
        <Field label="Failover" hint="Choose when a different Provider may take over.">
          <Select name="failover" defaultValue={initial?.failover ?? "default"}>
            <option value="default">Platform default</option>
            <option value="never">Never</option>
            <option value="before_output">Before output</option>
          </Select>
        </Field>
      </div>
      {customRetry ? (
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Retries" hint="0–8 retries after the first attempt.">
            <Input name="retry_max" type="number" min="0" max="8" defaultValue={retry.max} required />
          </Field>
          <Field label="Base delay (ms)" hint="1–30000.">
            <Input name="retry_base_ms" type="number" min="1" max="30000" defaultValue={retry.base_ms} required />
          </Field>
          <Field label="Delay cap (ms)" hint="At least the base, at most 30000.">
            <Input name="retry_cap_ms" type="number" min="1" max="30000" defaultValue={retry.cap_ms} required />
          </Field>
        </div>
      ) : null}
      <RunBudgetEditor initial={initial?.run_budget} disabled={disabled} />
    </fieldset>
  );
}

function capValue(name: string, value: number): string {
  return name.endsWith("_usd_micros") ? `$${microsToUSD(value)}` : String(value);
}

function CapsText({ caps }: { caps: PeriodCaps | RunBudget }) {
  const entries = Object.entries(caps);
  if (!entries.length) return <span className="text-muted-foreground">Platform default</span>;
  return <>{entries.map(([name, value]) => `${name}: ${capValue(name, value)}`).join(" · ")}</>;
}

export function ModelCallPolicyDetails({ policy }: { policy: TemplateModelPolicy }) {
  const retry = policy.model_retry;
  return (
    <dl className="grid gap-3 text-sm sm:grid-cols-2">
      <div>
        <dt className="text-muted-foreground">Retry policy</dt>
        <dd>{retry ? `${retry.max} retries, ${retry.base_ms}–${retry.cap_ms} ms` : "Platform default"}</dd>
      </div>
      <div>
        <dt className="text-muted-foreground">Failover</dt>
        <dd>{policy.failover ?? "Platform default"}</dd>
      </div>
      <div className="sm:col-span-2">
        <dt className="text-muted-foreground">Run budget</dt>
        <dd><CapsText caps={policy.run_budget ?? {}} /></dd>
      </div>
    </dl>
  );
}


