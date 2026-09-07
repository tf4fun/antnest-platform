import { ArrowLeft, Boxes, LoaderCircle, Pencil, Plus, RefreshCw, Sparkles } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
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
import { Empty, ErrorNotice, GuidanceNotice, Loading, SuccessNotice } from "../components/ui/feedback";
import { Field, Input, Select, Textarea } from "../components/ui/input";
import { APIError, api, errorMessage } from "../lib/api";
import { loadImmutableCatalogDetail } from "../lib/catalog-detail";
import { useModelOptions } from "../lib/catalog-options";
import { positiveInteger } from "../lib/forms";
import { bytes, dateTime } from "../lib/format";
import { mergePage } from "../lib/pagination";
import { resourceFailure, type ResourceFailure } from "../lib/resource-failure";
import { captureResource, type ResourceState } from "../lib/resource-state";
import { runtimeImageLabel } from "../lib/runtime-image";
import { RuntimeImageChoice } from "../components/runtime-image-choice";
import { templateCreationGate } from "../lib/setup";
import type { AgentTemplate, ModelProfile, TemplateDefaults } from "../lib/types";

export function TemplatesPage({ templateID, revisionID }: { templateID?: string; revisionID?: string }) {
  return templateID ? <TemplateDetail templateID={templateID} revisionID={revisionID} /> : <TemplateList />;
}

function TemplateList() {
  const [items, setItems] = useState<AgentTemplate[]>();
  const {
    items: models,
    available: modelsAvailable,
    hasMore: modelsHaveMore,
    pending: modelsPending,
    failure: modelFailure,
    loadInitial: loadModels,
    loadMore: loadMoreModels,
    retry: retryModels,
  } = useModelOptions();
  const [defaults, setDefaults] = useState<ResourceState<TemplateDefaults>>({ status: "loading" });
  const [loadFailure, setLoadFailure] = useState<ResourceFailure>();
  const [nextAfterID, setNextAfterID] = useState<string>();
  const [pageFailure, setPageFailure] = useState<ResourceFailure>();
  const [pagePending, setPagePending] = useState(false);
  const [formError, setFormError] = useState("");
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [successMessage, setSuccessMessage] = useState("");
  const [query, setQuery] = useState("");
  const loadTemplates = useCallback(async () => {
    setLoadFailure(undefined);
    setPageFailure(undefined);
    try {
      const page = await api.templates();
      setItems(page.items);
      setNextAfterID(page.next_after_id ?? undefined);
    } catch (cause) {
      setLoadFailure(resourceFailure(cause));
    }
  }, []);
  const loadDefaults = useCallback(async () => {
    setDefaults({ status: "loading" });
    setDefaults(await captureResource(api.templateDefaults));
  }, []);
  useEffect(() => {
    void loadTemplates();
    void loadModels();
    void loadDefaults();
  }, [loadDefaults, loadModels, loadTemplates]);

  async function loadMore() {
    if (!nextAfterID || pagePending || pageFailure?.retryable === false) return;
    setPagePending(true);
    setPageFailure(undefined);
    try {
      const page = await api.templates({ afterID: nextAfterID });
      setItems((current) => mergePage(current ?? [], page.items, (item) => item.template_id));
      setNextAfterID(page.next_after_id ?? undefined);
    } catch (cause) {
      setPageFailure(resourceFailure(cause));
    } finally {
      setPagePending(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const name = String(data.get("name") ?? "").trim();
    if (defaults.status !== "ready") {
      setFormError("Runtime defaults are unavailable. Retry before creating a template.");
      return;
    }
    const customImage = data.get("image_mode") === "custom";
    const imageRef = customImage ? String(data.get("image_ref") ?? "").trim() : defaults.data.runtime_image_ref;
    if (!imageRef) {
      setFormError("Enter a repository:tag image.");
      return;
    }
    setPending(true);
    setFormError("");
    setSuccessMessage("");
    try {
      await api.createTemplate({
        name,
        model_profile_revision_id: String(
          data.get("model_profile_revision_id") ?? "",
        ),
        system_prompt: String(data.get("system_prompt") ?? ""),
        max_model_requests: positiveInteger(data.get("max_model_requests"), 32),
        runtime: customImage ? { image_ref: imageRef } : undefined,
      });
      form.reset();
      setOpen(false);
      setSuccessMessage(`${name} created.`);
      await loadTemplates();
    } catch (cause) {
      setFormError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  if (!items) {
    if (!loadFailure) return <Loading label="Loading templates" />;
    return (
      <ResourceFailurePage
        eyebrow="Configuration"
        failure={loadFailure}
        resource="Agent template inventory"
        returnHref="#overview"
        returnLabel="Back to Overview"
        onRetry={() => void loadTemplates()}
      />
    );
  }
  const defaultsAvailable = defaults.status === "ready"
    ? true
    : defaults.status === "error"
    ? false
    : undefined;
  const creationGate = templateCreationGate({
    modelsAvailable,
    modelsRetryable: modelFailure?.retryable,
    modelCount: models.length,
    modelsHaveMore,
    defaultsAvailable,
    defaultsRetryable: defaults.status === "error" ? defaults.failure.retryable : undefined,
  });
  const modelsByRevisionID = new Map(models.map((model) => [model.revision_id, model]));
  const normalized = query.trim().toLowerCase();
  const filtered = (items ?? []).filter((template) => {
    const model = modelsByRevisionID.get(template.model_profile_revision_id);
    return [template.name, model?.display_name ?? ""]
      .some((value) => value.toLowerCase().includes(normalized));
  });
  return (
    <div className="grid gap-5">
      <PageHeader
        eyebrow="Configuration"
        title="Agent templates"
        detail="Versioned model and runtime definitions used to build executable Agents."
        actions={
          <Button
            disabled={!creationGate.allowed}
            title={creationGate.message}
            onClick={() => { setFormError(""); setSuccessMessage(""); setOpen(true); }}
          >
            <Plus className="h-4 w-4" />
            Create template
          </Button>
        }
      />
      {successMessage ? <SuccessNotice message={successMessage} onDismiss={() => setSuccessMessage("")} /> : null}
      {loadFailure ? <ResourceFailureNotice failure={loadFailure} retryLabel="Retry templates" onRetry={() => void loadTemplates()} /> : null}
      {modelFailure ? <ResourceFailureNotice failure={modelFailure} message={`Model choices could not be loaded: ${modelFailure.message}`} retryLabel="Retry model choices" onRetry={retryModels} /> : null}
      {defaults.status === "error" ? <ResourceFailureNotice failure={defaults.failure} message={`Runtime defaults could not be loaded: ${defaults.failure.message}`} retryLabel="Retry Runtime defaults" onRetry={() => void loadDefaults()} /> : null}
      {!creationGate.allowed && items.length > 0 ? (
        <GuidanceNotice
          message={creationGate.message ?? "Complete the required configuration first."}
          action={creationGate.href
            ? <Button asChild size="sm" variant="secondary"><a href={creationGate.href}>{creationGate.action}</a></Button>
            : undefined}
        />
      ) : null}
      {items.length === 0 ? (
        <Empty
          title="No templates"
          detail={creationGate.message ?? "Create a template to define a model and runtime."}
          action={creationGate.allowed
            ? <Button size="sm" onClick={() => { setFormError(""); setSuccessMessage(""); setOpen(true); }}><Plus className="h-4 w-4" />Create template</Button>
            : creationGate.href
            ? <Button asChild size="sm" variant="secondary"><a href={creationGate.href}>{creationGate.action}</a></Button>
            : null}
        />
      ) : (
        <>
          <ResourceToolbar>
            <SearchField value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search templates or models" />
            <p className="text-sm text-muted-foreground">
              {filtered.length} matching · {items.length} loaded{nextAfterID ? " · More available" : ""}
            </p>
          </ResourceToolbar>
          {filtered.length === 0 ? <Empty title="No matching templates" detail="Try a different template or model name." /> : <>
          <MobileResourceList label="Agent templates">
            {filtered.map((template) => {
              const model = modelsByRevisionID.get(template.model_profile_revision_id);
              return (
                <MobileResourceItem key={`${template.template_id}:${template.revision}`}>
                  <div className="flex min-w-0 items-start gap-3">
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-amber-50 text-amber-700">
                      <Boxes className="h-4 w-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <a className="block truncate font-medium hover:text-primary" href={`#templates/${template.template_id}`}>
                        {template.name}
                      </a>
                    </div>
                    <Badge value={template.enabled ? "enabled" : "disabled"} />
                  </div>
                  <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-border pt-3 text-sm">
                    <div className="col-span-2 min-w-0">
                      <dt className="text-xs text-muted-foreground">Model profile</dt>
                      <dd className="mt-1 truncate font-mono text-xs">{model?.display_name ?? template.model_profile_revision_id}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Revision</dt>
                      <dd className="mt-1">{template.revision}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Memory</dt>
                      <dd className="mt-1">{bytes(template.runtime.resources.memory_bytes)}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Model requests</dt>
                      <dd className="mt-1">{template.max_model_requests}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Context policy</dt>
                      <dd className="mt-1 truncate font-mono text-xs">{template.context_policy_version}</dd>
                    </div>
                    <div className="col-span-2">
                      <dt className="text-xs text-muted-foreground">Updated</dt>
                      <dd className="mt-1 text-xs text-muted-foreground">{dateTime(template.updated_at)}</dd>
                    </div>
                  </dl>
                </MobileResourceItem>
              );
            })}
          </MobileResourceList>
          <DataTable className="hidden md:block">
          <table className="w-full min-w-[780px] text-left text-sm">
            <thead className="border-b border-border bg-muted/60 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Template</th>
                <th className="px-3 py-2 font-medium">Model profile</th>
                <th className="px-3 py-2 font-medium">Revision</th>
                <th className="px-3 py-2 font-medium">Memory</th>
                <th className="px-3 py-2 font-medium">Requests</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.map((template) => (
                <tr className="transition-colors hover:bg-muted/35" key={`${template.template_id}:${template.revision}`}>
                  <td className="px-3 py-3.5">
                    <div className="flex items-center gap-3">
                      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-amber-50 text-amber-700"><Boxes className="h-4 w-4" /></span>
                      <a className="block font-medium hover:underline" href={`#templates/${template.template_id}`}>{template.name}</a>
                    </div>
                  </td>
                  <td className="px-3 py-3 font-mono text-xs text-muted-foreground">
                    {modelsByRevisionID.get(template.model_profile_revision_id)?.display_name ?? template.model_profile_revision_id}
                  </td>
                  <td className="px-3 py-3">{template.revision}</td>
                  <td className="px-3 py-3">
                    {bytes(template.runtime.resources.memory_bytes)}
                  </td>
                  <td className="px-3 py-3">{template.max_model_requests}</td>
                  <td className="px-3 py-3">
                    <Badge value={template.enabled ? "enabled" : "disabled"} />
                  </td>
                  <td className="px-3 py-3 text-muted-foreground">
                    {dateTime(template.updated_at)}
                  </td>
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
      <Dialog
        dismissible={!pending}
        open={open}
        onOpenChange={setOpen}
        title="Create template"
        description="Define the model and runtime used by new Agents."
      >
        <form className="grid gap-5" onSubmit={submit}>
          {formError ? <ErrorNotice message={formError} /> : null}
          <Field label="Template name">
            <Input name="name" placeholder="General assistant" required />
          </Field>
          <Field label="Model">
            <Select name="model_profile_revision_id" required defaultValue="">
              <option value="" disabled>
                Select a model
              </option>
              {models.map((model) => (
                <option value={model.revision_id} key={model.revision_id}>
                  {model.display_name} · {model.model.model}
                </option>
              ))}
            </Select>
          </Field>
          <ListPagination
            failure={modelFailure}
            hasMore={modelsHaveMore}
            loaded={models.length}
            pending={modelsPending}
            onLoadMore={() => void (modelFailure ? retryModels() : loadMoreModels())}
          />
          <Field label="System prompt" hint="Defines the Agent's default role and operating boundaries.">
            <Textarea
              name="system_prompt"
              placeholder="You are a reliable enterprise assistant."
            />
          </Field>
          <Field label="Maximum model requests">
            <Input
              name="max_model_requests"
              type="number"
              min="1"
              max="128"
              defaultValue="32"
              required
            />
          </Field>
          {defaults.status === "ready" ? (
            <RuntimeImageChoice image={defaults.data.runtime_image_ref} inheritedLabel="Platform default" />
          ) : null}
          <div className="mt-1 flex justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              disabled={pending}
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button aria-busy={pending} disabled={pending} type="submit">
              {pending ? (
                <LoaderCircle className="h-4 w-4 animate-spin" />
              ) : <Sparkles className="h-4 w-4" />}
              Create template
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}

function TemplateDetail({ templateID, revisionID }: { templateID: string; revisionID?: string }) {
  const [template, setTemplate] = useState<AgentTemplate>();
  const templateRequest = useRef(0);
  const referencedModelRequest = useRef(0);
  const [referencedModelState, setReferencedModelState] = useState<ResourceState<ModelProfile>>({ status: "loading" });
  const {
    items: models,
    hasMore: modelsHaveMore,
    pending: modelsPending,
    failure: modelFailure,
    loadInitial: loadModels,
    loadMore: loadMoreModels,
    retry: retryModels,
  } = useModelOptions();
  const [loadFailure, setLoadFailure] = useState<ResourceFailure>();
  const [formError, setFormError] = useState("");
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [successMessage, setSuccessMessage] = useState("");

  const load = useCallback(async () => {
    const request = templateRequest.current + 1;
    templateRequest.current = request;
    referencedModelRequest.current += 1;
    setLoadFailure(undefined);
    setTemplate(undefined);
    setReferencedModelState({ status: "loading" });
    try {
      const detail = await loadImmutableCatalogDetail({
        revision: revisionID === undefined ? undefined : Number(revisionID),
        readCurrent: () => api.template(templateID),
        readRevision: (revision) => api.templateRevision(templateID, revision),
        assertOwner: (candidate) => {
          if (candidate.template_id !== templateID) {
            throw new APIError(404, "reference_not_found", "The template revision does not belong to this template.");
          }
        },
      });
      if (templateRequest.current === request) setTemplate(detail.resource);
    } catch (cause) {
      if (templateRequest.current === request) setLoadFailure(resourceFailure(cause));
    }
  }, [templateID, revisionID]);

  const loadReferencedModel = useCallback(async (modelRevisionID: string) => {
    const request = referencedModelRequest.current + 1;
    referencedModelRequest.current = request;
    setReferencedModelState({ status: "loading" });
    const state = await captureResource(() => api.modelRevision(modelRevisionID));
    if (referencedModelRequest.current === request) setReferencedModelState(state);
  }, []);

  useEffect(() => {
    void load();
    if (revisionID === undefined) void loadModels();
  }, [load, loadModels, revisionID]);
  useEffect(() => {
    if (template) void loadReferencedModel(template.model_profile_revision_id);
  }, [loadReferencedModel, template]);

  async function revise(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!template || revisionID !== undefined) return;
    const data = new FormData(event.currentTarget);
    const imageRef = data.get("image_mode") === "custom"
      ? String(data.get("image_ref") ?? "").trim() : template.runtime.image_ref;
    if (!imageRef) {
      setFormError("Enter a repository:tag image.");
      return;
    }
    setPending(true);
    setFormError("");
    setSuccessMessage("");
    try {
      const revised = await api.reviseTemplate(template.template_id, {
        name: String(data.get("name") ?? "").trim(),
        model_profile_revision_id: String(data.get("model_profile_revision_id") ?? ""),
        system_prompt: String(data.get("system_prompt") ?? ""),
        max_model_requests: positiveInteger(data.get("max_model_requests"), template.max_model_requests),
        runtime: {
          image_ref: imageRef,
          resources: template.runtime.resources,
        },
      });
      const selectedModel = models.find(
        (model) => model.revision_id === revised.model_profile_revision_id,
      );
      setTemplate(revised);
      if (selectedModel) setReferencedModelState({ status: "ready", data: selectedModel });
      setOpen(false);
      setSuccessMessage(`Template revision ${revised.revision} published.`);
    } catch (cause) {
      setFormError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  if (!template) {
    if (!loadFailure) return <Loading label="Loading Agent template" />;
    return (
      <ResourceFailurePage
        eyebrow="Configuration"
        failure={loadFailure}
        resource="Agent template"
        returnHref="#templates"
        returnLabel="Back to Agent templates"
        onRetry={() => void load()}
      />
    );
  }
  const historical = revisionID !== undefined;
  const referencedModel = referencedModelState.status === "ready" ? referencedModelState.data : undefined;
  const hasHistoricalModel = !models.some((model) => model.revision_id === template.model_profile_revision_id);
  const facts: Array<[string, ReactNode]> = [
    ["Model", referencedModel ? (
      <a
        className="font-medium hover:text-primary hover:underline"
        href={`#models/${referencedModel.model_profile_id}/revisions/${referencedModel.revision_id}`}
      >
        {referencedModel.display_name} · {referencedModel.model.model} · revision {referencedModel.revision}
      </a>
    ) : referencedModelState.status === "loading" ? "Loading model revision" : "Model revision unavailable"],
    [historical ? "Viewed revision" : "Current revision", String(template.revision)],
    ["Maximum requests", String(template.max_model_requests)],
    ["Runtime memory", bytes(template.runtime.resources.memory_bytes)],
    ["PID limit", template.runtime.resources.pids_limit.toLocaleString()],
    ["Template updated", dateTime(template.updated_at)],
  ];
  return (
    <div className="grid gap-6">
      <Button asChild className="w-fit" size="sm" variant="ghost"><a href="#templates"><ArrowLeft className="h-4 w-4" />Back to templates</a></Button>
      <PageHeader
        eyebrow="Agent template"
        title={template.name}
        detail={historical
          ? "Read-only immutable Template configuration retained for executable lineage."
          : "The current immutable Agent configuration head used for new builds and explicit rebuilds."}
        actions={historical
          ? <><Badge value="historical" /><Button asChild variant="secondary"><a href={`#templates/${templateID}`}>View current revision</a></Button></>
          : <><Badge value={template.enabled ? "enabled" : "disabled"} /><Button onClick={() => { setFormError(""); setSuccessMessage(""); setOpen(true); }}><Pencil className="h-4 w-4" />Create revision</Button></>}
      />
      {successMessage ? <SuccessNotice message={successMessage} onDismiss={() => setSuccessMessage("")} /> : null}
      {referencedModelState.status === "error" ? <ResourceFailureNotice failure={referencedModelState.failure} message={`Referenced model revision could not be loaded: ${referencedModelState.failure.message}`} retryLabel="Retry model revision" onRetry={() => void loadReferencedModel(template.model_profile_revision_id)} /> : null}
      {modelFailure ? <ResourceFailureNotice failure={modelFailure} message={`Model revision choices could not be loaded: ${modelFailure.message}`} retryLabel="Retry model choices" onRetry={retryModels} /> : null}
      <Section title="Configuration">
        <div className="grid gap-px overflow-hidden rounded-md border border-border bg-border shadow-sm sm:grid-cols-2 lg:grid-cols-3">
          {facts.map(([label, value]) => <div className="bg-white p-4" key={label}><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 break-words text-sm font-medium">{value}</p></div>)}
        </div>
      </Section>
      <Section title="System prompt">
        <pre className="whitespace-pre-wrap rounded-md border border-border bg-white p-4 font-sans text-sm leading-6 shadow-sm">{template.system_prompt || "No system prompt."}</pre>
      </Section>
      <Section title="Runtime image">
        <p className="break-all text-sm font-medium">{runtimeImageLabel(template.runtime.image_ref, template.runtime.image_source)}</p>
      </Section>
      {!historical ? <Dialog dismissible={!pending} open={open} onOpenChange={setOpen} title="Create template revision" description="Publish a new immutable configuration. Existing Agent revisions continue using their frozen settings.">
        <form className="grid gap-5" key={template.revision} onSubmit={revise}>
          {formError ? <ErrorNotice message={formError} /> : null}
          <Field label="Template name"><Input name="name" defaultValue={template.name} required /></Field>
          <Field label="Model">
            <Select name="model_profile_revision_id" defaultValue={template.model_profile_revision_id} required>
              {hasHistoricalModel ? <option value={template.model_profile_revision_id}>Current historical model revision</option> : null}
              {models.map((model) => <option value={model.revision_id} key={model.revision_id}>{model.display_name} · {model.model.model} · revision {model.revision}</option>)}
            </Select>
          </Field>
          <ListPagination
            failure={modelFailure}
            hasMore={modelsHaveMore}
            loaded={models.length}
            pending={modelsPending}
            onLoadMore={() => void (modelFailure ? retryModels() : loadMoreModels())}
          />
          <Field label="System prompt" hint="Defines the Agent's default role and operating boundaries."><Textarea name="system_prompt" defaultValue={template.system_prompt} /></Field>
          <Field label="Maximum model requests"><Input name="max_model_requests" type="number" min="1" max="128" defaultValue={template.max_model_requests} required /></Field>
          <RuntimeImageChoice image={template.runtime.image_ref} source={template.runtime.image_source} inheritedLabel="Keep current image" />
          <div className="flex justify-end gap-2"><Button disabled={pending} type="button" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button aria-busy={pending} disabled={pending} type="submit">{pending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}Publish revision</Button></div>
        </form>
      </Dialog> : null}
    </div>
  );
}
