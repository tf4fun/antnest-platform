import { FileText, Search } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { SearchField } from "../components/page";
import { Button } from "../components/ui/button";
import { Dialog } from "../components/ui/dialog";
import { Empty, ErrorNotice, Loading } from "../components/ui/feedback";
import { Field, Select } from "../components/ui/input";
import { api, APIError, errorMessage } from "../lib/api";
import { bytes } from "../lib/format";
import type { SkillSource, SkillSourcePreview, SkillSummary, SkillVersion } from "../lib/skills";

type SourceProps = {
  targets: SkillSummary[];
  hasMoreTargets: boolean;
  moreTargetsPending: boolean;
  moreTargetsError?: string;
  onMoreTargets: () => void;
  onRefreshTargets: () => void | Promise<void>;
  onPublished: (version: SkillVersion) => void | Promise<void>;
};

export function SkillSources(props: SourceProps) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<SkillSource[]>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<SkillSource>();
  const search = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => search.current?.abort(), []);
  async function find(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const value = query.trim();
    if (!value || new TextEncoder().encode(value).length > 256) { setError("Enter a search of at most 256 bytes."); return; }
    search.current?.abort();
    const controller = new AbortController(); search.current = controller;
    setPending(true); setError(""); setItems(undefined);
    try { const page = await api.searchSkillSources(value, controller.signal); if (!controller.signal.aborted) setItems(page.items); }
    catch (cause) { if (!controller.signal.aborted) setError(errorMessage(cause)); }
    finally { if (!controller.signal.aborted) setPending(false); }
  }
  return <section className="grid gap-4" aria-label="Agent Skill sources">
    <div><h2 className="font-semibold">Learned Skills from your Agents</h2><p className="mt-1 text-sm leading-5 text-muted-foreground">Search current personal Skills owned by your account. Sources stay with their Agent until you explicitly promote a package.</p></div>
    <form className="flex flex-wrap items-center gap-3" onSubmit={(event) => void find(event)}>
      <SearchField aria-label="Search Agent Skills" placeholder="Search by name or description" value={query} onChange={(event) => setQuery(event.target.value)} />
      <Button type="submit" disabled={pending || !query.trim()}><Search className="h-4 w-4" />{pending ? "Searching…" : "Find Skills"}</Button>
    </form>
    {error ? <ErrorNotice message={error} /> : null}
    {pending ? <Loading label="Searching Agent Skills" /> : null}
    {items?.length === 0 ? <Empty title="No matching Agent Skills" detail="Try another keyword. A source must still be readable and available to your account." /> : null}
    {items ? <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{items.map((item) => <article key={`${item.skill_ref.agent_id}:${item.name}`} className="grid gap-3 rounded-lg border border-border bg-white p-5 shadow-xs">
      <div className="flex items-start justify-between gap-3"><h3 className="font-semibold">{item.name}</h3><span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs">Agent source</span></div>
      <p className="text-sm text-muted-foreground">{item.description}</p>
      <p className="break-all font-mono text-xs text-muted-foreground">{item.skill_ref.agent_id}</p>
      <p className="text-xs text-muted-foreground">Source revision {item.skill_ref.sequence}</p>
      <Button variant="secondary" className="w-fit self-end" aria-label={`Review and promote ${item.name}`} onClick={() => setSelected(item)}><FileText className="h-4 w-4" />Review and promote</Button>
    </article>)}</div> : null}
    {items ? <p className="text-xs text-muted-foreground">{items.length} matching Agent sources. Results are limited to 50 matches; refine your search to find other sources.</p> : null}
    {selected ? <PromotionDialog key={`${selected.skill_ref.agent_id}:${selected.name}:${selected.skill_ref.sequence}:${selected.content_digest}`} source={selected} {...props} onClose={() => setSelected(undefined)} onRechoose={() => { setSelected(undefined); void find(); void props.onRefreshTargets(); }} onPublished={async (version) => { setSelected(undefined); try { await props.onPublished(version); } catch { setError(`${version.name} v${version.version} was published, but the inventory could not be refreshed. Refresh the page to inspect it.`); } }} /> : null}
  </section>;
}

function PromotionDialog({ source, targets, hasMoreTargets, moreTargetsPending, moreTargetsError, onMoreTargets, onPublished, onClose, onRechoose }: SourceProps & { source: SkillSource; onClose: () => void; onRechoose: () => void }) {
  const [preview, setPreview] = useState<SkillSourcePreview>();
  const [previewPending, setPreviewPending] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [blocked, setBlocked] = useState(false);
  const [target, setTarget] = useState<{ skill_id: string; expected_version: number }>();
  useEffect(() => {
    const controller = new AbortController();
    void api.previewSkillSource({ skill_ref: source.skill_ref, expected_digest: source.content_digest }, controller.signal)
      .then((value) => { if (!controller.signal.aborted) setPreview(value); })
      .catch((cause) => { if (!controller.signal.aborted) { setError(errorMessage(cause)); setBlocked(true); } })
      .finally(() => { if (!controller.signal.aborted) setPreviewPending(false); });
    return () => controller.abort();
  }, [source]);
  async function promote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!preview || pending || blocked) return;
    setPending(true); setError("");
    try {
      const version = await api.promoteSkillSource({ skill_ref: source.skill_ref, expected_digest: source.content_digest, ...target });
      await onPublished(version);
    } catch (cause) {
      setError(errorMessage(cause));
      if (cause instanceof APIError && ["content_changed", "revision_conflict", "name_conflict", "not_found", "request_conflict"].includes(cause.code)) setBlocked(true);
    } finally { setPending(false); }
  }
  const matching = targets.filter((item) => item.name === source.name);
  return <Dialog open onOpenChange={(value) => { if (!value) onClose(); }} title={`Promote ${source.name}`} description="Review this current source package before publishing an immutable organization Skill." dismissible={!pending}>
    <form className="grid gap-4" onSubmit={(event) => void promote(event)}>
      <div className="grid gap-1.5 rounded-lg border border-border bg-muted/30 p-4 text-xs text-muted-foreground">
        <p className="break-all font-mono">{source.skill_ref.agent_id}</p>
        <p>Source revision {source.skill_ref.sequence}</p>
        <p className="break-all font-mono">{source.content_digest}</p>
      </div>
      {previewPending ? <Loading label="Loading source package" /> : null}
      {preview ? <>
        <div><h3 className="mb-2 text-sm font-medium">SKILL.md</h3><pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-border bg-muted/30 p-3 font-mono text-xs leading-5">{preview.skill_md}</pre></div>
        <div><h3 className="mb-2 text-sm font-medium">Package files</h3><ul className="grid gap-1.5 text-xs text-muted-foreground">{preview.files.map((file) => <li key={file.path} className="flex flex-wrap justify-between gap-2"><span className="break-all font-mono">{file.path}</span><span>{bytes(file.size)}{file.executable ? " · Executable" : ""}</span></li>)}</ul></div>
        <Field label="Publication target" hint="New versions do not update Templates or Agents automatically."><Select disabled={pending || blocked} value={target?.skill_id ?? "new"} onChange={(event) => { const chosen = matching.find((item) => item.skill_id === event.target.value); setTarget(chosen ? { skill_id: chosen.skill_id, expected_version: chosen.current_version } : undefined); setError(""); }}>
          <option value="new">Create a new formal Skill</option>
          {matching.map((item) => <option key={item.skill_id} value={item.skill_id}>Append to {item.name} · Current v{item.current_version}</option>)}
        </Select></Field>
        {target ? <p className="text-xs text-muted-foreground">Expected current version: {target.expected_version}. This publishes version {target.expected_version + 1}.</p> : null}
        {hasMoreTargets ? <Button type="button" variant="secondary" className="w-fit" disabled={pending || moreTargetsPending || blocked} onClick={onMoreTargets}>{moreTargetsPending ? "Loading…" : "Load more published Skills"}</Button> : null}
        {moreTargetsError ? <ErrorNotice message={moreTargetsError} /> : null}
      </> : null}
      {error ? <ErrorNotice message={error} /> : null}
      {blocked ? <Button type="button" variant="secondary" className="w-fit" onClick={onRechoose}>Search again</Button> : null}
      <p className="text-xs leading-5 text-muted-foreground">The source remains a personal Skill. The published version has its own lifecycle; select it in a Template and rebuild Agents to distribute it.</p>
      <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4"><Button type="button" variant="secondary" disabled={pending} onClick={onClose}>Cancel</Button><Button type="submit" disabled={!preview || pending || blocked}>{pending ? "Promoting…" : "Promote Skill"}</Button></div>
    </form>
  </Dialog>;
}
