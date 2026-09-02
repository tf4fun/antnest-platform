import { BrainCircuit, LoaderCircle, Plus } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { DataTable, PageHeader } from "../components/page";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Dialog } from "../components/ui/dialog";
import { Empty, ErrorNotice, Loading } from "../components/ui/feedback";
import { Field, Input } from "../components/ui/input";
import { api, errorMessage } from "../lib/api";
import { positiveInteger, slugify } from "../lib/forms";
import { dateTime } from "../lib/format";
import type { ModelProfile } from "../lib/types";

export function ModelsPage() {
  const [items, setItems] = useState<ModelProfile[]>();
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const load = useCallback(async () => {
    try {
      setItems((await api.models()).items);
      setError("");
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, []);
  useEffect(() => void load(), [load]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const displayName = String(data.get("display_name") ?? "").trim();
    setPending(true);
    setError("");
    try {
      await api.createModel({
        profile_key: `${slugify(displayName, "model")}-${Date.now().toString(36)}`,
        display_name: displayName,
        api_key: String(data.get("api_key") ?? ""),
        model: {
          base_url: String(data.get("base_url") ?? "").trim(),
          model: String(data.get("model") ?? "").trim(),
          context_window: positiveInteger(data.get("context_window"), 128000),
          max_output_tokens: positiveInteger(data.get("max_output_tokens"), 8192),
          supports_images: data.get("supports_images") === "on",
        },
      });
      form.reset();
      setOpen(false);
      await load();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  if (!items && !error) return <Loading label="Loading model profiles" />;
  return (
    <div className="grid gap-6">
      <PageHeader
        title="Model providers"
        detail="Provider connections and immutable model revisions available to templates."
        actions={<Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" />Add model</Button>}
      />
      {error ? <ErrorNotice message={error} /> : null}
      {items?.length === 0 ? (
        <Empty title="No model profiles" detail="Add a model connection before creating an Agent template." />
      ) : (
        <DataTable>
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="bg-muted/60 text-xs text-muted-foreground"><tr><th className="px-3 py-2 font-medium">Connection</th><th className="px-3 py-2 font-medium">Model</th><th className="px-3 py-2 font-medium">Context</th><th className="px-3 py-2 font-medium">Output</th><th className="px-3 py-2 font-medium">Revision</th><th className="px-3 py-2 font-medium">Status</th><th className="px-3 py-2 font-medium">Updated</th></tr></thead>
            <tbody className="divide-y divide-border">
              {items?.map((profile) => (
                <tr key={profile.revision_id}>
                  <td className="px-3 py-3"><div className="flex items-center gap-2"><BrainCircuit className="h-4 w-4 text-muted-foreground" /><div><p className="font-medium">{profile.display_name}</p><p className="max-w-52 truncate text-xs text-muted-foreground">{profile.model.base_url}</p></div></div></td>
                  <td className="px-3 py-3 font-mono text-xs">{profile.model.model}</td>
                  <td className="px-3 py-3">{profile.model.context_window.toLocaleString()}</td>
                  <td className="px-3 py-3">{profile.model.max_output_tokens.toLocaleString()}</td>
                  <td className="px-3 py-3">{profile.revision}</td>
                  <td className="px-3 py-3"><Badge value={profile.enabled ? "enabled" : "disabled"} /></td>
                  <td className="px-3 py-3 text-muted-foreground">{dateTime(profile.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </DataTable>
      )}
      <Dialog open={open} onOpenChange={setOpen} title="Add model" description="Create a provider connection for Agent templates.">
        <form className="grid gap-4" onSubmit={submit}>
          <Field label="Connection name"><Input name="display_name" placeholder="DeepSeek" required /></Field>
          <Field label="API endpoint"><Input name="base_url" type="url" placeholder="https://api.deepseek.com/v1" required /></Field>
          <Field label="Model"><Input name="model" placeholder="deepseek-chat" required /></Field>
          <Field label="API key"><Input name="api_key" type="password" autoComplete="off" required /></Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Context window"><Input name="context_window" type="number" min="1024" defaultValue="128000" required /></Field>
            <Field label="Max output tokens"><Input name="max_output_tokens" type="number" min="1" defaultValue="8192" required /></Field>
          </div>
          <label className="flex items-center gap-2 text-sm"><input className="h-4 w-4 accent-primary" name="supports_images" type="checkbox" />Supports image input</label>
          <div className="mt-2 flex justify-end gap-2"><Button type="button" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button disabled={pending} type="submit">{pending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}Create model</Button></div>
        </form>
      </Dialog>
    </div>
  );
}
