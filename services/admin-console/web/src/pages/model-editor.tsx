import { LoaderCircle, RefreshCw, Save } from "lucide-react";
import { useId, useRef, useState, type FormEvent } from "react";
import { ModelPricingEditor } from "../components/model-pricing";
import { Button } from "../components/ui/button";
import { ErrorNotice } from "../components/ui/feedback";
import { CheckboxField, Field, Input, Select } from "../components/ui/input";
import { errorMessage } from "../lib/api";
import { positiveInteger } from "../lib/forms";
import { ModelPriceError, parseModelPricing } from "../lib/model-pricing";
import {
  presetParameters,
  savedParameters,
  validateModelParameters,
  validateModelDisplayName,
} from "../lib/model-catalog";
import type {
  ModelCatalog,
  ModelParameters,
  ModelProviderPreset,
  ModelSpec,
  ProviderModelInput,
} from "../lib/types";

export function ModelEditor({
  catalog,
  provider,
  initialModel,
  initialDisplayName,
  pending,
  submitLabel,
  onCancel,
  onSubmit,
  onReload,
}: {
  catalog: ModelCatalog;
  provider?: ModelProviderPreset;
  initialModel?: ModelSpec;
  initialDisplayName?: string;
  pending: boolean;
  submitLabel: string;
  onCancel: () => void;
  onSubmit: (value: ProviderModelInput) => Promise<void>;
  onReload?: () => Promise<void>;
}) {
  const presets = provider?.models ?? [];
  const first = presets[0];
  const [model, setModel] = useState<ModelParameters>(() => {
    if (initialModel) return savedParameters(initialModel);
    return first
      ? presetParameters(first)
      : {
          model: "",
          context_window: 0,
          max_output_tokens: 0,
          supports_images: false,
        };
  });
  const [custom, setCustom] = useState(!first);
  const [formError, setFormError] = useState("");
  const [invalidPriceField, setInvalidPriceField] = useState<string>();
  const submitting = useRef(false);
  const errorID = useId();
  const known = catalog.providers.some((candidate) =>
    candidate.models.some((entry) => entry.model_id === model.model),
  );
  function changeModel(id: string) {
    const preset = presets.find((entry) => entry.model_id === id);
    setCustom(!preset);
    setModel(
      preset
        ? presetParameters(preset)
        : {
            model: "",
            context_window: 0,
            max_output_tokens: 0,
            supports_images: false,
          },
    );
    setFormError("");
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || submitting.current || onReload) return;
    const form = event.currentTarget;
    submitting.current = true;
    try {
      const pricing = parseModelPricing(new FormData(form));
      const { pricing: _oldPricing, ...parameters } =
        validateModelParameters(model);
      const label =
        presets.find((entry) => entry.model_id === model.model)?.display_name ??
        model.model.trim();
      setFormError("");
      setInvalidPriceField(undefined);
      await onSubmit({
        display_name: validateModelDisplayName(initialDisplayName ?? label),
        model: {
          ...parameters,
          model: model.model.trim(),
          ...(pricing === undefined ? {} : { pricing }),
        },
      });
    } catch (cause) {
      setFormError(errorMessage(cause));
      if (cause instanceof ModelPriceError) {
        setInvalidPriceField(cause.field);
        const input = form.elements.namedItem(cause.field);
        if (input instanceof HTMLInputElement) input.focus();
      }
    } finally {
      submitting.current = false;
    }
  }
  async function reload() {
    if (!onReload || pending || submitting.current) return;
    submitting.current = true;
    try {
      await onReload();
      setFormError("");
    } catch (cause) {
      setFormError(errorMessage(cause));
    } finally {
      submitting.current = false;
    }
  }
  return (
    <form className="grid gap-5" onSubmit={submit}>
      {formError ? (
        <div id={errorID}>
          <ErrorNotice message={formError} />
        </div>
      ) : null}
      {onReload ? (
        <Button type="button" variant="secondary" disabled={pending} onClick={() => void reload()}>
          <RefreshCw className="h-4 w-4" />Reload latest model
        </Button>
      ) : null}
      <fieldset disabled={pending} className="grid min-w-0 gap-5">
        {initialModel ? (
          <Field label="Model ID">
            <Input value={model.model} readOnly />
          </Field>
        ) : (
          <>
            <Field label="Model">
              <Select
                value={custom ? "" : model.model}
                onChange={(event) => changeModel(event.target.value)}
              >
                {presets.map((entry) => (
                  <option key={entry.model_id} value={entry.model_id}>
                    {entry.display_name}
                  </option>
                ))}
                <option value="">Other model</option>
              </Select>
            </Field>
            {custom ? (
              <Field label="Model ID">
                <Input
                  value={model.model}
                  onChange={(event) =>
                    setModel({ ...model, model: event.target.value })
                  }
                  required
                />
              </Field>
            ) : null}
          </>
        )}
        <details key={String(known)} open={!known}>
          <summary className="cursor-pointer text-sm font-medium">
            Model settings
          </summary>
          <div className="mt-4 grid gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Context window">
                <Input
                  type="number"
                  min="1024"
                  required
                  value={model.context_window || ""}
                  onChange={(event) =>
                    setModel({
                      ...model,
                      context_window: positiveInteger(event.target.value, 0),
                    })
                  }
                />
              </Field>
              <Field label="Maximum output">
                <Input
                  type="number"
                  min="1"
                  required
                  value={model.max_output_tokens || ""}
                  onChange={(event) =>
                    setModel({
                      ...model,
                      max_output_tokens: positiveInteger(event.target.value, 0),
                    })
                  }
                />
              </Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <CheckboxField
                label="Image input"
                checked={model.supports_images}
                onChange={(event) =>
                  setModel({ ...model, supports_images: event.target.checked })
                }
              />
              <CheckboxField
                label="Audio input"
                checked={model.supports_audio ?? false}
                onChange={(event) =>
                  setModel({ ...model, supports_audio: event.target.checked })
                }
              />
              <CheckboxField
                label="PDF input"
                checked={model.supports_pdf ?? false}
                onChange={(event) =>
                  setModel({ ...model, supports_pdf: event.target.checked })
                }
              />
            </div>
          </div>
        </details>
        <ModelPricingEditor
          key={model.model}
          initial={model.pricing}
          invalidField={invalidPriceField}
          errorID={errorID}
        />
      </fieldset>
      <div className="flex justify-end gap-2">
        <Button
          disabled={pending}
          type="button"
          variant="secondary"
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button disabled={pending || Boolean(onReload)} aria-busy={pending} type="submit">
          {pending ? (
            <LoaderCircle className="h-4 w-4 animate-spin" />
          ) : (
            <Save className="h-4 w-4" />
          )}
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
