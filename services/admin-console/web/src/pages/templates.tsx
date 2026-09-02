import { Boxes, LoaderCircle, Plus } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { DataTable, PageHeader } from "../components/page";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Dialog } from "../components/ui/dialog";
import { Empty, ErrorNotice, Loading } from "../components/ui/feedback";
import { Field, Input, Select, Textarea } from "../components/ui/input";
import { api, errorMessage } from "../lib/api";
import {
  immutableImageReference,
  positiveInteger,
  slugify,
} from "../lib/forms";
import { bytes, dateTime } from "../lib/format";
import type { AgentTemplate, ModelProfile } from "../lib/types";

export function TemplatesPage() {
  const [items, setItems] = useState<AgentTemplate[]>();
  const [models, setModels] = useState<ModelProfile[]>([]);
  const [defaultImage, setDefaultImage] = useState("");
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const load = useCallback(async () => {
    try {
      const overview = await api.overview();
      if (overview.templates.status !== "available")
        throw new Error("Template catalog is unavailable.");
      setItems(overview.templates.data.items);
      setModels(
        overview.model_profiles.status === "available"
          ? overview.model_profiles.data.items.filter(
              (profile) => profile.enabled,
            )
          : [],
      );
      setDefaultImage(overview.defaults.runtime_image_ref);
      setError(
        overview.model_profiles.status === "unavailable"
          ? `Model profiles are unavailable: ${overview.model_profiles.error.message}`
          : "",
      );
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, []);
  useEffect(() => void load(), [load]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const name = String(data.get("name") ?? "").trim();
    const imageRef = String(data.get("image_ref") ?? "").trim();
    if (!defaultImage && !immutableImageReference(imageRef)) {
      setError("Runtime image must use an immutable SHA-256 digest.");
      return;
    }
    setPending(true);
    setError("");
    try {
      await api.createTemplate({
        template_key: `${slugify(name, "template")}-${Date.now().toString(36)}`,
        name,
        model_profile_revision_id: String(
          data.get("model_profile_revision_id") ?? "",
        ),
        system_prompt: String(data.get("system_prompt") ?? ""),
        max_model_requests: positiveInteger(data.get("max_model_requests"), 32),
        runtime: imageRef ? { image_ref: imageRef } : undefined,
      });
      form.reset();
      setOpen(false);
      await load();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  if (!items && !error) return <Loading label="Loading templates" />;
  return (
    <div className="grid gap-6">
      <PageHeader
        title="Agent templates"
        detail="Versioned Agent configuration used to build executable instances."
        actions={
          <Button disabled={models.length === 0} onClick={() => setOpen(true)}>
            <Plus className="h-4 w-4" />
            Create template
          </Button>
        }
      />
      {error ? <ErrorNotice message={error} /> : null}
      {items?.length === 0 ? (
        <Empty
          title="No templates"
          detail={
            models.length === 0
              ? "Add a model profile first."
              : "Create a template to define a model and runtime."
          }
        />
      ) : (
        <DataTable>
          <table className="w-full min-w-[780px] text-left text-sm">
            <thead className="bg-muted/60 text-xs text-muted-foreground">
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
              {items?.map((template) => (
                <tr key={`${template.template_id}:${template.revision}`}>
                  <td className="px-3 py-3">
                    <div className="flex items-center gap-2">
                      <Boxes className="h-4 w-4 text-muted-foreground" />
                      <span className="font-medium">{template.name}</span>
                    </div>
                  </td>
                  <td className="px-3 py-3 font-mono text-xs text-muted-foreground">
                    {models.find(
                      (model) =>
                        model.revision_id ===
                        template.model_profile_revision_id,
                    )?.display_name ?? template.model_profile_revision_id}
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
      )}
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Create template"
        description="Define the model and runtime used by new Agents."
      >
        <form className="grid gap-4" onSubmit={submit}>
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
          <Field label="System prompt">
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
          {!defaultImage ? (
            <Field label="Runtime image digest">
              <Input
                name="image_ref"
                placeholder="antnest/runtime@sha256:…"
                required
              />
            </Field>
          ) : null}
          <div className="mt-2 flex justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button disabled={pending} type="submit">
              {pending ? (
                <LoaderCircle className="h-4 w-4 animate-spin" />
              ) : null}
              Create template
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
