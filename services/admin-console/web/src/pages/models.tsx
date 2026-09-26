import { ArrowLeft, Pencil, Server } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ModelRates } from "../components/model-pricing";
import { CatalogAvailabilityControl } from "../components/catalog-availability";
import { PageHeader, ResourceFailureNotice, ResourceFailurePage, Section } from "../components/page";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Dialog } from "../components/ui/dialog";
import { Loading, SuccessNotice } from "../components/ui/feedback";
import { APIError, api } from "../lib/api";
import { dateTime } from "../lib/format";
import { modelCatalogGate, modelProfileLabel, modelInputLabel } from "../lib/model-catalog";
import { resourceFailure, type ResourceFailure } from "../lib/resource-failure";
import { captureResource, type ResourceState } from "../lib/resource-state";
import type { ModelCatalog, ModelProfile, ProviderModelInput } from "../lib/types";
import { ProviderList } from "./providers";
import { ModelEditor } from "./model-editor";

export function ModelsPage({ modelID }: { modelID?: string }) {
  return modelID ? <ModelDetail key={modelID} modelID={modelID} /> : <ProviderList />;
}

function ModelDetail({ modelID }: { modelID: string }) {
  const [profile, setProfile] = useState<ModelProfile>();
  const profileRequest = useRef(0);
  const [catalogState, setCatalogState] = useState<ResourceState<ModelCatalog>>({ status: "loading" });
  const [loadFailure, setLoadFailure] = useState<ResourceFailure>();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [availabilityBusy, setAvailabilityBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [successMessage, setSuccessMessage] = useState("");

  const loadProfile = useCallback(async () => {
    const request = profileRequest.current + 1;
    profileRequest.current = request;
    setLoadFailure(undefined);
    setProfile(undefined);
    try {
      const detail = await readModel(modelID);
      if (profileRequest.current === request) setProfile(detail);
    } catch (cause) {
      if (profileRequest.current === request) setLoadFailure(resourceFailure(cause));
    }
  }, [modelID]);
  const loadCatalog = useCallback(async () => {
    setCatalogState({ status: "loading" });
    setCatalogState(await captureResource(api.modelCatalog));
  }, []);
  useEffect(() => void loadProfile(), [loadProfile]);
  useEffect(() => void loadCatalog(), [loadCatalog]);

  async function revise(value: ProviderModelInput) {
    if (!profile || conflict) return;
    setPending(true);
    setSuccessMessage("");
    try {
      const revised = await api.reviseModel(profile.model_profile_id, {
        expected_version: profile.revision,
        display_name: value.display_name,
        model: value.model,
      });
      setProfile(revised);
      setOpen(false);
      setSuccessMessage("Model settings saved.");
    } catch (cause) {
      if (cause instanceof APIError && cause.status === 409 && cause.code === "lifecycle_conflict") {
        setConflict(true);
        throw new Error("This model has changed. Reload the latest settings before saving again.");
      }
      throw cause;
    } finally {
      setPending(false);
    }
  }

  async function reloadForEdit() {
    setPending(true);
    try {
      setProfile(await readModel(modelID));
      setConflict(false);
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
  const facts = [
    ["Provider", modelProfileLabel(catalog, profile)],
    ["Model", profile.model.model],
    ["Context window", profile.model.context_window.toLocaleString()],
    ["Maximum output", profile.model.max_output_tokens.toLocaleString()],
    ["Input formats", modelInputLabel(profile.model)],
    ["Profile updated", dateTime(profile.updated_at)],
  ];
  return (
    <div className="grid gap-6">
      <Button asChild className="w-fit" size="sm" variant="ghost"><a href="#models"><ArrowLeft className="h-4 w-4" />Back to model providers</a></Button>
      <PageHeader
        eyebrow={modelProfileLabel(catalog, profile)}
        title={profile.model.model}
        detail={profile.model.base_url}
        actions={<><Badge value={profile.enabled ? "enabled" : "disabled"} /><Button disabled={!catalogGate.changeAllowed || availabilityBusy} title={catalogGate.message} onClick={() => { setSuccessMessage(""); setOpen(true); }}><Pencil className="h-4 w-4" />Edit model</Button></>}
      />
      {successMessage ? <SuccessNotice message={successMessage} onDismiss={() => setSuccessMessage("")} /> : null}
      <CatalogAvailabilityControl kind="model-profiles" resourceID={modelID} enabled={profile.enabled} disabled={open || pending}
        onBusyChange={setAvailabilityBusy} onReload={async (signal) => {
          const current = await readModel(modelID, signal);
          if (!signal.aborted) setProfile(current);
        }} />
      {catalogState.status === "error" ? <ResourceFailureNotice failure={catalogState.failure} message={`Model catalog could not be loaded: ${catalogState.failure.message}`} retryLabel="Retry model catalog" onRetry={() => void loadCatalog()} /> : null}
      <Section title="Model configuration" detail="Provider credentials are write-only and never returned to the browser.">
        <div className="grid gap-px overflow-hidden rounded-md border border-border bg-border shadow-xs sm:grid-cols-2 lg:grid-cols-3">
          {facts.map(([label, value]) => <div className="bg-white p-4" key={label}><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 break-words text-sm font-medium">{value}</p></div>)}
        </div>
      </Section>
      <Section title="Endpoint">
        <div className="flex items-center gap-3 rounded-md border border-border bg-white p-4 font-mono text-sm shadow-xs break-all"><Server className="h-4 w-4 shrink-0 text-muted-foreground" />{profile.model.base_url}</div>
      </Section>
      <Section title="Token rates" detail="USD per 1M tokens. Estimated rates; actual charges may vary.">
        <ModelRates pricing={profile.model.pricing} />
      </Section>
      {catalog ? (
        <Dialog dismissible={!pending} open={open} onOpenChange={setOpen} title="Edit model">
          <ModelEditor key={profile.revision} catalog={catalog} initialModel={profile.model} initialDisplayName={profile.display_name} pending={pending} submitLabel="Save changes" onCancel={() => setOpen(false)} onSubmit={revise} onReload={conflict ? reloadForEdit : undefined} />
        </Dialog>
      ) : null}
    </div>
  );
}

async function readModel(modelID: string, signal?: AbortSignal): Promise<ModelProfile> {
  const detail = await api.model(modelID, signal);
  if (detail.model_profile_id !== modelID) {
    throw new APIError(404, "reference_not_found", "The model could not be found.");
  }
  return detail;
}
