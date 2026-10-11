import { useEffect, useRef, useState, type FormEvent } from "react";
import { X } from "lucide-react";
import type { BrowserAccount, BrowserSessionClient, SessionInventory } from "../lib/browser-session";

export function BrowserAccountPanel({ client, onClose }: { client: BrowserSessionClient; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [binding] = useState(() => client.capture(true));
  const request = useRef<AbortController | undefined>(undefined);
  const [account, setAccount] = useState<BrowserAccount>();
  const [inventory, setInventory] = useState<SessionInventory>({ sessions: [] });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const flight = useRef(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmation, setConfirmation] = useState<"others" | "all" | null>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [repeatPassword, setRepeatPassword] = useState("");
  const live = () => request.current !== undefined && !request.current.signal.aborted && client.current(binding);
  const failure = (cause: unknown) => {
    if (live()) setError(cause instanceof Error ? cause.message : "Account request failed.");
  };
  useEffect(() => {
    const previousFocus = document.activeElement;
    const element = dialog.current!;
    element.showModal();
    request.current = new AbortController();
    const controller = request.current;
    const currentLoad = () => request.current === controller && !controller.signal.aborted && client.current(binding);
    void Promise.all([client.account(controller.signal), client.sessions(undefined, controller.signal)]).then(([result, page]) => {
      if (!currentLoad() || !client.responseCurrent(result) || !client.responseCurrent(page)) return;
      setAccount(result.account);
      setInventory(page);
    }).catch(cause => { if (currentLoad()) failure(cause); })
      .finally(() => { if (currentLoad()) setLoading(false); });
    return () => {
      controller.abort();
      element.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, [client]);

  async function load(after?: string) {
    if (!live() || flight.current) return;
    flight.current = true;
    setLoading(true);
    setError("");
    try {
      if (!account) {
        const result = await client.account(request.current!.signal);
        if (!live() || !client.responseCurrent(result)) return;
        setAccount(result.account);
      }
      const page = await client.sessions(after, request.current!.signal);
      if (!live() || !client.responseCurrent(page)) return;
      setInventory(current => ({ ...page, sessions: after
        ? [...current.sessions, ...page.sessions.filter(row => !current.sessions.some(old => old.id === row.id))] : page.sessions }));
    } catch (cause) { failure(cause); }
    finally { flight.current = false; if (live()) setLoading(false); }
  }
  async function revoke() {
    if (!confirmation || !live() || flight.current) return;
    const mode = confirmation;
    flight.current = true;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await client.revoke(mode, request.current!.signal);
      if (!live() || !client.responseCurrent(result)) return;
      setConfirmation(null);
      setNotice(`${result.revoked_count} ${result.revoked_count === 1 ? "session was" : "sessions were"} signed out.`);
      const page = await client.sessions(undefined, request.current!.signal);
      if (live() && client.responseCurrent(page)) setInventory(page);
    } catch (cause) { failure(cause); }
    finally { flight.current = false; if (live()) setBusy(false); }
  }
  async function password(event: FormEvent) {
    event.preventDefault();
    if (!live() || flight.current || !account?.local_password_available) return;
    setError(""); setNotice("");
    if ([...newPassword].length < 12) { setError("Use at least 12 characters for the new password."); return; }
    if (newPassword !== repeatPassword) { setError("The new passwords do not match."); return; }
    flight.current = true; setBusy(true);
    try {
      const result = await client.password(currentPassword, newPassword, request.current!.signal);
      if (!request.current?.signal.aborted && client.responseCurrent(result)) {
        setCurrentPassword(""); setNewPassword(""); setRepeatPassword("");
        onClose();
      }
    } catch (cause) { failure(cause); }
    finally { flight.current = false; if (live()) setBusy(false); }
  }

  return <dialog ref={dialog} className="browser-account-panel" aria-labelledby="browser-account-title"
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <header><div><p className="chooser-kicker">Your account</p><h1 id="browser-account-title">Account and sessions</h1></div>
      <button className="icon-button" type="button" aria-label="Close account and sessions" onClick={onClose}><X size={18} aria-hidden="true" /></button>
    </header>
    {account ? <p>{account.display_name}<br /><span>{account.email}</span></p> : null}
    {error ? <p className="workspace-alert" role="alert">{error}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    <section aria-labelledby="browser-sessions-title" aria-busy={loading}>
      <h2 id="browser-sessions-title">Browser sessions</h2>
      <p>Review your signed-in browsers across organizations. Background updates do not keep a session active.</p>
      <div className="account-actions">
        <button type="button" disabled={loading || busy} onClick={() => { if (live()) setConfirmation("others"); }}>Sign out other sessions</button>
        <button type="button" disabled={loading || busy} onClick={() => { if (live()) setConfirmation("all"); }}>Sign out all sessions</button>
        <button type="button" disabled={loading || busy} onClick={() => { void load(); }}>Refresh sessions</button>
      </div>
      {confirmation ? <section className="account-confirmation" role="alertdialog" aria-label="Confirm session sign out">
        <p>{confirmation === "all" ? "This signs you out of every organization, including this browser." : "This signs out your other browsers across all organizations."}</p>
        <div className="account-actions"><button type="button" disabled={busy} onClick={() => { void revoke(); }}>
          {confirmation === "all" ? "Confirm sign out all sessions" : "Confirm sign out other sessions"}
        </button><button type="button" disabled={busy} onClick={() => setConfirmation(null)}>Cancel</button></div>
      </section> : null}
      <ul className="browser-session-list">
        {inventory.sessions.map(row => <li key={row.id}>
          <strong>{row.current ? "This browser" : "Other browser"} · {row.organization_name}</strong>
          <p className="session-agent-hint">{row.user_agent_hint || "Browser information unavailable"}</p>
          <dl><dt>Signed in</dt><dd>{date(row.created_at)}</dd>
            <dt>Last active</dt><dd>{date(row.last_active_at)}</dd>
            <dt>Idle expiry</dt><dd>{date(row.idle_expires_at)}</dd>
            <dt>Absolute expiry</dt><dd>{date(row.expires_at)}</dd></dl>
        </li>)}
      </ul>
      {loading ? <p role="status">Loading sessions…</p> : null}
      {inventory.next_after_id ? <button type="button" disabled={loading || busy} onClick={() => { void load(inventory.next_after_id); }}>Load more sessions</button> : null}
    </section>
    {account?.local_password_available ? <section aria-labelledby="account-password-title">
      <h2 id="account-password-title">Change password</h2>
      <p>A password change signs out all other sessions. This browser keeps the original absolute expiry.</p>
      <form onSubmit={event => { void password(event); }}>
        <label>Current password<input type="password" autoComplete="current-password" required value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} disabled={busy} /></label>
        <label>New password<input type="password" autoComplete="new-password" required value={newPassword} onChange={event => setNewPassword(event.target.value)} disabled={busy} /></label>
        <label>Confirm new password<input type="password" autoComplete="new-password" required value={repeatPassword} onChange={event => setRepeatPassword(event.target.value)} disabled={busy} /></label>
        <button type="submit" disabled={busy || loading}>Update password</button>
      </form>
    </section> : account ? <p>Your password is managed by your organization's sign-in provider.</p> : null}
  </dialog>;
}
function date(value: string): string {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : "Unavailable";
}
