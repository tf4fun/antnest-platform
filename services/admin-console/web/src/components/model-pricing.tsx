import { useState } from "react";
import { formatModelRate, modelRateFields, pricingDraft } from "../lib/model-pricing";
import type { ModelPricing } from "../lib/types";
import { CheckboxField, Field, Input } from "./ui/input";

export function ModelRates({ pricing }: { pricing?: ModelPricing }) {
  if (!pricing) return <p className="text-sm text-muted-foreground">Not configured</p>;
  return (
    <dl className="grid gap-4 sm:grid-cols-2">
      {modelRateFields.map((field) => <div className="min-w-0" key={field.name}>
        <dt className="text-xs text-muted-foreground">{field.label}</dt>
        <dd className="mt-1 break-all text-sm font-medium tabular-nums">{pricing[field.name] === undefined ? "Input rate" : formatModelRate(pricing[field.name])}</dd>
      </div>)}
    </dl>
  );
}

export function ModelPricingEditor({ initial, invalidField, errorID }: {
  initial?: ModelPricing;
  invalidField?: string;
  errorID: string;
}) {
  const [enabled, setEnabled] = useState(initial !== undefined);
  const [draft, setDraft] = useState(() => pricingDraft(initial));
  return (
    <fieldset className="grid min-w-0 gap-3 border-t border-border pt-4">
      <legend className="text-sm font-medium">Token rates <span className="font-normal text-muted-foreground">(USD / 1M tokens)</span></legend>
      <CheckboxField name="pricing_enabled" label="Set rates" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
      {enabled ? <div className="grid gap-4 sm:grid-cols-2">
        {modelRateFields.map((field) => <Field key={field.name} label={`${field.label} (USD / 1M tokens)`} hint={field.required ? undefined : "Optional; defaults to the input rate."}>
          <Input name={field.name} inputMode="decimal" value={draft[field.name]} required={field.required}
            aria-invalid={invalidField === field.name || undefined} aria-describedby={invalidField === field.name ? errorID : undefined}
            placeholder={field.required ? "0" : "Input rate"}
            onChange={(event) => setDraft((value) => ({ ...value, [field.name]: event.target.value }))} />
        </Field>)}
      </div> : <ModelRates />}
      <p className="text-xs text-muted-foreground">Estimated rates; actual charges may vary.</p>
    </fieldset>
  );
}
