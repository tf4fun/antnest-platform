import { useEffect, useRef, useState } from "react";
import { WorkspacePage } from "./WorkspacePage";
import { useBridgeWorkspace } from "./lib/use-bridge-workspace";
import { BrowserSessionClient, BrowserSessionChanged, type BrowserSession } from "./lib/browser-session";
import { BridgeHttpClient } from "./lib/workspace-api-client";
import { csrfFromCookie } from "./lib/session";
import { listenForSessionActivity } from "./lib/session-activity";
import { BrowserAccountPanel } from "./components/BrowserAccountPanel";
import { ExternalIdentityBanner } from "./components/ExternalIdentities";
import { useExternalIdentities } from "./lib/use-external-identities";
import { readWorkspaceRoute, workspacePath, type WorkspaceRoute } from "./lib/navigation";

type Props = { initialBootstrap?: unknown; initialRoute?: WorkspaceRoute };
type Authentication = { generation: number } & (
  { phase: "initial" | "validating" | "ended" } |
  { phase: "ready"; session: BrowserSession } |
  { phase: "error"; message: string }
);

export default function BridgeApp({ initialBootstrap, initialRoute }: Props = {}) {
  const [client] = useState(() => new BrowserSessionClient({ csrf: () => csrfFromCookie(document.cookie) }));
  const [authentication, setAuthentication] = useState<Authentication>({ phase: "initial", generation: 0 });
  const retry = useRef<() => void>(() => {});
  useEffect(() => {
    let active = true;
    let request: AbortController | undefined;
    const validate = () => {
      request?.abort();
      const current = new AbortController();
      request = current;
      void client.read(current.signal).catch((cause: unknown) => {
        if (!active || current.signal.aborted || request !== current || cause instanceof BrowserSessionChanged) return;
        setAuthentication(previous => previous.phase === "ended" ? previous : {
          phase: "error", generation: previous.generation,
          message: cause instanceof Error ? cause.message : "Session verification failed.",
        });
      });
    };
    const unsubscribe = client.subscribe(event => {
      if (!active) return;
      if (event.type === "ready") {
        if (client.responseCurrent(event.session)) setAuthentication(previous => ({
          phase: "ready", session: event.session, generation: previous.generation + 1,
        }));
      } else if (event.type === "validation_required") {
        setAuthentication(previous => ({ phase: "validating", generation: previous.generation }));
        validate();
      } else if (event.type === "transition") {
        setAuthentication(previous => ({ phase: "validating", generation: previous.generation }));
      } else if (event.type === "transition_failed") {
        setAuthentication(previous => ({ phase: "error", message: event.message, generation: previous.generation }));
      } else if (event.type === "ended") {
        setAuthentication(previous => ({ phase: "ended", generation: previous.generation }));
        window.location.assign(event.reason === "signed_out" ? "/" : `/?${new URLSearchParams({
          return_to: workspacePath(readWorkspaceRoute(window.location.pathname + window.location.search)),
        })}`);
      }
    });
    retry.current = () => {
      setAuthentication(previous => ({ phase: "validating", generation: previous.generation }));
      validate();
    };
    validate();
    return () => {
      active = false;
      unsubscribe();
      request?.abort();
      client.dispose();
      retry.current = () => {};
    };
  }, [client]);
  useEffect(() => {
    if (authentication.phase !== "ready") return;
    return listenForSessionActivity(authentication.session.activity_interval_ms, signal => client.activity(signal));
  }, [client, authentication]);

  if (authentication.phase === "ready") return <AuthenticatedWorkspace key={authentication.generation} client={client} />;
  if (authentication.phase === "initial" && initialBootstrap !== undefined) return <div inert aria-busy="true">
    <AuthenticatedWorkspace client={client} enabled={false} initialBootstrap={initialBootstrap} initialRoute={initialRoute} />
  </div>;
  return <main className="empty-state" aria-busy={authentication.phase === "initial" || authentication.phase === "validating"}>
    {authentication.phase === "error" ? <>
      <p role="alert">{authentication.message}</p>
      <button type="button" onClick={() => retry.current()}>Retry session verification</button>
    </> : <p role="status">{authentication.phase === "ended" ? "Your session ended. Sign in again." : "Verifying your session…"}</p>}
  </main>;
}

function AuthenticatedWorkspace({ client, enabled = true, initialBootstrap, initialRoute }: Props & {
  client: BrowserSessionClient; enabled?: boolean;
}) {
  const [api] = useState(() => new BridgeHttpClient({ session: client }));
  const [accountOpen, setAccountOpen] = useState(false);
  const shell = useRef<HTMLDivElement>(null);
  const model = useBridgeWorkspace({ api, enabled, initialBootstrap, initialRoute });
  const external = useExternalIdentities(client, enabled);
  const openAccount = () => { if (api.sessionCurrent()) setAccountOpen(true); };
  const fallbackFocus = () => {
    const candidates = shell.current?.querySelectorAll<HTMLButtonElement>('[data-browser-account-trigger], button[aria-label="Open navigation"]');
    for (const button of candidates ?? []) {
      const bounds = button.getBoundingClientRect();
      if (bounds.width && bounds.height && bounds.right > 0 && bounds.bottom > 0 && bounds.left < window.innerWidth && bounds.top < window.innerHeight && !button.closest('[inert], [aria-hidden="true"]')) {
        button.focus(); return;
      }
    }
  };
  return <div ref={shell} className="browser-workspace-shell">
    {enabled ? <ExternalIdentityBanner model={external} onReview={openAccount} /> : null}
    <div className="browser-workspace-content"><WorkspacePage model={model} onAccount={enabled ? openAccount : undefined} /></div>
    {accountOpen ? <BrowserAccountPanel client={client} external={external} fallbackFocus={fallbackFocus} onClose={() => setAccountOpen(false)} /> : null}
  </div>;
}
