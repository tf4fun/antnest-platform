import { LoaderCircle, Plus, RefreshCw, Settings2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../components/ui/button";
import { ErrorNotice } from "../components/ui/feedback";
import { CheckboxField } from "../components/ui/input";
import { SearchField } from "../components/page";
import { api, APIError, errorMessage } from "../lib/api";
import {
  presetParameters,
  validateModelDisplayName,
  validateModelParameters,
} from "../lib/model-catalog";
import { enrichDiscoveredModels } from "../lib/model-discovery";
import type {
  ModelCatalog,
  ModelCatalogEntry,
  ModelProfile,
  ProviderConnection,
  ProviderDiscoveryDraft,
  ProviderModelInput,
} from "../lib/types";
import { ModelEditor } from "./model-editor";

function complete(model: ModelCatalogEntry): boolean {
  try {
    validateModelDisplayName(model.display_name);
    validateModelParameters(presetParameters(model));
    return true;
  } catch {
    return false;
  }
}

export function ProviderModelDiscovery({
  connection,
  draft,
  catalog,
  onSaved,
  onConnect,
  onClose,
  onBusy,
}: {
  connection: Pick<
    ProviderConnection,
    "connection_id" | "provider_key" | "display_name" | "base_url"
  >;
  draft?: ProviderDiscoveryDraft;
  catalog: ModelCatalog;
  onSaved?: (model: ModelProfile) => void;
  onConnect?: (models: ProviderModelInput[]) => Promise<void>;
  onClose: () => void;
  onBusy: (busy: boolean) => void;
}) {
  const preset = catalog.providers.find(
    (provider) => provider.provider_key === connection.provider_key,
  );
  const [models, setModels] = useState<ModelCatalogEntry[]>([]);
  const [saved, setSaved] = useState(new Set<string>());
  const [selected, setSelected] = useState(new Set<string>());
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [loadFailed, setLoadFailed] = useState(false);
  const [fallback, setFallback] = useState("");
  const [editing, setEditing] = useState<ModelCatalogEntry | "manual">();
  const active = useRef<AbortController | undefined>(undefined);
  const submitting = useRef(false);
  const load = useCallback(async () => {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setLoading(true);
    setLoadFailed(false);
    setError("");
    setFallback("");
    setSelected(new Set());
    try {
      const stored: ModelCatalogEntry[] = [];
      let afterID: string | undefined;
      if (!draft) {
        do {
          const page = await api.models({ afterID });
          if (controller.signal.aborted) return;
          for (const item of page.items) {
            if (item.provider_connection_id === connection.connection_id) {
              const { model, base_url: _baseURL, ...settings } = item.model;
              stored.push({
                ...settings,
                model_id: model,
                display_name: item.display_name,
              });
            }
          }
          afterID = page.next_after_id ?? undefined;
        } while (afterID);
      }
      setSaved(new Set(stored.map((item) => item.model_id)));
      let candidates: ModelCatalogEntry[];
      try {
        const result = draft
          ? await api.discoverDraftModels(draft, controller.signal)
          : await api.discoverProviderModels(
              connection.connection_id,
              controller.signal,
            );
        if (!Array.isArray(result.models))
          throw new Error("Invalid model discovery response.");
        candidates = enrichDiscoveredModels(
          result.models,
          preset?.models ?? [],
          stored,
        );
      } catch (cause) {
        if (controller.signal.aborted) return;
        if (
          cause instanceof APIError &&
          cause.code !== "provider_discovery_failed"
        )
          throw cause;
        candidates = enrichDiscoveredModels([], preset?.models ?? [], stored);
        setFallback(
          `Model discovery failed. Showing builtin and saved models. ${errorMessage(cause)}`,
        );
      }
      if (!controller.signal.aborted) setModels(candidates);
    } catch (cause) {
      if (!controller.signal.aborted) {
        setModels([]);
        setLoadFailed(true);
        setError(errorMessage(cause));
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [connection.connection_id, draft, preset]);
  useEffect(() => {
    void load();
    return () => active.current?.abort();
  }, [load]);

  async function save() {
    if (submitting.current) return;
    submitting.current = true;
    setSaving(true);
    onBusy(true);
    setError("");
    try {
      if (draft) {
        if (!onConnect) throw new Error("Provider creation is unavailable.");
        await onConnect(
          models
            .filter((model) => selected.has(model.model_id))
            .map((model) => ({
              display_name: model.display_name,
              model: validateModelParameters(presetParameters(model)),
            })),
        );
        return;
      }
      for (const model of models.filter(
        (candidate) =>
          selected.has(candidate.model_id) && !saved.has(candidate.model_id),
      )) {
        const result = await api.createModel({
          provider_connection_id: connection.connection_id,
          display_name: model.display_name,
          model: validateModelParameters(presetParameters(model)),
        });
        setSaved((current) => new Set([...current, model.model_id]));
        setSelected(
          (current) =>
            new Set([...current].filter((id) => id !== model.model_id)),
        );
        onSaved?.(result);
      }
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      submitting.current = false;
      setSaving(false);
      onBusy(false);
    }
  }

  if (editing) {
    const draft = editing === "manual" ? undefined : editing;
    return (
      <ModelEditor
        catalog={catalog}
        provider={{
          provider_key: connection.provider_key,
          display_name: connection.display_name,
          description: "",
          base_url: connection.base_url,
          custom: false,
          models: [],
        }}
        initialModel={
          draft
            ? { ...presetParameters(draft), base_url: connection.base_url }
            : undefined
        }
        initialDisplayName={draft?.display_name}
        pending={false}
        submitLabel="Use settings"
        onCancel={() => setEditing(undefined)}
        onSubmit={async (value) => {
          const { model, ...parameters } = value.model;
          if (saved.has(model))
            throw new Error("This model has already been added.");
          setModels((current) => [
            ...current.filter((item) => item.model_id !== model),
            {
              ...parameters,
              model_id: model,
              display_name: value.display_name,
            },
          ]);
          setSelected((current) => new Set([...current, model]));
          setEditing(undefined);
        }}
      />
    );
  }
  const visible = models.filter((model) =>
    `${model.display_name} ${model.model_id}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  const selectedModels = models.filter((model) => selected.has(model.model_id));
  return (
    <div className="grid min-w-0 gap-4">
      {error ? <ErrorNotice message={error} /> : null}
      {fallback ? <ErrorNotice message={fallback} /> : null}
      <div className="flex min-w-0 gap-2">
        <SearchField
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search models"
        />
        <Button
          variant="ghost"
          title="Refresh models"
          aria-label="Refresh models"
          disabled={loading || saving}
          onClick={() => void load()}
        >
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>
      <div
        aria-busy={loading}
        className="max-h-80 min-h-24 overflow-y-auto divide-y divide-border border-y border-border"
      >
        {loading ? (
          <p className="py-6 text-sm text-muted-foreground">
            Discovering models...
          </p>
        ) : (
          visible.map((model) => (
            <div
              key={model.model_id}
              className="flex min-w-0 items-center gap-2 py-3"
            >
              <div className="min-w-0 flex-1 break-words">
                <CheckboxField
                  label={model.display_name}
                  checked={selected.has(model.model_id)}
                  disabled={saving || saved.has(model.model_id)}
                  onChange={(event) =>
                    setSelected(
                      (current) =>
                        new Set(
                          event.target.checked
                            ? [...current, model.model_id]
                            : [...current].filter(
                                (id) => id !== model.model_id,
                              ),
                        ),
                    )
                  }
                />
                <div className="mt-1 break-all pl-6 text-xs text-muted-foreground">
                  {model.model_id}
                  {saved.has(model.model_id)
                    ? " · Added"
                    : !complete(model)
                      ? " · Settings required"
                      : ""}
                </div>
              </div>
              <Button
                variant="ghost"
                title={`Settings for ${model.display_name}`}
                aria-label={`Settings for ${model.display_name}`}
                disabled={saving || saved.has(model.model_id)}
                onClick={() => setEditing(model)}
              >
                <Settings2 className="h-4 w-4" />
              </Button>
            </div>
          ))
        )}
        {!loading && !visible.length ? (
          <p className="py-6 text-sm text-muted-foreground">
            {models.length ? "No matching models." : "No models returned."}
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap justify-between gap-2">
        <Button
          variant="ghost"
          disabled={loading || saving || loadFailed}
          onClick={() => setEditing("manual")}
        >
          <Plus className="h-4 w-4" />
          Add manually
        </Button>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" disabled={saving} onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={
              loading ||
              saving ||
              loadFailed ||
              (!draft && !selectedModels.length) ||
              selectedModels.some((model) => !complete(model))
            }
            onClick={() => void save()}
          >
            {saving ? (
              <LoaderCircle className="h-4 w-4 animate-spin" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
            {draft ? "Connect provider" : "Add selected models"}
          </Button>
        </div>
      </div>
    </div>
  );
}
