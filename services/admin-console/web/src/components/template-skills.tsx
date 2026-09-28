import { Plus, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../lib/api";
import type { FrozenSkill, SkillReference, SkillSummary, SkillVersion } from "../lib/skills";
import { Button } from "./ui/button";
import { Field, Select } from "./ui/input";

export function TemplateSkills({ value, frozen = [], onChange, disabled = false }: {
  value: SkillReference[];
  frozen?: FrozenSkill[];
  onChange: (refs: SkillReference[]) => void;
  disabled?: boolean;
}) {
  const [skills, setSkills] = useState<SkillSummary[]>();
  const [cursor, setCursor] = useState<string | null>(null);
  const [skillError, setSkillError] = useState("");
  const [morePending, setMorePending] = useState(false);
  const [selectedID, setSelectedID] = useState("");
  const [versions, setVersions] = useState<SkillVersion[]>();
  const [versionCursor, setVersionCursor] = useState<number | null>(null);
  const [versionError, setVersionError] = useState("");
  const [versionPending, setVersionPending] = useState(false);
  const [selectedVersion, setSelectedVersion] = useState("");
  const [versionAttempt, setVersionAttempt] = useState(0);

  const loadSkills = useCallback(async () => {
    setSkillError("");
    try {
      const page = await api.skills();
      setSkills(page.items);
      setCursor(page.next_after_id);
    } catch (cause) { setSkillError(errorMessage(cause)); }
  }, []);
  useEffect(() => { void loadSkills(); }, [loadSkills]);

  const selectedHead = skills?.find((item) => item.skill_id === selectedID)?.current_version;
  useEffect(() => {
    if (!selectedID) { setVersions(undefined); setSelectedVersion(""); return; }
    let current = true;
    setVersions(undefined); setVersionCursor(null); setVersionError(""); setSelectedVersion("");
    void api.skillVersions(selectedID).then((page) => {
      if (!current) return;
      setVersions(page.items);
      setVersionCursor(page.next_after_version);
      setSelectedVersion(String(page.items.find((item) => item.version === selectedHead)?.version ?? page.items[0]?.version ?? ""));
    }).catch((cause) => { if (current) setVersionError(errorMessage(cause)); });
    return () => { current = false; };
  }, [selectedID, selectedHead, versionAttempt]);

  async function moreSkills() {
    if (!cursor || morePending) return;
    setMorePending(true); setSkillError("");
    try {
      const page = await api.skills(cursor);
      setSkills((current) => [...(current ?? []), ...page.items.filter((item) => !current?.some((known) => known.skill_id === item.skill_id))]);
      setCursor(page.next_after_id);
    } catch (cause) { setSkillError(errorMessage(cause)); }
    finally { setMorePending(false); }
  }

  async function moreVersions() {
    if (!selectedID || !versionCursor || versionPending) return;
    setVersionPending(true); setVersionError("");
    try {
      const page = await api.skillVersions(selectedID, versionCursor);
      setVersions((current) => [...(current ?? []), ...page.items.filter((item) => !current?.some((known) => known.version === item.version))]);
      setVersionCursor(page.next_after_version);
    } catch (cause) { setVersionError(errorMessage(cause)); }
    finally { setVersionPending(false); }
  }

  const selectedIDs = new Set(value.map((ref) => ref.skill_id));
  const available = skills?.filter((item) => !selectedIDs.has(item.skill_id)) ?? [];
  const selectedSkill = available.find((item) => item.skill_id === selectedID);
  const canAdd = Boolean(selectedSkill && versions?.some((item) => String(item.version) === selectedVersion) && value.length < 32);

  return <fieldset disabled={disabled} className="grid min-w-0 gap-3">
    <legend className="mb-1 text-sm font-medium">Preset Skills</legend>
    <p className="text-xs leading-5 text-muted-foreground">Each Template revision keeps exact Skill versions. Existing Agents receive changes only after a rebuild.</p>
    {value.length ? <ul className="grid gap-2" aria-label="Selected Skills">{value.map((ref) => {
      const name = frozen.find((item) => item.skill_id === ref.skill_id)?.name
        ?? skills?.find((item) => item.skill_id === ref.skill_id)?.name ?? ref.skill_id;
      return <li className="flex min-w-0 items-center gap-3 rounded-md border border-border bg-white px-3 py-2" key={ref.skill_id}>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{name} · v{ref.version}</span>
        <span className="shrink-0 text-xs text-muted-foreground">Fixed version</span>
        <Button type="button" size="icon" variant="ghost" aria-label={`Remove ${name}`} onClick={() => onChange(value.filter((item) => item.skill_id !== ref.skill_id))}><X className="h-4 w-4" /></Button>
      </li>;
    })}</ul> : <p className="rounded-md border border-dashed border-border px-3 py-3 text-sm text-muted-foreground">No preset Skills selected.</p>}
    <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(8rem,0.55fr)] sm:items-end">
      <Field label="Add Skill"><Select value={selectedID} onChange={(event) => setSelectedID(event.target.value)} disabled={!skills || !available.length || value.length >= 32}>
        <option value="">Select a Skill</option>
        {available.map((item) => <option key={item.skill_id} value={item.skill_id}>{item.name}</option>)}
      </Select></Field>
      <Field label="Skill version"><Select value={selectedVersion} onChange={(event) => setSelectedVersion(event.target.value)} disabled={!versions?.length || !selectedID}>
        <option value="">Select version</option>
        {versions?.map((item) => <option key={item.version} value={item.version}>v{item.version}</option>)}
      </Select></Field>
      <Button type="button" variant="secondary" className="sm:col-span-2 sm:justify-self-end" disabled={!canAdd} onClick={() => {
        onChange([...value, { skill_id: selectedID, version: Number(selectedVersion) }]);
        setSelectedVersion("");
        setVersions(undefined);
        setSelectedID("");
      }}><Plus className="h-4 w-4" />Add fixed version</Button>
    </div>
    {skillError ? <p role="alert" className="text-sm text-destructive">Skill inventory unavailable: {skillError} <Button type="button" size="sm" variant="ghost" onClick={() => void loadSkills()}>Retry</Button></p> : null}
    {versionError ? <p role="alert" className="text-sm text-destructive">Skill versions unavailable: {versionError} <Button type="button" size="sm" variant="ghost" onClick={() => setVersionAttempt((value) => value + 1)}>Retry</Button></p> : null}
    {cursor ? <Button type="button" size="sm" variant="ghost" className="justify-self-start" disabled={morePending} onClick={() => void moreSkills()}>{morePending ? "Loading Skills…" : "Load more Skills"}</Button> : null}
    {versionCursor ? <Button type="button" size="sm" variant="ghost" className="justify-self-start" disabled={versionPending} onClick={() => void moreVersions()}>{versionPending ? "Loading versions…" : "Load older versions"}</Button> : null}
  </fieldset>;
}
