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
import { CheckboxField, Field, Input } from "../components/ui/input";
import { api, errorMessage } from "../lib/api";
import { dateTime } from "../lib/format";
import { provisioningEndpoints, type ProvisioningEndpoints } from "../lib/provisioning-endpoints";
import { captureResource, type ResourceState } from "../lib/resource-state";
import type { OIDCProvider, SCIMToken, SCIMTokenIssue } from "../lib/types";

type ProvisioningView = "oidc" | "scim";

export function ProvisioningPage({ systemAdministrator }: { systemAdministrator: boolean }) {
  const [view, setView] = useState<ProvisioningView>(systemAdministrator ? "oidc" : "scim");
  const [providers, setProviders] = useState<ResourceState<OIDCProvider[]>>(
    systemAdministrator ? { status: "loading" } : { status: "ready", data: [] },
  );
  const [tokens, setTokens] = useState<ResourceState<SCIMToken[]>>({ status: "loading" });
  const [pending, setPending] = useState(false);
  const [providerDialog, setProviderDialog] = useState<OIDCProvider | null | undefined>();
  const [providerDialogError, setProviderDialogError] = useState("");
  const [providerActionError, setProviderActionError] = useState("");
  const [tokenDialog, setTokenDialog] = useState(false);
  const [tokenDialogError, setTokenDialogError] = useState("");
  const [revokeTarget, setRevokeTarget] = useState<SCIMToken>();
  const [revokeError, setRevokeError] = useState("");
  const [issued, setIssued] = useState<SCIMTokenIssue>();
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
	const [successMessage, setSuccessMessage] = useState("");
	const [copiedEndpoint, setCopiedEndpoint] = useState<ProvisioningView>();
	const [endpointCopyError, setEndpointCopyError] = useState("");
	const endpoints = provisioningEndpoints(window.location.href);

  const loadProviders = useCallback(async () => {
    if (!systemAdministrator) {
      setProviders({ status: "ready", data: [] });
      return;
    }
    setProviders({ status: "loading" });
    setProviders(await captureResource(async () => (await api.oidcProviders()).providers));
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
    setPending(true);
    setProviderDialogError("");
    setSuccessMessage("");
    try {
      await api.upsertOIDCProvider({
        name: providerName,
        issuer: String(input.get("issuer") ?? "").trim(),
        client_id: String(input.get("client_id") ?? "").trim(),
        client_secret: String(input.get("client_secret") ?? ""),
        scopes: parseScopes(String(input.get("scopes") ?? "")),
        enabled: input.get("enabled") === "on",
      });
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
      await api.setOIDCProviderEnabled(provider.name, !provider.enabled);
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
    const input = new FormData(event.currentTarget);
    const scopes: Array<"scim:read" | "scim:write"> = [];
    if (input.get("read") === "on") scopes.push("scim:read");
    if (input.get("write") === "on") scopes.push("scim:write");
    setPending(true);
    setTokenDialogError("");
    setSuccessMessage("");
    try {
      const result = await api.issueSCIMToken({
        name: String(input.get("name") ?? "").trim(),
        scopes,
      });
      setTokenDialog(false);
      setIssued(result);
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
      <TokenDialog open={tokenDialog} error={tokenDialogError} pending={pending} onClose={() => { setTokenDialog(false); setTokenDialogError(""); }} onSubmit={issueToken} />
      <RevokeDialog token={revokeTarget} error={revokeError} pending={pending} onClose={() => { setRevokeTarget(undefined); setRevokeError(""); }} onConfirm={revokeToken} />
      <CredentialDialog
			issued={issued}
			baseURL={endpoints.scimBaseURL}
			copied={copied}
			endpointCopied={copiedEndpoint === "scim"}
			error={copyError || endpointCopyError}
			onClose={() => { setIssued(undefined); setCopied(false); setCopyError(""); setEndpointCopyError(""); }}
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
				<span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-md bg-white text-primary shadow-sm ring-1 ring-border">
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
		<div className="flex min-w-0 items-center rounded-md border border-border bg-white pl-3 shadow-sm">
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

function ProviderSection({ state, actionError, pending, onRetry, onEdit, onToggle }: {
  state: ResourceState<OIDCProvider[]>;
  actionError: string;
  pending: boolean;
  onRetry: () => Promise<void>;
  onEdit: (provider: OIDCProvider) => void;
  onToggle: (provider: OIDCProvider) => void;
}) {
  if (state.status === "loading") return <Loading label="Loading login providers" />;
  if (state.status === "error") {
    return <ResourceFailureNotice failure={state.failure} retryLabel="Retry login providers" onRetry={() => void onRetry()} />;
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

function TokenSection({ state, pending, onRetry, onRevoke }: {
  state: ResourceState<SCIMToken[]>;
  pending: boolean;
  onRetry: () => Promise<void>;
  onRevoke: (token: SCIMToken) => void;
}) {
  if (state.status === "loading") return <Loading label="Loading SCIM credentials" />;
  if (state.status === "error") {
    return <ResourceFailureNotice failure={state.failure} retryLabel="Retry SCIM credentials" onRetry={() => void onRetry()} />;
  }
  return state.data.length === 0 ? (
    <Empty title="No SCIM credentials" detail="Issue a credential when an external directory is ready to provision people and groups." />
  ) : (
    <TokenTable tokens={state.data} pending={pending} onRevoke={onRevoke} />
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
            <Button size="sm" variant="secondary" onClick={() => onEdit(provider)}>
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
            <td className="px-3 py-3.5"><p className="font-medium">{provider.display_name}</p><p className="mt-0.5 font-mono text-xs text-muted-foreground">{provider.name}</p></td>
            <td className="max-w-[280px] truncate px-3 py-3 text-muted-foreground" title={provider.issuer}>{provider.issuer}</td>
            <td className="px-3 py-3 font-mono text-xs text-muted-foreground">{provider.client_id}</td>
            <td className="px-3 py-3 text-muted-foreground">{provider.scopes.join(", ")}</td>
            <td className="px-3 py-3"><Badge value={provider.enabled ? "active" : "inactive"} /></td>
            <td className="px-3 py-3"><div className="flex justify-end gap-1">
              <Button aria-label={`Edit ${provider.display_name}`} title="Edit provider" size="icon" variant="ghost" onClick={() => onEdit(provider)}><Pencil className="h-4 w-4" /></Button>
              <Button aria-label={`${provider.enabled ? "Disable" : "Enable"} ${provider.display_name}`} title={provider.enabled ? "Disable provider" : "Enable provider"} size="icon" variant="ghost" disabled={pending} onClick={() => void onToggle(provider)}><Power className="h-4 w-4" /></Button>
            </div></td>
          </tr>
        ))}</tbody>
      </table>
    </DataTable>
    </>
  );
}

function TokenTable({ tokens, pending, onRevoke }: {
  tokens: SCIMToken[];
  pending: boolean;
  onRevoke: (token: SCIMToken) => void;
}) {
  return (
    <>
    <MobileResourceList label="SCIM credentials">
      {tokens.map((token) => (
        <MobileResourceItem key={token.id}>
          <div className="flex min-w-0 items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate font-medium">{token.name}</p>
            </div>
            <Badge value={token.revoked_at ? "revoked" : "active"} />
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
          {!token.revoked_at ? (
            <div className="mt-4 flex justify-end border-t border-border pt-3">
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => onRevoke(token)}>
                <Power className="h-4 w-4" />
                Revoke
              </Button>
            </div>
          ) : null}
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
          <td className="px-3 py-3.5"><p className="font-medium">{token.name}</p></td>
          <td className="px-3 py-3 text-muted-foreground">{token.scopes.map((scope) => scope.replace("scim:", "")).join(", ")}</td>
          <td className="px-3 py-3 text-muted-foreground">{dateTime(token.created_at)}</td>
          <td className="px-3 py-3"><Badge value={token.revoked_at ? "revoked" : "active"} /></td>
          <td className="px-3 py-3 text-right">{!token.revoked_at ? (
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => onRevoke(token)}><Power className="h-4 w-4" />Revoke</Button>
          ) : null}</td>
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

function TokenDialog({ open, error, pending, onClose, onSubmit }: {
  open: boolean;
  error: string;
  pending: boolean;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <Dialog dismissible={!pending} open={open} onOpenChange={(next) => { if (!next) onClose(); }} title="Issue SCIM token" description="The credential is displayed once after issuance.">
      <form className="grid gap-5" onSubmit={onSubmit}>
        {error ? <ErrorNotice message={error} /> : null}
        <Field label="Credential name" hint="Use the external directory name, such as Workday or Okta."><Input name="name" required /></Field>
        <fieldset className="grid gap-2"><legend className="mb-1 text-sm font-medium">Permissions</legend>
          <CheckboxField defaultChecked hint="Users and groups" label="Read directory" name="read" />
          <CheckboxField defaultChecked hint="Create and update resources" label="Provision directory" name="write" />
        </fieldset>
        <div className="flex justify-end gap-2"><Button disabled={pending} type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button aria-busy={pending} disabled={pending} type="submit">{pending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}Issue credential</Button></div>
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

function CredentialDialog({ issued, baseURL, copied, endpointCopied, error, onClose, onCopy, onCopyEndpoint }: {
  issued: SCIMTokenIssue | undefined;
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
