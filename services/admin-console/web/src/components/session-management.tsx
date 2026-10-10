import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../lib/api";
import { dateTime } from "../lib/format";
import type { BrowserSession } from "../lib/types";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { ErrorNotice, Loading, SuccessNotice } from "./ui/feedback";

export function SessionManagement({ open, onOpenChange, user, organizationName }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user?: { id: string; name: string; current: boolean };
  organizationName?: string;
}) {
  const [rows, setRows] = useState<BrowserSession[]>();
  const [cursor, setCursor] = useState<string>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [confirmation, setConfirmation] = useState<"others" | "all">();
  const scope = useRef<symbol | undefined>(undefined);
  const busy = useRef(false);
  const read = useRef<AbortController | undefined>(undefined);
  const userID = user?.id;

  const load = useCallback(async (after?: string) => {
    const current = scope.current;
    if (!current || busy.current) return;
    busy.current = true;
    setPending(true);
    setError("");
    const controller = new AbortController();
    read.current = controller;
    try {
      const result = userID ? await api.organizationSessions(userID, after, controller.signal) : await api.sessions(after, controller.signal);
      if (scope.current !== current || controller.signal.aborted) return;
      setRows(previous => after ? [...(previous ?? []), ...result.sessions.filter(row => !previous?.some(existing => existing.id === row.id))] : result.sessions);
      setCursor(result.next_after_id);
    } catch (cause) {
      if (scope.current === current && !controller.signal.aborted) setError(errorMessage(cause));
    } finally {
      if (scope.current === current) {
        busy.current = false;
        setPending(false);
        read.current = undefined;
      }
    }
  }, [userID]);

  useEffect(() => {
    if (!open) return;
    scope.current = Symbol();
    busy.current = false;
    setRows(undefined);
    setCursor(undefined);
    setConfirmation(undefined);
    setSuccess("");
    void load();
    return () => {
      scope.current = undefined;
      read.current?.abort();
      read.current = undefined;
    };
  }, [open, load]);

  async function revoke() {
    const current = scope.current;
    if (!current || !confirmation || busy.current) return;
    busy.current = true;
    setPending(true);
    setError("");
    setSuccess("");
    try {
      const result = userID ? await api.revokeOrganizationSessions(userID) : await api.revokeSessions(confirmation);
      if (scope.current !== current) return;
      setConfirmation(undefined);
      setSuccess(`${result.revoked_count} sessions revoked.`);
      if (result.current_revoked) { onOpenChange(false); return; }
      busy.current = false;
      await load();
    } catch (cause) {
      if (scope.current === current) setError(errorMessage(cause));
    } finally {
      if (scope.current === current) { busy.current = false; setPending(false); }
    }
  }

  return <Dialog open={open} onOpenChange={onOpenChange} dismissible={!pending || !confirmation}
    title={user ? `${user.name} browser sessions` : "Your browser sessions"}
    description={user ? `Only sessions in ${organizationName ?? "this organization"} are shown and revoked.` : "Review your active browser sessions across organizations."}>
    <div className="grid gap-4">
      {error ? <ErrorNotice message={error} /> : null}
      {success ? <SuccessNotice message={success} /> : null}
      {confirmation ? <div className="grid gap-3 rounded-md border border-border p-4">
        <p>{confirmation === "others" ? "Sign out your other browser sessions in all organizations?" : user ? `Revoke all of ${user.name}'s sessions in this organization?` : "Sign out all your browser sessions in all organizations?"}</p>
        {confirmation === "all" && (!user || user.current) ? <p className="text-sm text-muted-foreground">This includes the current browser. You will need to sign in again.</p> : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" disabled={pending} onClick={() => setConfirmation(undefined)}>Cancel revocation</Button>
          <Button disabled={pending} aria-busy={pending} onClick={() => void revoke()}>Confirm revocation</Button>
        </div>
      </div> : null}
      {rows === undefined ? pending ? <Loading label="Loading browser sessions" /> : null : <>
        {rows.length === 0 ? <p className="text-sm text-muted-foreground">No active sessions in this page.</p> : <ul aria-label="Browser sessions" className="grid gap-3">
          {rows.map(row => <li key={row.id} className="rounded-md border border-border p-4">
            <p className="font-medium">{row.organization_name}{row.current ? " · Current browser" : ""}</p>
            <p className="mt-1 break-words text-sm text-muted-foreground">{row.user_agent_hint || "Browser details unavailable"}</p>
            <dl className="mt-3 grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
              <div><dt>Signed in</dt><dd>{dateTime(row.created_at)}</dd></div>
              <div><dt>Last active</dt><dd>{dateTime(row.last_active_at)}</dd></div>
              <div><dt>Idle expiry</dt><dd>{dateTime(row.idle_expires_at)}</dd></div>
              <div><dt>Session expiry</dt><dd>{dateTime(row.expires_at)}</dd></div>
            </dl>
          </li>)}
        </ul>}
        {cursor ? <Button variant="secondary" disabled={pending} onClick={() => void load(cursor)}>Load more sessions</Button> : null}
        <div className="flex flex-wrap gap-2">
          {!user ? <Button variant="secondary" disabled={pending} onClick={() => setConfirmation("others")}>Sign out other sessions</Button> : null}
          <Button variant="secondary" disabled={pending} onClick={() => setConfirmation("all")}>{user ? "Revoke organization sessions" : "Sign out all sessions"}</Button>
        </div>
      </>}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" disabled={pending} onClick={() => void load()}>Refresh sessions</Button>
        <Button disabled={pending && Boolean(confirmation)} onClick={() => onOpenChange(false)}>Done</Button>
      </div>
    </div>
  </Dialog>;
}
