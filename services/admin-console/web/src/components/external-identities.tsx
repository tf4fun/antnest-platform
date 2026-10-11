import { useCallback, useEffect, useRef, useState } from "react";
import { APIError, api, errorMessage } from "../lib/api";
import { dateTime } from "../lib/format";
import type { ExternalIdentity, ExternalIdentityBindInput, ExternalIdentityDetails, ExternalIdentityNotice } from "../lib/types";
import { IdentityProviderSelect } from "./identity-provider-select";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { ErrorNotice, Loading, SuccessNotice } from "./ui/feedback";
import { Field, Textarea } from "./ui/input";

type Stream = "both" | "bindings" | "notices";
function appendByID<T extends { id: string }>(before: T[], next: T[]): T[] {
  return [...before, ...next.filter(row => !before.some(existing => existing.id === row.id))];
}

function useExternalIdentities(membershipID?: string) {
  const [bindings, setBindings] = useState<ExternalIdentity[]>();
  const [notices, setNotices] = useState<ExternalIdentityNotice[]>([]);
  const [bindingCursor, setBindingCursor] = useState<string>();
  const [noticeCursor, setNoticeCursor] = useState<string>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const live = useRef<symbol | undefined>(undefined);
  const busy = useRef(false);
  const read = useRef<AbortController | undefined>(undefined);

  const load = useCallback(async (stream: Stream = "both", after?: string) => {
    const current = live.current;
    if (!current || busy.current) return;
    busy.current = true; setPending(true); setError("");
    const controller = new AbortController(); read.current = controller;
    try {
      const page = membershipID
        ? await api.organizationExternalIdentities(membershipID, after, controller.signal)
        : await api.externalIdentities(stream === "bindings" ? { afterID: after } : stream === "notices" ? { noticeAfterID: after } : {}, controller.signal);
      if (live.current !== current || controller.signal.aborted) return;
      // Each cursor describes its own scan. The other returned stream is ignored
      // when loading more so it cannot replace rows or silently advance a cursor.
      if (stream !== "notices") {
        setBindings(previous => after ? appendByID(previous ?? [], page.bindings) : page.bindings);
        setBindingCursor(page.next_after_id);
      }
      if (stream !== "bindings" && "notices" in page) {
        setNotices(previous => after ? appendByID(previous, page.notices as ExternalIdentityNotice[]) : page.notices as ExternalIdentityNotice[]);
        setNoticeCursor("next_notice_after_id" in page ? page.next_notice_after_id as string | undefined : undefined);
      }
    } catch (cause) {
      if (live.current === current && !controller.signal.aborted) setError(errorMessage(cause));
    } finally {
      if (live.current === current) { busy.current = false; read.current = undefined; setPending(false); }
    }
  }, [membershipID]);

  useEffect(() => {
    live.current = Symbol(); busy.current = false; void load();
    return () => { live.current = undefined; read.current?.abort(); read.current = undefined; };
  }, [load]);
  return { bindings, notices, setNotices, bindingCursor, noticeCursor, pending, setPending, error, setError, success, setSuccess, live, busy, load };
}

function IdentityDetails({ row, linkedAt = row.created_at }: { row: ExternalIdentityDetails; linkedAt?: string }) {
  return <>
    <p className="font-medium">{row.provider_display_name}</p>
    <p className="text-sm">{row.organization_name}</p>
    <code className="mt-2 block whitespace-pre-wrap break-all rounded-md bg-muted/60 p-2 text-xs">{row.subject}</code>
    <p className="mt-2 text-xs text-muted-foreground">Linked by {row.method} · {dateTime(linkedAt)}</p>
  </>;
}

function BindingList({ rows, pending, onUnbind }: { rows?: ExternalIdentity[]; pending: boolean; onUnbind: (row: ExternalIdentity) => void }) {
  if (!rows) return pending ? <Loading label="Loading external logins" /> : null;
  if (!rows.length) return <p className="text-sm text-muted-foreground">No external logins to display.</p>;
  return <ul aria-label="External login bindings" className="grid gap-3">{rows.map(row => <li key={row.id} className="rounded-md border border-border p-4">
    <IdentityDetails row={row} linkedAt={row.bound_at} />
    {row.revoked_at ? <p className="mt-2 text-sm text-muted-foreground">Revoked · {dateTime(row.revoked_at)}</p> : <>
      {!row.provider_enabled ? <p className="mt-2 text-sm text-muted-foreground">Provider disabled</p> : null}
      <div className="mt-3 flex justify-end"><Button variant="secondary" disabled={pending} aria-label={`Unbind ${row.provider_display_name}`} onClick={() => onUnbind(row)}>Unbind</Button></div>
    </>}
  </li>)}</ul>;
}

function UnbindConfirmation({ binding, lockout, pending, onConfirm, onCancel }: {
  binding?: ExternalIdentity; lockout: boolean; pending: boolean; onConfirm: (allow: boolean) => void; onCancel: () => void;
}) {
  if (!binding) return null;
  return <div className="grid gap-3 rounded-md border border-border bg-muted/30 p-4">
    <p>Unbind {binding.provider_display_name} in {binding.organization_name}?</p>
    <p className="text-sm text-muted-foreground">This revokes browser sessions for this membership. Accepted Agent work continues.</p>
    {lockout ? <p className="text-sm text-destructive">This is the last available login method for this membership. Continuing may prevent signing in to this organization until an administrator restores access.</p> : null}
    <div className="flex flex-wrap justify-end gap-2">
      <Button variant="secondary" disabled={pending} onClick={onCancel}>Cancel unbind</Button>
      <Button variant="destructive" disabled={pending} onClick={() => onConfirm(lockout)}>{lockout ? "Unbind and accept lockout" : "Confirm unbind"}</Button>
    </div>
  </div>;
}

function useUnbind(inventory: ReturnType<typeof useExternalIdentities>, onCurrentRevoked: () => void, membershipID?: string) {
  const [target, setTarget] = useState<ExternalIdentity>();
  const [lockout, setLockout] = useState(false);
  function select(row?: ExternalIdentity) { setTarget(row); setLockout(false); inventory.setError(""); }
  async function confirm(allow: boolean) {
    const current = inventory.live.current;
    if (!current || !target || inventory.busy.current) return;
    inventory.busy.current = true; inventory.setPending(true); inventory.setError(""); inventory.setSuccess("");
    try {
      const result = membershipID ? await api.unbindOrganizationExternalIdentity(membershipID, target.id, allow) : await api.unbindExternalIdentity(target.id, allow);
      if (inventory.live.current !== current) return;
      setTarget(undefined); setLockout(false);
      if (result.current_revoked) { onCurrentRevoked(); return; }
      inventory.setSuccess(`External login unbound. ${result.revoked_count} sessions revoked.`);
      inventory.busy.current = false; await inventory.load();
    } catch (cause) {
      if (inventory.live.current === current) {
        inventory.setError(errorMessage(cause));
        if (cause instanceof APIError && cause.code === "external_identity_last_method") setLockout(true);
      }
    } finally { if (inventory.live.current === current) { inventory.busy.current = false; inventory.setPending(false); } }
  }
  return { target, lockout, select, confirm };
}

export function SelfExternalIdentities({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const inventory = useExternalIdentities();
  const unbind = useUnbind(inventory, () => onOpenChange(false));
  // Do not carry a destructive confirmation across closing and reopening.
  function changeOpen(next: boolean) { if (!next) unbind.select(); onOpenChange(next); }
  async function acknowledge(noticeID: string) {
    const current = inventory.live.current;
    if (!current || inventory.busy.current) return;
    const ids = [noticeID];
    inventory.busy.current = true; inventory.setPending(true); inventory.setError("");
    try {
      await api.acknowledgeExternalIdentityNotices(ids);
      if (inventory.live.current !== current) return;
      // Acknowledgment is by immutable notice ID, never by binding/provider.
      inventory.setNotices(previous => previous.filter(row => !ids.includes(row.id)));
    } catch (cause) {
      if (inventory.live.current === current) inventory.setError(errorMessage(cause));
    } finally { if (inventory.live.current === current) { inventory.busy.current = false; inventory.setPending(false); } }
  }
  return <>
    {!open && inventory.notices.length > 0 ? <div role="status" className="mb-5 rounded-lg border border-border bg-white p-4 shadow-xs">
      <p className="text-sm">New external login activity needs your review.</p>
      <Button className="mt-2" variant="secondary" onClick={() => changeOpen(true)}>Review external login notices</Button>
    </div> : null}
    <Dialog open={open} onOpenChange={changeOpen} dismissible={!inventory.pending || !unbind.target} title="Your external logins" description="Review linked identities and new binding notices across your organizations.">
      <div className="grid gap-4">
        {inventory.error ? <ErrorNotice message={inventory.error} /> : null}
        {inventory.success ? <SuccessNotice message={inventory.success} /> : null}
        <UnbindConfirmation binding={unbind.target} lockout={unbind.lockout} pending={inventory.pending} onConfirm={allow => void unbind.confirm(allow)} onCancel={() => unbind.select()} />
        <BindingList rows={inventory.bindings} pending={inventory.pending} onUnbind={unbind.select} />
        {inventory.bindingCursor ? <Button variant="secondary" disabled={inventory.pending} onClick={() => void inventory.load("bindings", inventory.bindingCursor)}>Load more bindings</Button> : null}
        <section className="grid gap-3" aria-label="New external login notices">
          <h3 className="font-medium">New binding notices</h3>
          {!inventory.notices.length ? <p className="text-sm text-muted-foreground">No unacknowledged notices in this page.</p> : <ul className="grid gap-3">{inventory.notices.map(notice => <li key={notice.id} className="rounded-md border border-border p-4">
            <IdentityDetails row={notice} />
            <div className="mt-3 flex justify-end"><Button variant="secondary" disabled={inventory.pending} aria-label={`Acknowledge notice ${notice.id}`} onClick={() => void acknowledge(notice.id)}>Acknowledge</Button></div>
          </li>)}</ul>}
          {inventory.noticeCursor ? <Button variant="secondary" disabled={inventory.pending} onClick={() => void inventory.load("notices", inventory.noticeCursor)}>Load more notices</Button> : null}
        </section>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" disabled={inventory.pending} onClick={() => void inventory.load()}>Refresh external logins</Button>
          <Button disabled={inventory.pending && Boolean(unbind.target)} onClick={() => changeOpen(false)}>Done</Button>
        </div>
      </div>
    </Dialog>
  </>;
}

export function OrganizationExternalIdentities({ membership, onClose }: { membership: { id: string; name: string }; onClose: () => void }) {
  return <OrganizationExternalIdentityDetails key={membership.id} membership={membership} onClose={onClose} />;
}

function OrganizationExternalIdentityDetails({ membership, onClose }: { membership: { id: string; name: string }; onClose: () => void }) {
  const inventory = useExternalIdentities(membership.id);
  const unbind = useUnbind(inventory, onClose, membership.id);
  const [providerID, setProviderID] = useState("");
  const [subject, setSubject] = useState("");
  const [restore, setRestore] = useState<ExternalIdentityBindInput>();
  async function bind(input: ExternalIdentityBindInput) {
    const current = inventory.live.current;
    if (!current || inventory.busy.current) return;
    inventory.busy.current = true; inventory.setPending(true); inventory.setError(""); inventory.setSuccess("");
    try {
      await api.bindExternalIdentity(membership.id, input);
      if (inventory.live.current !== current) return;
      setRestore(undefined); setSubject(""); inventory.setSuccess("External login bound.");
      inventory.busy.current = false; await inventory.load();
    } catch (cause) {
      if (inventory.live.current === current) {
        inventory.setError(errorMessage(cause));
        if (cause instanceof APIError && cause.code === "external_identity_restore_required") setRestore(input);
      }
    } finally { if (inventory.live.current === current) { inventory.busy.current = false; inventory.setPending(false); } }
  }
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }} dismissible={!inventory.pending} title={`${membership.name} external logins`} description="Manage exact provider subjects for this membership in the current organization.">
    <div className="grid gap-4">
      {inventory.error ? <ErrorNotice message={inventory.error} /> : null}
      {inventory.success ? <SuccessNotice message={inventory.success} /> : null}
      <UnbindConfirmation binding={unbind.target} lockout={unbind.lockout} pending={inventory.pending} onConfirm={allow => void unbind.confirm(allow)} onCancel={() => unbind.select()} />
      <BindingList rows={inventory.bindings} pending={inventory.pending} onUnbind={unbind.select} />
      {inventory.bindingCursor ? <Button variant="secondary" disabled={inventory.pending} onClick={() => void inventory.load("bindings", inventory.bindingCursor)}>Load more bindings</Button> : null}
      <form className="grid gap-3 border-t border-border pt-4" onChange={() => setRestore(undefined)} onSubmit={event => { event.preventDefault(); void bind({ provider_id: providerID, subject, restore_revoked: false }); }}>
        <IdentityProviderSelect value={providerID} disabled={inventory.pending} onChange={event => setProviderID(event.target.value)} />
        <Field label="Provider subject" hint="Copy the provider's exact subject. Spaces, case and Unicode are preserved; email is not a substitute for subject.">
          <Textarea name="subject" value={subject} required disabled={inventory.pending} onChange={event => setSubject(event.target.value)} />
        </Field>
        <Button type="submit" disabled={inventory.pending || Boolean(restore)}>Bind external login</Button>
        {restore ? <div className="grid gap-2 rounded-md border border-border p-3"><p className="text-sm">This exact binding was explicitly revoked. Restore it and allow this external identity to sign in again?</p>
          <Button type="button" disabled={inventory.pending} onClick={() => void bind({ ...restore, restore_revoked: true })}>Restore revoked binding</Button>
        </div> : null}
      </form>
      <div className="flex justify-end gap-2"><Button variant="secondary" disabled={inventory.pending} onClick={() => void inventory.load()}>Refresh external logins</Button><Button disabled={inventory.pending} onClick={onClose}>Done</Button></div>
    </div>
  </Dialog>;
}
