import { ArrowLeft, Download, FileArchive, Plus, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { PageHeader, ResourceFailureNotice, ResourceFailurePage, SearchField } from "../components/page";
import { Button } from "../components/ui/button";
import { Dialog } from "../components/ui/dialog";
import { Empty, ErrorNotice, Loading, SuccessNotice } from "../components/ui/feedback";
import { api, errorMessage } from "../lib/api";
import { bytes } from "../lib/format";
import { mergePage } from "../lib/pagination";
import { resourceFailure, type ResourceFailure } from "../lib/resource-failure";
import type { SkillSummary, SkillVersion } from "../lib/skills";
import { SkillSources } from "./skill-sources";

export function SkillsPage({ skillID }: { skillID?: string }) {
  return skillID ? <SkillDetail key={skillID} skillID={skillID} /> : <SkillInventory />;
}

function SkillInventory() {
  const [items, setItems] = useState<SkillSummary[]>();
  const [cursor, setCursor] = useState<string | null>(null);
  const [failure, setFailure] = useState<ResourceFailure>();
  const [moreFailure, setMoreFailure] = useState<ResourceFailure>();
  const [morePending, setMorePending] = useState(false);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [success, setSuccess] = useState("");
  const [sources, setSources] = useState(false);
  const load = useCallback(async () => {
    try {
      const page = await api.skills();
      setItems(page.items);
      setCursor(page.next_after_id);
      setFailure(undefined);
    } catch (cause) { setFailure(resourceFailure(cause)); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  async function more() {
    if (!cursor || morePending) return;
    setMorePending(true); setMoreFailure(undefined);
    try {
      const page = await api.skills(cursor);
      setItems((current) => mergePage(current ?? [], page.items, (item) => item.skill_id));
      setCursor(page.next_after_id);
    } catch (cause) { setMoreFailure(resourceFailure(cause)); }
    finally { setMorePending(false); }
  }
  if (!items) return failure ? <ResourceFailurePage eyebrow="Configuration" resource="Skill inventory" returnHref="#overview" returnLabel="Back to Overview" failure={failure} onRetry={() => void load()} /> : <Loading label="Loading Skills" />;
  const shown = items.filter((item) => `${item.name} ${item.description}`.toLowerCase().includes(query.trim().toLowerCase()));
  return <div className="grid gap-5">
    <PageHeader eyebrow="Configuration" title="Skills" detail="Publish immutable Skill packages for this organization. New versions do not change existing Agents." actions={<Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" />Upload Skill</Button>} />
    {success ? <SuccessNotice message={success} onDismiss={() => setSuccess("")} /> : null}
    {failure ? <ResourceFailureNotice failure={failure} retryLabel="Retry Skills" onRetry={() => void load()} /> : null}
    <nav aria-label="Skill views" className="flex flex-wrap gap-2">
      <Button variant={sources ? "secondary" : "default"} aria-pressed={!sources} onClick={() => setSources(false)}>Published Skills</Button>
      <Button variant={sources ? "default" : "secondary"} aria-pressed={sources} onClick={() => setSources(true)}>Discover Agent Skills</Button>
    </nav>
    {sources ? <SkillSources targets={items} hasMoreTargets={cursor !== null} moreTargetsPending={morePending} moreTargetsError={moreFailure?.message} onMoreTargets={() => void more()} onRefreshTargets={load} onPublished={async (version) => { setSuccess(`${version.name} v${version.version} promoted. Add this fixed version to a Template and rebuild to apply it.`); await load(); }} /> : items.length === 0 ? <Empty title="No Skills published" detail="Upload a ZIP package with SKILL.md at its root." action={<Button onClick={() => setOpen(true)}><Upload className="h-4 w-4" />Upload Skill</Button>} /> : <>
      <div className="flex flex-wrap items-center justify-between gap-3"><SearchField aria-label="Search Skills" placeholder="Search Skills" value={query} onChange={(event) => setQuery(event.target.value)} /><span className="text-sm text-muted-foreground">{items.length} loaded{cursor ? " · More available" : ""}</span></div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{shown.map((item) => <a key={item.skill_id} href={`#skills/${encodeURIComponent(item.skill_id)}`} className="rounded-lg border border-border bg-white p-5 shadow-xs transition-colors hover:border-primary focus-visible:outline-2 focus-visible:outline-primary">
        <div className="flex items-start justify-between gap-3"><h2 className="font-semibold text-foreground">{item.name}</h2><span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium">v{item.current_version}</span></div>
        <p className="mt-2 line-clamp-3 text-sm text-muted-foreground">{item.description}</p>
        <p className="mt-4 text-xs text-muted-foreground">ZIP {bytes(item.artifact_size)} · Package rules v{item.package_rules_version}</p>
      </a>)}</div>
      {shown.length === 0 ? <p className="text-sm text-muted-foreground">No loaded Skills match this search.</p> : null}
      {moreFailure ? <ResourceFailureNotice failure={moreFailure} retryLabel="Retry page" onRetry={() => void more()} /> : null}
      {cursor ? <Button className="justify-self-center" disabled={morePending} variant="secondary" onClick={() => void more()}>{morePending ? "Loading…" : "Load more"}</Button> : null}
    </>}
    <SkillUploadDialog open={open} onOpenChange={setOpen} onPublish={async (file) => { const version = await api.publishSkill(file); setSuccess(`${version.name} v${version.version} published.`); await load(); }} />
  </div>;
}

function SkillDetail({ skillID }: { skillID: string }) {
  const [versions, setVersions] = useState<SkillVersion[]>();
  const [cursor, setCursor] = useState<number | null>(null);
  const [failure, setFailure] = useState<ResourceFailure>();
  const [moreFailure, setMoreFailure] = useState<ResourceFailure>();
  const [pending, setPending] = useState(false);
  const [open, setOpen] = useState(false);
  const [success, setSuccess] = useState("");
  const [downloadError, setDownloadError] = useState("");
  const load = useCallback(async () => {
    try { const page = await api.skillVersions(skillID); setVersions(page.items); setCursor(page.next_after_version); setFailure(undefined); }
    catch (cause) { setFailure(resourceFailure(cause)); }
  }, [skillID]);
  useEffect(() => { void load(); }, [load]);
  async function more() {
    if (!cursor || pending) return;
    setPending(true); setMoreFailure(undefined);
    try { const page = await api.skillVersions(skillID, cursor); setVersions((current) => mergePage(current ?? [], page.items, (item) => String(item.version))); setCursor(page.next_after_version); }
    catch (cause) { setMoreFailure(resourceFailure(cause)); }
    finally { setPending(false); }
  }
  async function download(version: number) {
    setDownloadError("");
    try {
      const blob = await api.skillArtifact(skillID, version);
      const url = URL.createObjectURL(blob);
      try { const link = document.createElement("a"); link.href = url; link.download = `${skillID}-v${version}.zip`; document.body.append(link); link.click(); link.remove(); }
      finally { URL.revokeObjectURL(url); }
    } catch (cause) { setDownloadError(errorMessage(cause)); }
  }
  if (!versions) return failure ? <ResourceFailurePage eyebrow="Configuration" resource="Skill versions" returnHref="#skills" returnLabel="Back to Skills" failure={failure} onRetry={() => void load()} /> : <Loading label="Loading Skill versions" />;
  const current = cursor === null ? versions.at(-1) : undefined;
  return <div className="grid gap-5">
    <Button asChild variant="ghost" className="w-fit"><a href="#skills"><ArrowLeft className="h-4 w-4" />Back to Skills</a></Button>
    <PageHeader eyebrow="Configuration / Skills" title={versions[0]?.name ?? "Skill"} detail="Each published version is immutable. Uploading a new version requires the current version number." actions={current ? <Button onClick={() => setOpen(true)}><Upload className="h-4 w-4" />Publish new version</Button> : undefined} />
    {cursor !== null ? <p className="text-sm text-muted-foreground">Load all versions to reach the current head before publishing.</p> : null}
    {success ? <SuccessNotice message={success} onDismiss={() => setSuccess("")} /> : null}
    {failure ? <ResourceFailureNotice failure={failure} retryLabel="Retry versions" onRetry={() => void load()} /> : null}
    {downloadError ? <ErrorNotice message={downloadError} /> : null}
    {versions.length === 0 ? <Empty title="No versions found" detail="This Skill has no published versions." /> : <div className="grid gap-3">{versions.map((version) => <article key={version.version} className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-border bg-white p-5 shadow-xs">
      <div><h2 className="font-semibold">Version {version.version}</h2><p className="mt-1 text-sm text-muted-foreground">{version.description}</p><p className="mt-2 break-all font-mono text-xs text-muted-foreground">{version.content_digest}</p><p className="mt-1 text-xs text-muted-foreground">ZIP {bytes(version.artifact_size)} · Package rules v{version.package_rules_version}</p></div>
      <Button variant="secondary" onClick={() => void download(version.version)}><Download className="h-4 w-4" />Download ZIP</Button>
    </article>)}</div>}
    {moreFailure ? <ResourceFailureNotice failure={moreFailure} retryLabel="Retry page" onRetry={() => void more()} /> : null}
    {cursor ? <Button className="justify-self-center" disabled={pending} variant="secondary" onClick={() => void more()}>{pending ? "Loading…" : "Load more"}</Button> : null}
    {current ? <SkillUploadDialog open={open} onOpenChange={setOpen} expectedVersion={current.version} onPublish={async (file) => { const version = await api.publishSkillVersion(skillID, current.version, file); setSuccess(`Version ${version.version} published.`); await load(); }} /> : null}
  </div>;
}

function SkillUploadDialog({ open, onOpenChange, expectedVersion, onPublish }: { open: boolean; onOpenChange: (value: boolean) => void; expectedVersion?: number; onPublish: (file: File) => Promise<void> }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) { setFile(null); setError(""); }
  }, [open]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!(file instanceof File) || file.size === 0 || file.size > 8 * 1024 * 1024) { setError("Choose a ZIP file of at most 8 MiB."); return; }
    setPending(true); setError("");
    try { await onPublish(file); onOpenChange(false); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setPending(false); }
  }
  return <Dialog open={open} onOpenChange={onOpenChange} title={expectedVersion ? "Publish new version" : "Upload Skill"} description="ZIP root must contain SKILL.md. Publishing creates an immutable version." dismissible={!pending}>
    <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
      {expectedVersion ? <p className="text-sm text-muted-foreground">Expected current version: {expectedVersion}. If another administrator publishes first, refresh and review the new head.</p> : null}
      <div className="grid gap-3 rounded-lg border border-border bg-muted/30 p-4 sm:p-5">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border bg-white text-primary"><FileArchive className="h-5 w-5" aria-hidden="true" /></span>
          <div className="min-w-0 flex-1" aria-live="polite">
            <p className="break-all text-sm font-medium">{file ? file.name : "Choose a Skill package"}</p>
            <p className="mt-1 text-xs text-muted-foreground">{file ? `${bytes(file.size)} · ZIP package` : "ZIP format · Up to 8 MiB"}</p>
          </div>
        </div>
        <input ref={picker} className="sr-only" aria-label="Skill ZIP" name="artifact" type="file" accept=".zip,application/zip" tabIndex={-1} disabled={pending} onChange={(event) => { setFile(event.target.files?.[0] ?? null); setError(""); }} />
        <Button type="button" className="w-fit" variant="secondary" disabled={pending} onClick={() => picker.current?.click()}><Upload className="h-4 w-4" aria-hidden="true" />{file ? "Change file" : "Choose ZIP file"}</Button>
      </div>
      {error ? <ErrorNotice message={error} /> : null}
      <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
        <Button type="button" variant="secondary" disabled={pending} onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button disabled={pending || !file} type="submit">{pending ? "Publishing…" : expectedVersion ? "Publish version" : "Publish Skill"}</Button>
      </div>
    </form>
  </Dialog>;
}
