import { useCallback, useEffect, useRef, useState } from "react";
import { BrowserSessionChanged, BrowserSessionError, type BrowserRequest, type BrowserSessionClient, type ExternalIdentity, type ExternalIdentityNotice } from "./browser-session";

type Scope = { session: BrowserRequest; controller: AbortController };
type Stream = "both" | "bindings" | "notices";
function append<T extends { id: string }>(before: T[], next: T[]): T[] {
  return [...before, ...next.filter(row => !before.some(old => old.id === row.id))];
}
function message(cause: unknown) { return cause instanceof Error ? cause.message : "External login request failed."; }

/** Owned by the validated shell, independently of Agent selection and panel visibility. */
export function useExternalIdentities(client: BrowserSessionClient, enabled = true) {
  const [bindings, setBindings] = useState<ExternalIdentity[]>();
  const [notices, setNotices] = useState<ExternalIdentityNotice[]>([]);
  const [bindingCursor, setBindingCursor] = useState<string>();
  const [noticeCursor, setNoticeCursor] = useState<string>();
  const [pending, setPending] = useState(false), [error, setError] = useState(""), [success, setSuccess] = useState("");
  const scope = useRef<Scope | undefined>(undefined);
  const flight = useRef(false);
  const active = useCallback((current: Scope | undefined): current is Scope => Boolean(current && scope.current === current && !current.controller.signal.aborted && client.current(current.session)), [client]);

  const load = useCallback(async (stream: Stream = "both", after?: string) => {
    const current = scope.current;
    if (!active(current) || flight.current) return;
    flight.current = true; setPending(true); setError("");
    try {
      const page = await client.externalIdentities(stream === "bindings" ? { afterID: after } : stream === "notices" ? { noticeAfterID: after } : {}, current.controller.signal);
      if (!active(current) || !client.responseCurrent(page)) return;
      // A page always contains both streams. Only the requested stream advances.
      if (stream !== "notices") {
        setBindings(previous => after ? append(previous ?? [], page.bindings) : page.bindings);
        setBindingCursor(page.next_after_id);
      }
      if (stream !== "bindings") {
        setNotices(previous => after ? append(previous, page.notices) : page.notices);
        setNoticeCursor(page.next_notice_after_id);
      }
    } catch (cause) { if (active(current)) setError(message(cause)); }
    finally { if (active(current)) { flight.current = false; setPending(false); } }
  }, [client, active]);

  useEffect(() => {
    setBindings(undefined); setNotices([]); setBindingCursor(undefined); setNoticeCursor(undefined);
    setError(""); setSuccess(""); setPending(false); flight.current = false;
    if (!enabled) return;
    let session: BrowserRequest;
    try { session = client.capture(); }
    catch (cause) {
      // capture already notifies the shell to validate changed credentials.
      if (cause instanceof BrowserSessionChanged) return;
      throw cause;
    }
    const current = { session, controller: new AbortController() };
    scope.current = current;
    void load();
    return () => { current.controller.abort(); if (scope.current === current) scope.current = undefined; };
  }, [client, enabled, load]);

  async function acknowledge(noticeID: string) {
    const current = scope.current;
    if (!active(current) || flight.current) return;
    const ids = [noticeID];
    flight.current = true; setPending(true); setError("");
    try {
      const result = await client.acknowledgeExternalIdentityNotices(ids, current.controller.signal);
      if (active(current) && client.responseCurrent(result)) setNotices(previous => previous.filter(row => !ids.includes(row.id)));
    } catch (cause) { if (active(current)) setError(message(cause)); }
    finally { if (active(current)) { flight.current = false; setPending(false); } }
  }
  async function unbind(bindingID: string, allowLockout: boolean): Promise<"unbound" | "last_method" | undefined> {
    const current = scope.current;
    if (!active(current) || flight.current) return;
    flight.current = true; setPending(true); setError(""); setSuccess("");
    try {
      const result = await client.unbindExternalIdentity(bindingID, allowLockout, current.controller.signal);
      // Current revocation ends the generation in the client; never refresh it.
      if (!active(current) || !client.responseCurrent(result)) return;
      setSuccess(`External login unbound. ${result.revoked_count} ${result.revoked_count === 1 ? "session" : "sessions"} revoked.`);
      flight.current = false; await load();
      return "unbound";
    } catch (cause) {
      if (active(current)) {
        setError(message(cause));
        if (cause instanceof BrowserSessionError && cause.code === "external_identity_last_method") return "last_method";
      }
    } finally { if (active(current)) { flight.current = false; setPending(false); } }
  }
  return { bindings, notices, bindingCursor, noticeCursor, pending, error, success, load, acknowledge, unbind };
}
export type ExternalIdentitiesModel = ReturnType<typeof useExternalIdentities>;
