import {
  ArrowLeft,
  BrainCircuit,
  Check,
  KeyRound,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Server,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  DataTable,
  ListPagination,
  MobileResourceItem,
  MobileResourceList,
  PageHeader,
  ResourceFailureNotice,
  ResourceFailurePage,
  ResourceToolbar,
  SearchField,
  Section,
} from "../components/page";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Dialog } from "../components/ui/dialog";
import { Empty, ErrorNotice, Loading, SuccessNotice } from "../components/ui/feedback";
import { CheckboxField, Field, Input, Select } from "../components/ui/input";
import { APIError, api, errorMessage } from "../lib/api";
import { loadImmutableCatalogDetail } from "../lib/catalog-detail";
import { positiveInteger } from "../lib/forms";
import { dateTime } from "../lib/format";
import {
  initialModelSelection,
  matchModelSelection,
  modelCatalogGate,
  modelProfileLabel,
  resolveModelSelection,
} from "../lib/model-catalog";
import { mergePage } from "../lib/pagination";
import { resourceFailure, type ResourceFailure } from "../lib/resource-failure";
import { captureResource, type ResourceState } from "../lib/resource-state";
import type {
  ModelCatalog,
  ModelProfile,
  ModelSpec,
} from "../lib/types";

type ModelEditorValue = {
  displayName: string;
  apiKey: string;
  model: ModelSpec;
};

export function ModelsPage({ modelID, revisionID }: { modelID?: string; revisionID?: string }) {
  return modelID ? <ModelDetail modelID={modelID} revisionID={revisionID} /> : <ModelList />;
}

function ModelList() {
  const [items, setItems] = useState<ModelProfile[]>();
  const [catalogState, setCatalogState] = useState<ResourceState<ModelCatalog>>({ status: "loading" });
  const [loadFailure, setLoadFailure] = useState<ResourceFailure>();
  const [nextAfterID, setNextAfterID] = useState<string>();
  const [pageFailure, setPageFailure] = useState<ResourceFailure>();
  const [pagePending, setPagePending] = useState(false);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [successMessage, setSuccessMessage] = useState("");
  const [query, setQuery] = useState("");
  const loadProfiles = useCallback(async () => {
    setLoadFailure(undefined);
    setPageFailure(undefined);
    try {
      const profiles = await api.models();
      setItems(profiles.items);
      setNextAfterID(profiles.next_after_id ?? undefined);
    } catch (cause) {
      setLoadFailure(resourceFailure(cause));
    }
  }, []);
  const loadCatalog = useCallback(async () => {
    setCatalogState({ status: "loading" });
    setCatalogState(await captureResource(api.modelCatalog));
  }, []);
  useEffect(() => {
    void loadProfiles();
    void loadCatalog();
  }, [loadCatalog, loadProfiles]);

  async function loadMore() {
    if (!nextAfterID || pagePending || pageFailure?.retryable === false) return;
    setPagePending(true);
    setPageFailure(undefined);
    try {
      const page = await api.models({ afterID: nextAfterID });
      setItems((current) => mergePage(current ?? [], page.items, (item) => item.model_profile_id));
      setNextAfterID(page.next_after_id ?? undefined);
    } catch (cause) {
      setPageFailure(resourceFailure(cause));
    } finally {
      setPagePending(false);
    }
  }

  async function submit(value: ModelEditorValue) {
    setPending(true);
    setSuccessMessage("");
    try {
      await api.createModel({
        display_name: value.displayName,
        api_key: value.apiKey,
        model: value.model,
      });
      setOpen(false);
      setSuccessMessage(`${value.displayName} connected.`);
      await loadProfiles();
    } catch (cause) {
      throw cause;
    } finally {
      setPending(false);
    }
  }

  if (!items) {
    if (!loadFailure) return <Loading label="Loading model providers" />;
    return (
      <ResourceFailurePage
        eyebrow="Configuration"
        failure={loadFailure}
        resource="Model provider inventory"
        returnHref="#overview"
        returnLabel="Back to Overview"
        onRetry={() => void loadProfiles()}
      />
    );
  }
  const catalog = catalogState.status === "ready" ? catalogState.data : undefined;
  const catalogGate = modelCatalogGate(catalogState.status);
  const normalized = query.trim().toLowerCase();
  const filtered = (items ?? []).filter((profile) =>
    [profile.display_name, profile.model.model, profile.model.base_url, modelProfileLabel(catalog, profile)]
      .some((value) => value.toLowerCase().includes(normalized)),
  );
  return (
    <div className="grid gap-5">
      <PageHeader
        eyebrow="Configuration"
        title="Model providers"
        detail="Provider credentials and immutable model revisions used by Agent templates."
        actions={<Button disabled={!catalogGate.changeAllowed} title={catalogGate.message} onClick={() => { setSuccessMessage(""); setOpen(true); }}><Plus className="h-4 w-4" />Add provider</Button>}
      />
      {successMessage ? <SuccessNotice message={successMessage} onDismiss={() => setSuccessMessage("")} /> : null}
      {loadFailure ? <ResourceFailureNotice failure={loadFailure} retryLabel="Retry model providers" onRetry={() => void loadProfiles()} /> : null}
      {catalogState.status === "error" ? <ResourceFailureNotice failure={catalogState.failure} message={`Model catalog could not be loaded: ${catalogState.failure.message}`} retryLabel="Retry model catalog" onRetry={() => void loadCatalog()} /> : null}
      {items.length === 0 ? (
        <Empty
          title="No model providers"
          detail="Connect a model provider before creating an Agent template."
          action={<Button size="sm" disabled={!catalogGate.changeAllowed} title={catalogGate.message} onClick={() => { setSuccessMessage(""); setOpen(true); }}><Plus className="h-4 w-4" />Add provider</Button>}
        />
      ) : (
        <>
          <ResourceToolbar>
            <SearchField value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search providers, models, or endpoints" />
            <p className="text-sm text-muted-foreground">
              {filtered.length} matching · {items.length} loaded{nextAfterID ? " · More available" : ""}
            </p>
          </ResourceToolbar>
          {filtered.length === 0 ? <Empty title="No matching models" detail="Try a different provider, model, or endpoint." /> : <>
          <MobileResourceList label="Model providers">
            {filtered.map((profile) => (
              <MobileResourceItem key={profile.revision_id}>
                <div className="flex min-w-0 items-start gap-3">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-violet-50 text-violet-700">
                    <BrainCircuit className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <a className="block truncate font-medium hover:text-primary" href={`#models/${profile.model_profile_id}`}>
                      {modelProfileLabel(catalog, profile)}
                    </a>
                    <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">{profile.model.model}</p>
                  </div>
                  <Badge value={profile.enabled ? "enabled" : "disabled"} />
                </div>
                <p className="mt-3 break-all text-xs leading-5 text-muted-foreground">{profile.model.base_url}</p>
                <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-border pt-3 text-sm">
                  <div>
                    <dt className="text-xs text-muted-foreground">Context window</dt>
                    <dd className="mt-1">{profile.model.context_window.toLocaleString()}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Maximum output</dt>
                    <dd className="mt-1">{profile.model.max_output_tokens.toLocaleString()}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Revision</dt>
                    <dd className="mt-1">{profile.revision}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Image input</dt>
                    <dd className="mt-1">{profile.model.supports_images ? "Supported" : "Not supported"}</dd>
                  </div>
                  <div className="col-span-2">
                    <dt className="text-xs text-muted-foreground">Updated</dt>
                    <dd className="mt-1 text-xs text-muted-foreground">{dateTime(profile.updated_at)}</dd>
                  </div>
                </dl>
              </MobileResourceItem>
            ))}
          </MobileResourceList>
          <DataTable className="hidden md:block">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="border-b border-border bg-muted/60 text-xs text-muted-foreground"><tr><th className="px-3 py-2 font-medium">Provider</th><th className="px-3 py-2 font-medium">Model</th><th className="px-3 py-2 font-medium">Context</th><th className="px-3 py-2 font-medium">Output</th><th className="px-3 py-2 font-medium">Revision</th><th className="px-3 py-2 font-medium">Status</th><th className="px-3 py-2 font-medium">Updated</th></tr></thead>
            <tbody className="divide-y divide-border">
              {filtered.map((profile) => (
                <tr className="transition-colors hover:bg-muted/35" key={profile.revision_id}>
                  <td className="px-3 py-3.5"><div className="flex items-center gap-3"><span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-violet-50 text-violet-700"><BrainCircuit className="h-4 w-4" /></span><div><a className="font-medium hover:underline" href={`#models/${profile.model_profile_id}`}>{modelProfileLabel(catalog, profile)}</a><p className="mt-0.5 max-w-52 truncate text-xs text-muted-foreground">{profile.model.base_url}</p></div></div></td>
                  <td className="px-3 py-3 font-mono text-xs">{profile.model.model}</td>
                  <td className="px-3 py-3">{profile.model.context_window.toLocaleString()}</td>
                  <td className="px-3 py-3">{profile.model.max_output_tokens.toLocaleString()}</td>
                  <td className="px-3 py-3">{profile.revision}</td>
                  <td className="px-3 py-3"><Badge value={profile.enabled ? "enabled" : "disabled"} /></td>
                  <td className="px-3 py-3 text-muted-foreground">{dateTime(profile.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </DataTable>
        </>}
          <ListPagination
            failure={pageFailure}
            hasMore={Boolean(nextAfterID)}
            loaded={items.length}
            pending={pagePending}
            onLoadMore={() => void loadMore()}
          />
        </>
      )}
      {catalog ? (
        <Dialog dismissible={!pending} open={open} onOpenChange={setOpen} title="Connect model provider" description="Choose a supported model or connect a custom OpenAI-compatible API.">
          <ModelEditor catalog={catalog} pending={pending} submitLabel="Connect provider" onCancel={() => setOpen(false)} onSubmit={submit} />
        </Dialog>
      ) : null}
    </div>
  );
}

function ModelDetail({ modelID, revisionID }: { modelID: string; revisionID?: string }) {
  const [profile, setProfile] = useState<ModelProfile>();
  const profileRequest = useRef(0);
  const [catalogState, setCatalogState] = useState<ResourceState<ModelCatalog>>({ status: "loading" });
  const [loadFailure, setLoadFailure] = useState<ResourceFailure>();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [successMessage, setSuccessMessage] = useState("");

  const loadProfile = useCallback(async () => {
    const request = profileRequest.current + 1;
    profileRequest.current = request;
    setLoadFailure(undefined);
    setProfile(undefined);
    try {
      const detail = await loadImmutableCatalogDetail({
        revision: revisionID,
        readCurrent: () => api.model(modelID),
        readRevision: api.modelRevision,
        assertOwner: (candidate) => {
          if (candidate.model_profile_id !== modelID) {
            throw new APIError(404, "reference_not_found", "The model revision does not belong to this profile.");
          }
        },
      });
      if (profileRequest.current === request) setProfile(detail.resource);
    } catch (cause) {
      if (profileRequest.current === request) setLoadFailure(resourceFailure(cause));
    }
  }, [modelID, revisionID]);
  const loadCatalog = useCallback(async () => {
    setCatalogState({ status: "loading" });
    setCatalogState(await captureResource(api.modelCatalog));
  }, []);
  useEffect(() => void loadProfile(), [loadProfile]);
  useEffect(() => void loadCatalog(), [loadCatalog]);

  async function revise(value: ModelEditorValue) {
    if (!profile || revisionID !== undefined) return;
    setPending(true);
    setSuccessMessage("");
    try {
      const revised = await api.reviseModel(profile.model_profile_id, {
        display_name: value.displayName,
        api_key: value.apiKey,
        model: value.model,
      });
      setProfile(revised);
      setOpen(false);
      setSuccessMessage(`Model revision ${revised.revision} published.`);
    } catch (cause) {
      throw cause;
    } finally {
      setPending(false);
    }
  }

  if (!profile) {
    if (!loadFailure) return <Loading label="Loading model provider" />;
    return (
      <ResourceFailurePage
        eyebrow="Configuration"
        failure={loadFailure}
        resource="Model provider"
        returnHref="#models"
        returnLabel="Back to model providers"
        onRetry={() => void loadProfile()}
      />
    );
  }

  const catalog = catalogState.status === "ready" ? catalogState.data : undefined;
  const catalogGate = modelCatalogGate(catalogState.status);
  const historical = revisionID !== undefined;
  const facts = [
    ["Provider", modelProfileLabel(catalog, profile)],
    ["Model", profile.model.model],
    ["Context window", profile.model.context_window.toLocaleString()],
    ["Maximum output", profile.model.max_output_tokens.toLocaleString()],
    ["Image input", profile.model.supports_images ? "Supported" : "Not supported"],
    [historical ? "Viewed revision" : "Current revision", String(profile.revision)],
    ["Profile updated", dateTime(profile.updated_at)],
  ];
  return (
    <div className="grid gap-6">
      <Button asChild className="w-fit" size="sm" variant="ghost"><a href="#models"><ArrowLeft className="h-4 w-4" />Back to model providers</a></Button>
      <PageHeader
        eyebrow={modelProfileLabel(catalog, profile)}
        title={profile.model.model}
        detail={historical
          ? "Read-only immutable model configuration retained for executable lineage."
          : "Current immutable model configuration used by Agent templates."}
        actions={historical
          ? <><Badge value="historical" /><Button asChild variant="secondary"><a href={`#models/${modelID}`}>View current revision</a></Button></>
          : <><Badge value={profile.enabled ? "enabled" : "disabled"} /><Button disabled={!catalogGate.changeAllowed} title={catalogGate.message} onClick={() => { setSuccessMessage(""); setOpen(true); }}><Pencil className="h-4 w-4" />Create revision</Button></>}
      />
      {successMessage ? <SuccessNotice message={successMessage} onDismiss={() => setSuccessMessage("")} /> : null}
      {catalogState.status === "error" ? <ResourceFailureNotice failure={catalogState.failure} message={`Model catalog could not be loaded: ${catalogState.failure.message}`} retryLabel="Retry model catalog" onRetry={() => void loadCatalog()} /> : null}
      <Section title="Model configuration" detail="Provider credentials are write-only and never returned to the browser.">
        <div className="grid gap-px overflow-hidden rounded-md border border-border bg-border shadow-sm sm:grid-cols-2 lg:grid-cols-3">
          {facts.map(([label, value]) => <div className="bg-white p-4" key={label}><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 break-words text-sm font-medium">{value}</p></div>)}
        </div>
      </Section>
      <Section title="Endpoint">
        <div className="flex items-center gap-3 rounded-md border border-border bg-white p-4 font-mono text-sm shadow-sm break-all"><Server className="h-4 w-4 shrink-0 text-muted-foreground" />{profile.model.base_url}</div>
      </Section>
      {!historical && catalog ? (
        <Dialog dismissible={!pending} open={open} onOpenChange={setOpen} title="Create model revision" description="Publish a new model configuration and replacement credential. Existing Agent revisions do not change.">
          <ModelEditor key={profile.revision} catalog={catalog} initialModel={profile.model} pending={pending} submitLabel="Publish revision" onCancel={() => setOpen(false)} onSubmit={revise} />
        </Dialog>
      ) : null}
    </div>
  );
}

function ModelEditor({
  catalog,
  initialModel,
  pending,
  submitLabel,
  onCancel,
  onSubmit,
}: {
  catalog: ModelCatalog;
  initialModel?: ModelSpec;
  pending: boolean;
  submitLabel: string;
  onCancel: () => void;
  onSubmit: (value: ModelEditorValue) => Promise<void>;
}) {
  const selection = useMemo(
    () => initialModel ? matchModelSelection(catalog, initialModel) : initialModelSelection(catalog),
    [catalog, initialModel],
  );
  const [providerKey, setProviderKey] = useState(selection.providerKey);
  const [modelID, setModelID] = useState(selection.modelID);
  const [baseURL, setBaseURL] = useState(initialModel?.base_url ?? "");
  const [contextWindow, setContextWindow] = useState(String(initialModel?.context_window ?? 128_000));
  const [maxOutputTokens, setMaxOutputTokens] = useState(String(initialModel?.max_output_tokens ?? 8_192));
  const [supportsImages, setSupportsImages] = useState(initialModel?.supports_images ?? false);
  const [formError, setFormError] = useState("");
  const provider = catalog.providers.find((candidate) => candidate.provider_key === providerKey);
  const selectedModel = provider?.models.find((candidate) => candidate.model_id === modelID);

  function changeProvider(nextKey: string) {
    const nextProvider = catalog.providers.find((candidate) => candidate.provider_key === nextKey);
    setProviderKey(nextKey);
    setModelID(nextProvider?.models[0]?.model_id ?? "");
    if (nextProvider?.custom) {
      setBaseURL("");
      setContextWindow("128000");
      setMaxOutputTokens("8192");
      setSupportsImages(false);
    }
    setFormError("");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      const resolved = resolveModelSelection(catalog, {
        providerKey,
        modelID,
        baseURL,
        contextWindow: positiveInteger(contextWindow, 0),
        maxOutputTokens: positiveInteger(maxOutputTokens, 0),
        supportsImages,
      });
      const apiKey = String(data.get("api_key") ?? "").trim();
      if (!apiKey) throw new Error("Enter the provider API key.");
      setFormError("");
      await onSubmit({ ...resolved, apiKey });
    } catch (cause) {
      setFormError(errorMessage(cause));
    }
  }

  return (
    <form className="grid gap-5" onSubmit={submit}>
      {formError ? <ErrorNotice message={formError} /> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Provider">
          <Select value={providerKey} onChange={(event) => changeProvider(event.target.value)}>
            {catalog.providers.map((candidate) => <option key={candidate.provider_key} value={candidate.provider_key}>{candidate.display_name}</option>)}
          </Select>
        </Field>
        {provider?.custom ? (
          <Field label="Model ID"><Input value={modelID} onChange={(event) => setModelID(event.target.value)} placeholder="company-model" required /></Field>
        ) : (
          <Field label="Model">
            <Select value={modelID} onChange={(event) => setModelID(event.target.value)}>
              {provider?.models.map((model) => <option key={model.model_id} value={model.model_id}>{model.display_name}</option>)}
            </Select>
          </Field>
        )}
      </div>

      {provider?.custom ? (
        <>
          <Field label="API endpoint"><Input value={baseURL} onChange={(event) => setBaseURL(event.target.value)} type="url" placeholder="https://models.example.com/v1" required /></Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Context window"><Input value={contextWindow} onChange={(event) => setContextWindow(event.target.value)} type="number" min="1024" required /></Field>
            <Field label="Maximum output"><Input value={maxOutputTokens} onChange={(event) => setMaxOutputTokens(event.target.value)} type="number" min="1" required /></Field>
          </div>
          <CheckboxField
            checked={supportsImages}
            hint="The custom model accepts images."
            label="Image input"
            onChange={(event) => setSupportsImages(event.target.checked)}
          />
        </>
      ) : selectedModel ? (
        <div className="grid gap-px overflow-hidden rounded-md border border-border bg-border sm:grid-cols-3">
          <ModelFact label="Context window" value={selectedModel.context_window.toLocaleString()} />
          <ModelFact label="Maximum output" value={selectedModel.max_output_tokens.toLocaleString()} />
          <ModelFact label="Image input" value={selectedModel.supports_images ? "Supported" : "Not supported"} />
        </div>
      ) : null}

      <Field label={initialModel ? "Replacement API key" : "API key"} hint="Stored by the control plane and never returned to the browser."><Input name="api_key" type="password" autoComplete="off" required /></Field>
      <div className="flex justify-end gap-2"><Button disabled={pending} type="button" variant="secondary" onClick={onCancel}>Cancel</Button><Button aria-busy={pending} disabled={pending} type="submit">{pending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}{submitLabel}</Button></div>
    </form>
  );
}

function ModelFact({ label, value }: { label: string; value: string }) {
  return <div className="bg-white p-3"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 flex items-center gap-1.5 text-sm font-medium"><Check className="h-3.5 w-3.5 text-emerald-600" />{value}</p></div>;
}
