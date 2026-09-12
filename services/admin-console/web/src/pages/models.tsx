import { ArrowLeft, Pencil, Server } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ModelRates } from "../components/model-pricing";
import { PageHeader, ResourceFailureNotice, ResourceFailurePage, Section } from "../components/page";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Dialog } from "../components/ui/dialog";
import { Loading, SuccessNotice } from "../components/ui/feedback";
import { APIError, api } from "../lib/api";
import { loadImmutableCatalogDetail } from "../lib/catalog-detail";
import { dateTime } from "../lib/format";
import { modelCatalogGate, modelProfileLabel, modelInputLabel } from "../lib/model-catalog";
import { resourceFailure, type ResourceFailure } from "../lib/resource-failure";
import { captureResource, type ResourceState } from "../lib/resource-state";
import type { ModelCatalog, ModelProfile, ProviderModelInput } from "../lib/types";
import { ProviderList } from "./providers";
import { ModelEditor } from "./model-editor";

export function ModelsPage({ modelID, revisionID }: { modelID?: string; revisionID?: string }) {
  return modelID ? <ModelDetail key={`${modelID}:${revisionID ?? "current"}`} modelID={modelID} revisionID={revisionID} /> : <ProviderList />;
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

  async function revise(value: ProviderModelInput) {
    if (!profile || revisionID !== undefined) return;
    setPending(true);
    setSuccessMessage("");
    try {
      const revised = await api.reviseModel(profile.model_profile_id, {
        display_name: value.display_name,
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
    ["Input formats", modelInputLabel(profile.model)],
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
      <Section title="Token rates" detail="USD per 1M tokens, saved with this revision. Estimated rates; actual charges may vary.">
        <ModelRates pricing={profile.model.pricing} />
      </Section>
      {!historical && catalog ? (
        <Dialog dismissible={!pending} open={open} onOpenChange={setOpen} title="Create model revision" description="Publish updated model settings.">
          <ModelEditor key={profile.revision} catalog={catalog} initialModel={profile.model} initialDisplayName={profile.display_name} pending={pending} submitLabel="Publish revision" onCancel={() => setOpen(false)} onSubmit={revise} />
        </Dialog>
      ) : null}
    </div>
  );
}
