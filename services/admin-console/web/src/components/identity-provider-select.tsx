import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import { api, errorMessage } from "../lib/api";
import type { ExternalIdentityProvider } from "../lib/types";
import { Button } from "./ui/button";
import { Field, Select } from "./ui/input";

export function IdentityProviderSelect({ name = "provider_id", optional = false, value, onChange, disabled }: {
  name?: string;
  optional?: boolean;
  value?: string;
  onChange?: (event: ChangeEvent<HTMLSelectElement>) => void;
  disabled?: boolean;
}) {
  const [providers, setProviders] = useState<ExternalIdentityProvider[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const scope = useRef<symbol | undefined>(undefined);
  const read = useRef<AbortController | undefined>(undefined);

  const load = useCallback(async (after?: string) => {
    const current = scope.current;
    if (!current || read.current) return;
    const controller = new AbortController(); read.current = controller;
    setPending(true); setError("");
    try {
      const page = await api.externalIdentityProviders(after, controller.signal);
      if (scope.current !== current || controller.signal.aborted) return;
      setProviders(previous => after ? [...previous, ...page.providers.filter(row => !previous.some(old => old.id === row.id))] : page.providers);
      setCursor(page.next_after_id);
    } catch (cause) {
      if (scope.current === current && !controller.signal.aborted) setError(errorMessage(cause));
    } finally {
      if (scope.current === current) { read.current = undefined; setPending(false); }
    }
  }, []);

  useEffect(() => {
    scope.current = Symbol(); void load();
    return () => { scope.current = undefined; read.current?.abort(); read.current = undefined; };
  }, [load]);

  return <div className="grid gap-2">
    <Field label="Login provider" hint={optional ? "Pairing is fixed when issued. Paired SCIM creation uses externalId as the exact provider subject." : "Choose a provider in this organization. Disabled providers may be bound before sign-in is enabled."}>
      <Select name={name} required={!optional} value={value} defaultValue={value === undefined ? "" : undefined} onChange={onChange} disabled={disabled}>
        <option value="">{optional ? "Directory only — no login binding" : "Choose a login provider"}</option>
        {providers.map(provider => <option key={provider.id} value={provider.id}>{provider.display_name} ({provider.name}){provider.enabled ? "" : " · disabled"}{provider.link_policy_review_required ? " · policy review required" : ""}</option>)}
      </Select>
    </Field>
    {pending ? <p className="text-xs text-muted-foreground">Loading login providers…</p> : null}
    {error ? <div role="alert" className="text-sm text-destructive">{error} <Button type="button" size="sm" variant="ghost" disabled={pending || disabled} onClick={() => void load(cursor)}>Retry login provider choices</Button></div> : null}
    {cursor ? <Button type="button" size="sm" variant="secondary" disabled={pending || disabled} onClick={() => void load(cursor)}>Load more login providers</Button> : null}
  </div>;
}
