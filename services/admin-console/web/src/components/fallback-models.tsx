import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import { useState } from "react";
import type { ModelProfile } from "../lib/types";
import { Button } from "./ui/button";
import { Field, Select } from "./ui/input";

export function fallbackModelInput(
  data: FormData,
  primaryID: string,
  models: ModelProfile[],
): string[] {
  const ids = data.getAll("fallback_model_profile_ids").map(String);
  const candidates = [primaryID, ...ids];
  if (ids.length > 31 || new Set(candidates).size !== candidates.length)
    throw new Error("Choose each backup model only once.");
  const connections = candidates.flatMap((id) => {
    const model = models.find((item) => item.model_profile_id === id);
    return model ? [model.provider_connection_id] : [];
  });
  if (new Set(connections).size !== connections.length)
    throw new Error("Each backup must use a different Provider connection.");
  return ids;
}

export function FallbackModels({
  primaryID,
  models,
  initial = [],
  disabled = false,
}: {
  primaryID: string;
  models: ModelProfile[];
  initial?: string[];
  disabled?: boolean;
}) {
  const [ids, setIDs] = useState(initial);
  const [selected, setSelected] = useState("");
  const used = new Set([primaryID, ...ids]);
  const connections = new Set(
    models
      .filter((model) => used.has(model.model_profile_id))
      .map((model) => model.provider_connection_id),
  );
  const choices = models.filter(
    (model) =>
      model.enabled &&
      !used.has(model.model_profile_id) &&
      !connections.has(model.provider_connection_id),
  );
  function move(index: number, direction: number) {
    setIDs((current) => {
      const next = [...current];
      [next[index], next[index + direction]] = [
        next[index + direction]!,
        next[index]!,
      ];
      return next;
    });
  }
  return (
    <fieldset disabled={disabled} className="grid min-w-0 gap-3">
      <legend className="mb-2 text-sm font-medium">Backup Providers</legend>
      <ol className="grid min-w-0 gap-2">
        {ids.map((id, index) => {
          const name =
            models.find((model) => model.model_profile_id === id)
              ?.display_name ?? id;
          return (
            <li
              key={id}
              className="flex min-w-0 items-center gap-2 border-b border-border py-2"
            >
              <input
                type="hidden"
                name="fallback_model_profile_ids"
                value={id}
              />
              <span className="text-xs text-muted-foreground">{index + 1}</span>
              <span className="min-w-0 flex-1 break-words text-sm">{name}</span>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                title={`Move ${name} up`}
                aria-label={`Move ${name} up`}
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                <ArrowUp className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                title={`Move ${name} down`}
                aria-label={`Move ${name} down`}
                disabled={index === ids.length - 1}
                onClick={() => move(index, 1)}
              >
                <ArrowDown className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                title={`Remove ${name}`}
                aria-label={`Remove ${name}`}
                onClick={() =>
                  setIDs((current) => current.filter((item) => item !== id))
                }
              >
                <X className="h-4 w-4" />
              </Button>
            </li>
          );
        })}
      </ol>
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <Field label="Backup model">
            <Select
              value={
                choices.some((model) => model.model_profile_id === selected)
                  ? selected
                  : ""
              }
              onChange={(event) => setSelected(event.target.value)}
            >
              <option value="">Select a model</option>
              {choices.map((model) => (
                <option
                  key={model.model_profile_id}
                  value={model.model_profile_id}
                >
                  {model.display_name} · {model.model.model}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Button
          type="button"
          size="icon"
          variant="secondary"
          title="Add backup"
          aria-label="Add backup"
          disabled={
            ids.length >= 31 ||
            !choices.some((model) => model.model_profile_id === selected)
          }
          onClick={() => {
            setIDs((current) => [...current, selected]);
            setSelected("");
          }}
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>
    </fieldset>
  );
}
