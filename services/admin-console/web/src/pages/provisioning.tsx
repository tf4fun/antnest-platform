import {
  Check,
  Clipboard,
  KeyRound,
	Link2,
  LoaderCircle,
  Pencil,
  Plus,
  Power,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  DataTable,
  MobileResourceItem,
  MobileResourceList,
  PageHeader,
  ResourceFailureNotice,
  ResourceToolbar,
} from "../components/page";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Dialog } from "../components/ui/dialog";
import { Empty, ErrorNotice, Loading, SuccessNotice } from "../components/ui/feedback";
import { CheckboxField, Field, Input, Select, Textarea } from "../components/ui/input";
import { IdentityProviderSelect } from "../components/identity-provider-select";
import { api, errorMessage } from "../lib/api";
import { dateTime } from "../lib/format";
import { provisioningEndpoints, type ProvisioningEndpoints } from "../lib/provisioning-endpoints";
import { captureResource, type ResourceState } from "../lib/resource-state";
import type { OIDCLinkPolicy, OIDCProvider, SCIMToken, SCIMTokenIssue } from "../lib/types";

type ProvisioningView = "oidc" | "scim";

export function ProvisioningPage({ systemAdministrator }: { systemAdministrator: boolean }) {
  const [view, setView] = useState<ProvisioningView>(systemAdministrator ? "oidc" : "scim");
  const [providers, setProviders] = useState<ResourceState<OIDCProvider[]>>(
    systemAdministrator ? { status: "loading" } : { status: "ready", data: [] },
  );
  const [tokens, setTokens] = useState<ResourceState<SCIMToken[]>>({ status: "loading" });
  const [knownProviders, setKnownProviders] = useState<OIDCProvider[]>([]);
  const [pending, setPending] = useState(false);
  const [providerDialog, setProviderDialog] = useState<OIDCProvider | null | undefined>();
  const [providerDialogError, setProviderDialogError] = useState("");
  const [providerActionError, setProviderActionError] = useState("");
  const [tokenDialog, setTokenDialog] = useState(false);
  const [rotationTarget, setRotationTarget] = useState<SCIMToken>();
  const [tokenDialogError, setTokenDialogError] = useState("");
  const [revokeTarget, setRevokeTarget] = useState<SCIMToken>();
  const [revokeError, setRevokeError] = useState("");
  const [issued, setIssued] = useState<SCIMTokenIssue>();
  const [issuedRotation, setIssuedRotation] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
	const [successMessage, setSuccessMessage] = useState("");
	const [copiedEndpoint, setCopiedEndpoint] = useState<ProvisioningView>();
	const [endpointCopyError, setEndpointCopyError] = useState("");
	const endpoints = provisioningEndpoints(window.location.href);

  const loadProviders = useCallback(async () => {
    if (!systemAdministrator) {
      setProviders({ status: "ready", data: [] });
      setKnownProviders([]);
      return;
    }
    setProviders({ status: "loading" });
    const result = await captureResource(async () => (await api.oidcProviders()).providers);
    if (result.status === "ready") setKnownProviders(result.data);
    setProviders(result);
  }, [systemAdministrator]);

  const loadTokens = useCallback(async () => {
    setTokens({ status: "loading" });
    setTokens(await captureResource(async () => (await api.scimTokens()).tokens));
  }, []);

  useEffect(() => {
    void loadProviders();
    void loadTokens();
  }, [loadProviders, loadTokens]);

  async function saveProvider(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const input = new FormData(form);
    const providerName = String(input.get("name") ?? "").trim();
    const editing = providerDialog !== null && providerDialog !== undefined;
    const policy = String(input.get("link_policy") ?? "none") as OIDCLinkPolicy;
    setPending(true);
    setProviderDialogError("");
    setSuccessMessage("");
    try {
      const result = await api.upsertOIDCProvider({
        name: providerName,
        issuer: String(input.get("issuer") ?? "").trim(),
        client_id: String(input.get("client_id") ?? "").trim(),
        client_secret: String(input.get("client_secret") ?? ""),
        scopes: parseScopes(String(input.get("scopes") ?? "")),
        enabled: input.get("enabled") === "on",
        link_policy: policy,
        link_domains: policy === "verified_email_in_domains" ? String(input.get("link_domains") ?? "").split(/[,\r\n]+/).filter(domain => domain.trim() !== "") : [],
        authoritative: input.get("authoritative") === "on",
        ...(providerDialog?.link_policy_review_required ? { acknowledge_link_policy_review: input.get("acknowledge_link_policy_review") === "on" } : {}),
      });
      setKnownProviders(previous => [...previous.filter(row => row.name !== result.provider.name), result.provider]);
      setProviderDialog(undefined);
      setSuccessMessage(`${providerDialog?.display_name ?? providerName} ${editing ? "updated" : "added"}.`);
      await loadProviders();
    } catch (cause) {
      setProviderDialogError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  async function toggleProvider(provider: OIDCProvider) {
    setPending(true);
    setProviderActionError("");
    setSuccessMessage("");
    try {
      const result = await api.setOIDCProviderEnabled(provider.name, !provider.enabled);
      setKnownProviders(previous => [...previous.filter(row => row.name !== result.provider.name), result.provider]);
      setSuccessMessage(`${provider.display_name} ${provider.enabled ? "disabled" : "enabled"}.`);
      await loadProviders();
    } catch (cause) {
      setProviderActionError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  async function issueToken(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const input = new FormData(event.currentTarget);
    const expiresInDays = Number(input.get("expires_in_days"));
    if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 365) {
      setTokenDialogError("Choose a lifetime from 1 to 365 whole days.");
      return;
    }
    const providerID = rotationTarget ? rotationTarget.oidc_provider_id : String(input.get("oidc_provider_id") ?? "");
    const scopes: Array<"scim:read" | "scim:write"> = [];
    if (input.get("read") === "on") scopes.push("scim:read");
    if (input.get("write") === "on") scopes.push("scim:write");
    setPending(true);
    setTokenDialogError("");
    setSuccessMessage("");
    try {
      const result = await api.issueSCIMToken({
        name: rotationTarget ? rotationTarget.name : String(input.get("name") ?? "").trim(),
        scopes: rotationTarget ? [...rotationTarget.scopes] : scopes,
        expires_in_days: expiresInDays,
        ...(providerID ? { oidc_provider_id: providerID } : {}),
      });
      setTokenDialog(false);
      setIssued(result);
      setIssuedRotation(Boolean(rotationTarget));
      setRotationTarget(undefined);
      setCopied(false);
      setCopyError("");
      await loadTokens();
    } catch (cause) {
      setTokenDialogError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  async function revokeToken() {
    if (!revokeTarget) return;
    const target = revokeTarget;
    setPending(true);
    setRevokeError("");
    setSuccessMessage("");
    try {
      await api.revokeSCIMToken(target.id);
      setRevokeTarget(undefined);
      setSuccessMessage(`${target.name} revoked.`);
      await loadTokens();
    } catch (cause) {
      setRevokeError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  async function copyCredential() {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.credential);
      setCopied(true);
      setCopyError("");
    } catch (cause) {
      setCopyError(errorMessage(cause));
    }
  }

	async function copyEndpoint(target: ProvisioningView) {
		const value = target === "oidc" ? endpoints.oidcCallbackURL : endpoints.scimBaseURL;
		try {
			await navigator.clipboard.writeText(value);
			setCopiedEndpoint(target);
			setEndpointCopyError("");
		} catch (cause) {
			setEndpointCopyError(errorMessage(cause));
		}
	}

  const currentReady = view === "oidc" ? providers.status === "ready" : tokens.status === "ready";

  return (
    <div className="grid gap-5">
      <PageTitle />
      {successMessage ? <SuccessNotice message={successMessage} onDismiss={() => setSuccessMessage("")} /> : null}
      <ResourceToolbar>
        <div className="flex items-center gap-1 rounded-md border border-border bg-white p-1" role="tablist" aria-label="Provisioning view">
          {systemAdministrator ? (
            <Button role="tab" aria-selected={view === "oidc"} size="sm" variant={view === "oidc" ? "secondary" : "ghost"} onClick={() => { setSuccessMessage(""); setView("oidc"); }}>Login providers</Button>
          ) : null}
          <Button role="tab" aria-selected={view === "scim"} size="sm" variant={view === "scim" ? "secondary" : "ghost"} onClick={() => { setSuccessMessage(""); setView("scim"); }}>Directory sync</Button>
        </div>
        <Button
          disabled={!currentReady || pending}
          onClick={() => {
            setSuccessMessage("");
            if (view === "oidc") {
              setProviderDialogError("");
              setProviderDialog(null);
            } else {
              setTokenDialogError("");
              setRotationTarget(undefined);
              setTokenDialog(true);
            }
          }}
        >
          <Plus className="h-4 w-4" />
          {view === "oidc" ? "Add login provider" : "Issue SCIM token"}
        </Button>
      </ResourceToolbar>
		<ConnectionDetails
			view={view}
			endpoints={endpoints}
			copied={copiedEndpoint === view}
			error={endpointCopyError}
			onCopy={() => void copyEndpoint(view)}
		/>

      {view === "oidc" ? (
        <ProviderSection
          state={providers}
          knownProviders={knownProviders}
          actionError={providerActionError}
          pending={pending}
          onRetry={loadProviders}
          onEdit={(provider) => {
            setProviderDialogError("");
            setSuccessMessage("");
            setProviderDialog(provider);
          }}
          onToggle={toggleProvider}
        />
      ) : (
        <TokenSection
          state={tokens}
          pending={pending}
          onRetry={loadTokens}
          onRotate={(token) => {
            setRotationTarget(token);
            setTokenDialogError("");
            setSuccessMessage("");
            setTokenDialog(true);
          }}
          onRevoke={(token) => {
            setRevokeError("");
            setSuccessMessage("");
            setRevokeTarget(token);
          }}
        />
      )}

      <ProviderDialog
			provider={providerDialog}
			error={providerDialogError}
			copyError={endpointCopyError}
			callbackURL={endpoints.oidcCallbackURL}
			copied={copiedEndpoint === "oidc"}
			pending={pending}
			onClose={() => { setProviderDialog(undefined); setProviderDialogError(""); setEndpointCopyError(""); }}
			onCopy={() => void copyEndpoint("oidc")}
			onSubmit={saveProvider}
		/>
      <TokenDialog open={tokenDialog} rotationTarget={rotationTarget} error={tokenDialogError} pending={pending} onClose={() => { setTokenDialog(false); setRotationTarget(undefined); setTokenDialogError(""); }} onSubmit={issueToken} />
      <RevokeDialog token={revokeTarget} error={revokeError} pending={pending} onClose={() => { setRevokeTarget(undefined); setRevokeError(""); }} onConfirm={revokeToken} />
      <CredentialDialog
			issued={issued}
      rotation={issuedRotation}
			baseURL={endpoints.scimBaseURL}
			copied={copied}
			endpointCopied={copiedEndpoint === "scim"}
			error={copyError || endpointCopyError}
			onClose={() => { setIssued(undefined); setIssuedRotation(false); setCopied(false); setCopyError(""); setEndpointCopyError(""); }}
			onCopy={copyCredential}
			onCopyEndpoint={() => void copyEndpoint("scim")}
		/>
    </div>
  );
}

function PageTitle() {
  return <PageHeader eyebrow="Organization" title="Provisioning" detail="Connect workforce login and directory synchronization without exposing provider secrets." />;
}

function ConnectionDetails({ view, endpoints, copied, error, onCopy }: {
	view: ProvisioningView;
	endpoints: ProvisioningEndpoints;
	copied: boolean;
	error: string;
	onCopy: () => void;
}) {
	const oidc = view === "oidc";
	const value = oidc ? endpoints.oidcCallbackURL : endpoints.scimBaseURL;
	return (
		<section className="grid gap-3 border-y border-border bg-muted/20 px-1 py-4 sm:grid-cols-[minmax(0,1fr)_minmax(280px,0.9fr)] sm:items-center sm:gap-6">
			<div className="flex items-start gap-3">
				<span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-md bg-white text-primary shadow-xs ring-1 ring-border">
					<Link2 className="h-4 w-4" aria-hidden="true" />
				</span>
				<div>
					<h2 className="text-sm font-medium">{oidc ? "OIDC callback URL" : "SCIM base URL"}</h2>
					<p className="mt-1 text-xs leading-5 text-muted-foreground">
						{oidc
							? "Register this exact redirect URL with the identity provider."
							: "Configure the external directory to use this protocol endpoint."}
					</p>
				</div>
			</div>
			<div className="min-w-0">
				<EndpointValue value={value} copied={copied} onCopy={onCopy} />
				{error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
			</div>
		</section>
	);
}

function EndpointValue({ value, copied, onCopy }: { value: string; copied: boolean; onCopy: () => void }) {
	return (
		<div className="flex min-w-0 items-center rounded-md border border-border bg-white pl-3 shadow-xs">
			<code className="min-w-0 flex-1 break-all py-2 text-xs">{value}</code>
			<Button
				aria-label={copied ? "Address copied" : "Copy address"}
				className="ml-2 shrink-0"
				size="icon"
				title={copied ? "Address copied" : "Copy address"}
				type="button"
				variant="ghost"
				onClick={onCopy}
			>
				{copied ? <Check className="h-4 w-4" /> : <Clipboard className="h-4 w-4" />}
			</Button>
		</div>
	);
}

function ProviderSection({ state, knownProviders, actionError, pending, onRetry, onEdit, onToggle }: {
  state: ResourceState<OIDCProvider[]>;
  knownProviders: OIDCProvider[];
  actionError: string;
  pending: boolean;
  onRetry: () => Promise<void>;
  onEdit: (provider: OIDCProvider) => void;
  onToggle: (provider: OIDCProvider) => void;
}) {
  if (state.status !== "ready") {
    return <div className="grid gap-3">
      {knownProviders.filter(provider => provider.link_policy_review_required).map(provider => <div key={provider.name} role="status" className="rounded-md border border-border p-4 text-sm">
        <p className="font-medium">{provider.display_name}</p><p className="text-destructive">Policy review required</p>
        <p className="text-xs text-muted-foreground">Last confirmed provider status. Refresh the inventory to review this policy.</p>
      </div>)}
      {state.status === "loading" ? <Loading label="Loading login providers" /> : <ResourceFailureNotice failure={state.failure} retryLabel="Retry login providers" onRetry={() => void onRetry()} />}
    </div>;
  }
  return (
    <div className="grid gap-3">
      {actionError ? <ErrorNotice message={actionError} /> : null}
      {state.data.length === 0 ? (
        <Empty title="No login providers" detail="Add the organization's OIDC identity provider to offer federated login." />
      ) : (
        <ProviderTable providers={state.data} pending={pending} onEdit={onEdit} onToggle={onToggle} />
      )}
    </div>
  );
}

function TokenSection({ state, pending, onRetry, onRevoke, onRotate }: {
  state: ResourceState<SCIMToken[]>;
  pending: boolean;
  onRetry: () => Promise<void>;
  onRevoke: (token: SCIMToken) => void;
  onRotate: (token: SCIMToken) => void;
}) {
  if (state.status === "loading") return <Loading label="Loading SCIM credentials" />;
  if (state.status === "error") {
    return <ResourceFailureNotice failure={state.failure} retryLabel="Retry SCIM credentials" onRetry={() => void onRetry()} />;
  }
  return state.data.length === 0 ? (
    <Empty title="No SCIM credentials" detail="Issue a credential when an external directory is ready to provision people and groups." />
  ) : (
    <TokenTable tokens={state.data} pending={pending} onRevoke={onRevoke} onRotate={onRotate} />
  );
}

function ProviderTable({ providers, pending, onEdit, onToggle }: {
  providers: OIDCProvider[];
  pending: boolean;
  onEdit: (provider: OIDCProvider) => void;
  onToggle: (provider: OIDCProvider) => void;
}) {
  return (
    <>
    <MobileResourceList label="OIDC login providers">
      {providers.map((provider) => (
        <MobileResourceItem key={provider.name}>
          <div className="flex min-w-0 items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate font-medium">{provider.display_name}</p>
              <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">{provider.name}</p>
            </div>
            <Badge value={provider.enabled ? "active" : "inactive"} />
          </div>
          <ProviderPolicySummary provider={provider} />
          <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-border pt-3 text-sm">
            <div className="col-span-2 min-w-0">
              <dt className="text-xs text-muted-foreground">Issuer</dt>
              <dd className="mt-1 break-all text-xs leading-5">{provider.issuer}</dd>
            </div>
            <div className="col-span-2 min-w-0">
              <dt className="text-xs text-muted-foreground">Client ID</dt>
              <dd className="mt-1 break-all font-mono text-xs">{provider.client_id}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Scopes</dt>
              <dd className="mt-1 text-xs">{provider.scopes.join(", ")}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Revision</dt>
              <dd className="mt-1">{provider.revision}</dd>
            </div>
            <div className="col-span-2">
              <dt className="text-xs text-muted-foreground">Updated</dt>
              <dd className="mt-1 text-xs text-muted-foreground">{dateTime(provider.updated_at)}</dd>
            </div>
          </dl>
          <div className="mt-4 flex justify-end gap-2 border-t border-border pt-3">
            <Button disabled={pending} size="sm" variant="secondary" onClick={() => onEdit(provider)}>
              <Pencil className="h-4 w-4" />
              Edit
            </Button>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => void onToggle(provider)}>
              <Power className="h-4 w-4" />
              {provider.enabled ? "Disable" : "Enable"}
            </Button>
          </div>
        </MobileResourceItem>
      ))}
    </MobileResourceList>
    <DataTable className="hidden md:block">
      <table className="w-full min-w-[880px] text-left text-sm">
        <thead className="border-b border-border bg-muted/60 text-xs text-muted-foreground"><tr>
          <th className="px-3 py-2 font-medium">Provider</th><th className="px-3 py-2 font-medium">Issuer</th>
          <th className="px-3 py-2 font-medium">Client</th><th className="px-3 py-2 font-medium">Scopes</th>
          <th className="px-3 py-2 font-medium">Status</th><th className="px-3 py-2 text-right font-medium">Actions</th>
        </tr></thead>
        <tbody className="divide-y divide-border">{providers.map((provider) => (
          <tr className="hover:bg-muted/35" key={provider.name}>
            <td className="px-3 py-3.5"><p className="font-medium">{provider.display_name}</p><p className="mt-0.5 font-mono text-xs text-muted-foreground">{provider.name}</p><ProviderPolicySummary provider={provider} /></td>
            <td className="max-w-[280px] truncate px-3 py-3 text-muted-foreground" title={provider.issuer}>{provider.issuer}</td>
            <td className="px-3 py-3 font-mono text-xs text-muted-foreground">{provider.client_id}</td>
            <td className="px-3 py-3 text-muted-foreground">{provider.scopes.join(", ")}</td>
            <td className="px-3 py-3"><Badge value={provider.enabled ? "active" : "inactive"} /></td>
            <td className="px-3 py-3"><div className="flex justify-end gap-1">
              <Button aria-label={`Edit ${provider.display_name}`} title="Edit provider" disabled={pending} size="icon" variant="ghost" onClick={() => onEdit(provider)}><Pencil className="h-4 w-4" /></Button>
              <Button aria-label={`${provider.enabled ? "Disable" : "Enable"} ${provider.display_name}`} title={provider.enabled ? "Disable provider" : "Enable provider"} size="icon" variant="ghost" disabled={pending} onClick={() => void onToggle(provider)}><Power className="h-4 w-4" /></Button>
            </div></td>
          </tr>
        ))}</tbody>
      </table>
    </DataTable>
    </>
  );
}

const scimExpiryWarning = 14 * 24 * 60 * 60 * 1000;

function tokenStatus(token: SCIMToken, now: number) {
  if (token.revoked_at) return "revoked";
  const remaining = Date.parse(token.expires_at) - now;
  if (!Number.isFinite(remaining)) return "unknown";
  if (remaining <= 0) return "expired";
  return remaining <= scimExpiryWarning ? "expiring soon" : "active";
}

function TokenLifecycle({ token }: { token: SCIMToken }) {
  return <div className="mt-2 space-y-1 text-xs text-muted-foreground">
    <p>Expires {dateTime(token.expires_at)}</p>
    <p className="break-all">{token.issued_by ? `Issued by ${token.issued_by}` : "Issuer unknown"}</p>
    {token.issuer_review_required ? <p className="font-medium text-destructive">Issuer review required</p> : null}
  </div>;
}

function TokenTable({ tokens, pending, onRevoke, onRotate }: {
  tokens: SCIMToken[];
  pending: boolean;
  onRevoke: (token: SCIMToken) => void;
  onRotate: (token: SCIMToken) => void;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const update = () => {
      clearTimeout(timer);
      const current = Date.now();
      setNow(current);
      const transitions = tokens.filter(token => !token.revoked_at).flatMap(token => {
        const expires = Date.parse(token.expires_at);
        return [expires - scimExpiryWarning, expires];
      }).filter(time => time > current);
      // Wake at the next state boundary; cap long sleeps for browser timer limits.
      timer = setTimeout(update, Math.min(24 * 60 * 60 * 1000, ...transitions.map(time => time - current)));
    };
    update();
    window.addEventListener("focus", update);
    return () => { clearTimeout(timer); window.removeEventListener("focus", update); };
  }, [tokens]);
  const actions = (token: SCIMToken) => <>
    <Button size="sm" variant="ghost" disabled={pending} onClick={() => onRotate(token)}><RefreshCw className="h-4 w-4" />Rotate</Button>
    {!token.revoked_at ? <Button size="sm" variant="ghost" disabled={pending} onClick={() => onRevoke(token)}><Power className="h-4 w-4" />Revoke</Button> : null}
  </>;
  return (
    <>
    <MobileResourceList label="SCIM credentials">
      {tokens.map((token) => (
        <MobileResourceItem key={token.id}>
          <div className="flex min-w-0 items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate font-medium">{token.name}</p>
              <TokenPairing token={token} />
              <TokenLifecycle token={token} />
            </div>
            <Badge value={tokenStatus(token, now)} />
          </div>
          <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-border pt-3 text-sm">
            <div>
              <dt className="text-xs text-muted-foreground">Scopes</dt>
              <dd className="mt-1 capitalize">{token.scopes.map((scope) => scope.replace("scim:", "")).join(", ")}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Issued</dt>
              <dd className="mt-1 text-xs text-muted-foreground">{dateTime(token.created_at)}</dd>
            </div>
          </dl>
          <div className="mt-4 flex justify-end gap-2 border-t border-border pt-3">{actions(token)}</div>
        </MobileResourceItem>
      ))}
    </MobileResourceList>
    <DataTable className="hidden md:block"><table className="w-full min-w-[700px] text-left text-sm">
      <thead className="border-b border-border bg-muted/60 text-xs text-muted-foreground"><tr>
        <th className="px-3 py-2 font-medium">Credential</th><th className="px-3 py-2 font-medium">Scopes</th>
        <th className="px-3 py-2 font-medium">Issued</th><th className="px-3 py-2 font-medium">Status</th><th className="px-3 py-2 text-right font-medium">Actions</th>
      </tr></thead>
      <tbody className="divide-y divide-border">{tokens.map((token) => (
        <tr className="hover:bg-muted/35" key={token.id}>
          <td className="px-3 py-3.5"><p className="font-medium">{token.name}</p><TokenPairing token={token} /><TokenLifecycle token={token} /></td>
          <td className="px-3 py-3 text-muted-foreground">{token.scopes.map((scope) => scope.replace("scim:", "")).join(", ")}</td>
          <td className="px-3 py-3 text-muted-foreground">{dateTime(token.created_at)}</td>
          <td className="px-3 py-3"><Badge value={tokenStatus(token, now)} /></td>
          <td className="px-3 py-3 text-right"><div className="flex justify-end gap-2">{actions(token)}</div></td>
        </tr>
      ))}</tbody>
    </table></DataTable>
    </>
  );
}

function ProviderDialog({ provider, error, copyError, callbackURL, copied, pending, onClose, onCopy, onSubmit }: {
  provider: OIDCProvider | null | undefined;
  error: string;
	copyError: string;
	callbackURL: string;
	copied: boolean;
  pending: boolean;
  onClose: () => void;
	onCopy: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const editing = provider !== null && provider !== undefined;
  return (
    <Dialog dismissible={!pending} open={provider !== undefined} onOpenChange={(open) => { if (!open) onClose(); }} title={editing ? "Edit login provider" : "Add login provider"} description="Antnest validates the provider's discovery document before saving the configuration.">
      <form className="grid gap-5" onSubmit={onSubmit}>
        {error ? <ErrorNotice message={error} /> : null}
		<div>
			<p className="mb-2 text-sm font-medium">Redirect URL</p>
			<EndpointValue value={callbackURL} copied={copied} onCopy={onCopy} />
			{copyError ? <p className="mt-2 text-xs text-destructive">{copyError}</p> : null}
		</div>
        <Field label="Provider key" hint={editing ? "Provider identity cannot be renamed." : "A stable key such as workforce or authentik."}><Input name="name" defaultValue={provider?.name} readOnly={editing} required /></Field>
        <Field label="Issuer URL" hint={editing ? "Create a new provider key to change issuer." : "Exact issuer URL from the provider discovery document."}><Input name="issuer" type="url" defaultValue={provider?.issuer} readOnly={editing} required /></Field>
        <Field label="Client ID"><Input name="client_id" defaultValue={provider?.client_id} required /></Field>
        <Field label="Client secret" hint={editing ? "Leave blank to keep the current secret." : "Stored encrypted and never shown again."}><Input name="client_secret" type="password" autoComplete="new-password" required={!editing} /></Field>
        <Field label="Scopes" hint="Comma or space separated. openid and email are added automatically."><Input name="scopes" defaultValue={provider?.scopes.join(" ") ?? "openid email profile"} /></Field>
        <ProviderPolicyFields key={provider?.name ?? "new"} provider={provider} disabled={pending} />
        <CheckboxField
          containerClassName="bg-muted/35"
          defaultChecked={provider?.enabled ?? true}
          hint="Users can choose this provider on the login screen."
          label="Allow sign-in"
          name="enabled"
        />
        <div className="flex justify-end gap-2"><Button disabled={pending} type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button aria-busy={pending} disabled={pending} type="submit">{pending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}{editing ? "Save provider" : "Add provider"}</Button></div>
      </form>
    </Dialog>
  );
}

function TokenDialog({ open, rotationTarget, error, pending, onClose, onSubmit }: {
  open: boolean;
  rotationTarget: SCIMToken | undefined;
  error: string;
  pending: boolean;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <Dialog dismissible={!pending} open={open} onOpenChange={(next) => { if (!next) onClose(); }} title={rotationTarget ? "Rotate SCIM token" : "Issue SCIM token"} description={rotationTarget ? "Create an independent credential with the same configuration. The original remains unchanged." : "The credential is displayed once after issuance."}>
      <form className="grid gap-5" onSubmit={onSubmit}>
        {error ? <ErrorNotice message={error} /> : null}
        {rotationTarget ? <div className="rounded-md border border-border p-4 text-sm">
          <p className="font-medium">{rotationTarget.name}</p>
          <p className="mt-1">Permissions: {rotationTarget.scopes.map(scope => scope.replace("scim:", "")).join(", ")}</p>
          <TokenPairing token={rotationTarget} />
        </div> : <>
        <Field label="Credential name" hint="Use the external directory name, such as Workday or Okta."><Input name="name" required /></Field>
        <IdentityProviderSelect name="oidc_provider_id" optional disabled={pending} />
        <fieldset className="grid gap-2"><legend className="mb-1 text-sm font-medium">Permissions</legend>
          <CheckboxField defaultChecked hint="Users and groups" label="Read directory" name="read" />
          <CheckboxField defaultChecked hint="Create and update resources" label="Provision directory" name="write" />
        </fieldset>
        </>}
        <Field label="Lifetime (days)" hint="Choose 1–365 days. Using a credential does not extend its lifetime."><Input name="expires_in_days" type="number" min={1} max={365} step={1} required defaultValue={90} disabled={pending} /></Field>
        <div className="flex justify-end gap-2"><Button disabled={pending} type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button aria-busy={pending} disabled={pending} type="submit">{pending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}{rotationTarget ? "Issue replacement" : "Issue credential"}</Button></div>
      </form>
    </Dialog>
  );
}

function RevokeDialog({ token, error, pending, onClose, onConfirm }: {
  token: SCIMToken | undefined;
  error: string;
  pending: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog dismissible={!pending} open={Boolean(token)} onOpenChange={(open) => { if (!open) onClose(); }} title="Revoke SCIM token" description={`External directory access using ${token?.name ?? "this credential"} stops immediately.`}>
      <div className="grid gap-5">
        {error ? <ErrorNotice message={error} /> : null}
        <div className="flex justify-end gap-2"><Button disabled={pending} variant="secondary" onClick={onClose}>Cancel</Button><Button aria-busy={pending} variant="destructive" disabled={pending} onClick={onConfirm}>{pending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}Revoke</Button></div>
      </div>
    </Dialog>
  );
}

function CredentialDialog({ issued, rotation, baseURL, copied, endpointCopied, error, onClose, onCopy, onCopyEndpoint }: {
  issued: SCIMTokenIssue | undefined;
  rotation: boolean;
	baseURL: string;
  copied: boolean;
	endpointCopied: boolean;
  error: string;
  onClose: () => void;
  onCopy: () => void;
	onCopyEndpoint: () => void;
}) {
  return (
    <Dialog open={Boolean(issued)} onOpenChange={(open) => { if (!open) onClose(); }} title="SCIM credential issued" description="Copy this credential now. Antnest stores only its hash and cannot show it again.">
      <div className="grid gap-5">
		<div><p className="mb-2 text-sm font-medium">SCIM base URL</p><EndpointValue value={baseURL} copied={endpointCopied} onCopy={onCopyEndpoint} /></div>
        {issued ? <TokenPairing token={issued.token} /> : null}
        {issued ? <TokenLifecycle token={issued.token} /> : null}
        {rotation ? <p className="text-sm text-muted-foreground">The original credential remains unchanged. Install and test this new credential in your directory, then explicitly revoke the original.</p> : null}
        <div className="rounded-md border border-[#cfd8ad] bg-[#f3f9d9] p-4"><div className="flex items-center gap-2 text-sm font-medium text-[#536700]"><ShieldCheck className="h-4 w-4" />One-time secret</div><code className="mt-3 block break-all rounded-md bg-white p-3 text-xs text-foreground">{issued?.credential}</code></div>
        {error ? <ErrorNotice message={error} /> : null}
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Done</Button><Button onClick={() => void onCopy()}>{copied ? <Check className="h-4 w-4" /> : <Clipboard className="h-4 w-4" />}{copied ? "Copied" : "Copy credential"}</Button></div>
      </div>
    </Dialog>
  );
}

function parseScopes(value: string): string[] {
  return [...new Set(value.split(/[\s,]+/).map((scope) => scope.trim()).filter(Boolean))];
}

const policyLabels: Record<OIDCLinkPolicy, string> = {
  none: "Explicit binding only",
  verified_email_in_domains: "Verified email in allowed domains",
  verified_email: "Any verified email",
};

function ProviderPolicySummary({ provider }: { provider: OIDCProvider }) {
  return <div className="mt-2 space-y-1 text-xs text-muted-foreground">
    <p>{policyLabels[provider.link_policy]}</p>
    {provider.link_domains.length ? <p className="break-all">{provider.link_domains.join(", ")}</p> : null}
    <p>{provider.authoritative ? "Trusted for organization administrators" : "No automatic administrator linking"}</p>
    {provider.link_policy_review_required ? <p className="font-medium text-destructive">Policy review required</p> : null}
  </div>;
}

function ProviderPolicyFields({ provider, disabled }: { provider: OIDCProvider | null | undefined; disabled: boolean }) {
  const [policy, setPolicy] = useState<OIDCLinkPolicy>(provider?.link_policy ?? "none");
  return <fieldset className="grid gap-3 rounded-md border border-border p-4" disabled={disabled}>
    <legend className="px-1 text-sm font-medium">External login linking</legend>
    <p className="text-xs text-muted-foreground">Automatic linking trusts the provider's verified email claim to find an existing membership. System administrator accounts cannot sign in through OIDC.</p>
    {provider?.link_policy_review_required ? <p className="text-sm text-destructive">Policy review required</p> : null}
    <Field label="Automatic linking policy">
      <Select name="link_policy" value={policy} onChange={event => setPolicy(event.target.value as OIDCLinkPolicy)}>
        {Object.entries(policyLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </Select>
    </Field>
    {policy === "verified_email_in_domains" ? <Field label="Allowed email domains" hint="Exact ASCII domains, separated by commas or lines. Wildcards and URLs are not accepted.">
      <Textarea name="link_domains" defaultValue={provider?.link_domains.join(", ")} required />
    </Field> : null}
    <CheckboxField name="authoritative" label="Trust provider for organization administrators" defaultChecked={provider?.authoritative ?? false}
      hint="Only enable for a provider trusted to assert administrators' verified email. Other providers never automatically link administrator memberships." />
    {provider?.link_policy_review_required ? <CheckboxField name="acknowledge_link_policy_review" label="I have reviewed this linking policy" hint="Saving or rotating a secret without this explicit confirmation keeps the review warning." /> : null}
  </fieldset>;
}

function TokenPairing({ token }: { token: SCIMToken }) {
  return <p className="mt-1 text-xs text-muted-foreground">{token.oidc_provider_id === null ? "Directory only · no login binding" : <>Paired login provider: <code className="break-all">{token.oidc_provider_id}</code></>}</p>;
}
