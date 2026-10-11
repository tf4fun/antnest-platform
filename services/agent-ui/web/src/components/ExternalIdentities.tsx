import { useEffect, useRef, useState } from "react";
import type { ExternalIdentity, ExternalIdentityDetails } from "../lib/browser-session";
import type { ExternalIdentitiesModel } from "../lib/use-external-identities";

function Details({ row, linkedAt = row.created_at }: { row: ExternalIdentityDetails; linkedAt?: string }) {
  return <><strong>{row.provider_display_name}</strong><p>{row.organization_name}</p>
    <code className="external-login-subject">{row.subject}</code>
    <p>Linked by {row.method} · {new Date(linkedAt).toLocaleString()}</p></>;
}

export function ExternalIdentitiesSection({ model, disabled = false }: { model: ExternalIdentitiesModel; disabled?: boolean }) {
  const [target, setTarget] = useState<ExternalIdentity>();
  const [lockout, setLockout] = useState(false);
  const mounted = useRef<symbol | undefined>(undefined);
  useEffect(() => { mounted.current = Symbol(); return () => { mounted.current = undefined; }; }, []);
  const busy = disabled || model.pending;
  function select(row?: ExternalIdentity) { setTarget(row); setLockout(false); }
  async function confirm() {
    const current = mounted.current;
    if (!target || busy || !current) return;
    const result = await model.unbind(target.id, lockout);
    if (mounted.current !== current) return;
    if (result === "last_method") setLockout(true);
    else if (result === "unbound") select();
  }
  return <section aria-labelledby="external-login-title" aria-busy={model.pending}>
    <h2 id="external-login-title">External logins</h2>
    <p>Review linked identities and new binding notices across your organizations.</p>
    {model.error ? <p className="workspace-alert" role="alert">{model.error}</p> : null}
    {model.success ? <p role="status">{model.success}</p> : null}
    {target ? <section className="account-confirmation" role="alertdialog" aria-label="Confirm external login unbind">
      <p>Unbind {target.provider_display_name} in {target.organization_name}?</p>
      <p>This revokes browser sessions for this membership. Accepted Agent work continues.</p>
      {lockout ? <p>This is the last available login method for this membership. Continuing may prevent signing in to this organization until an administrator restores access.</p> : null}
      <div className="account-actions"><button type="button" disabled={busy} onClick={() => { void confirm(); }}>{lockout ? "Unbind and accept lockout" : "Confirm unbind"}</button>
        <button type="button" disabled={busy} onClick={() => select()}>Cancel unbind</button></div>
    </section> : null}
    {model.bindings?.length ? <ul className="browser-session-list" aria-label="External login bindings">
      {model.bindings.map(row => <li key={row.id}><Details row={row} linkedAt={row.bound_at} />
        {row.revoked_at ? <p>Revoked · {new Date(row.revoked_at).toLocaleString()}</p> : <>
          {!row.provider_enabled ? <p>Provider disabled</p> : null}
          <button type="button" disabled={busy} aria-label={`Unbind ${row.provider_display_name}`} onClick={() => select(row)}>Unbind</button>
        </>}
      </li>)}
    </ul> : <p>{model.bindings ? "No external logins to display." : model.pending ? "Loading external logins…" : "External login inventory is not available."}</p>}
    {model.bindingCursor ? <button type="button" disabled={busy} onClick={() => { void model.load("bindings", model.bindingCursor); }}>Load more bindings</button> : null}
    <section aria-labelledby="external-notice-title"><h3 id="external-notice-title">New binding notices</h3>
      {model.notices.length ? <ul className="browser-session-list">{model.notices.map(row => <li key={row.id}><Details row={row} />
        <button type="button" disabled={busy} aria-label={`Acknowledge ${row.provider_display_name} in ${row.organization_name}`} onClick={() => { void model.acknowledge(row.id); }}>Acknowledge</button>
      </li>)}</ul> : <p>No unacknowledged notices in this page.</p>}
      {model.noticeCursor ? <button type="button" disabled={busy} onClick={() => { void model.load("notices", model.noticeCursor); }}>Load more notices</button> : null}
    </section>
    <div className="account-actions"><button type="button" disabled={busy} onClick={() => { void model.load(); }}>Refresh external logins</button></div>
  </section>;
}

export function ExternalIdentityBanner({ model, onReview }: { model: ExternalIdentitiesModel; onReview: () => void }) {
  return model.notices.length || model.noticeCursor ? <aside className="external-login-banner" role="status">
    <span>New external login activity needs your review.</span><button type="button" onClick={onReview}>Review external login notices</button>
  </aside> : null;
}
