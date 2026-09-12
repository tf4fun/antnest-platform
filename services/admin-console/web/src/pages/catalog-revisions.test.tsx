import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentTemplate, ModelCatalog, ModelProfile } from "../lib/types";
import { ModelsPage } from "./models";
import { TemplatesPage } from "./templates";
import { api } from "../lib/api";

afterEach(() => { cleanup(); sessionStorage.clear(); });

const model: ModelProfile = {
  provider_connection_id: "connection-1", model_profile_id: "model-1", display_name: "Support model", revision_id: "model-revision-1", revision: 1, enabled: true,
  model: { base_url: "https://models.example.com/v1", model: "support", context_window: 8192, max_output_tokens: 1024, supports_images: false },
  created_at: "2026-09-07T00:00:00Z", updated_at: "2026-09-07T00:00:00Z",
};
const catalog: ModelCatalog = {
  revision: "test-catalog",
  providers: [{ provider_key: "support", display_name: "Support models", description: "", base_url: model.model.base_url, custom: false,
    models: [{ model_id: "support", display_name: "Support model", context_window: 8192, max_output_tokens: 1024, supports_images: false }] }],
};
const template: AgentTemplate = {
  template_id: "template-1", name: "Support template", revision: 1, enabled: true,
  model_profile_id: model.model_profile_id, system_prompt: "Original instructions", max_model_requests: 32,
  context_policy_version: "context-v1", skill_refs: [],
  runtime: { image_ref: `sha256:${"a".repeat(64)}`, resources: { memory_bytes: 1024, pids_limit: 128, tmpfs_bytes: 1024 } },
  created_at: model.created_at, updated_at: model.updated_at,
};
const workflows = [
  { name: "Model", component: <ModelsPage modelID={model.model_profile_id} />, historical: <ModelsPage modelID={model.model_profile_id} />,
    path: "/api/admin/model-profiles/model-1", revisionPath: "/api/admin/model-profile-revisions/model-revision-1", title: "support",
    field: "Maximum output", value: "2048", result: { ...model, revision_id: "model-revision-7", revision: 7 }, back: "Back to model providers" },
  { name: "Template", component: <TemplatesPage templateID={template.template_id} />, historical: <TemplatesPage templateID={template.template_id} revisionID="1" />,
    path: "/api/admin/templates/template-1", revisionPath: "/api/admin/templates/template-1/revisions/1", title: "Support template",
    field: "System prompt", value: "Revised instructions", result: { ...template, system_prompt: "Revised instructions", revision: 7 }, back: "Back to Agent templates" },
];
type Workflow = typeof workflows[number];
const editLabel = (workflow: Workflow) => workflow.name === "Model" ? "Edit model" : "Create revision";
const saveLabel = (workflow: Workflow) => workflow.name === "Model" ? "Save changes" : "Publish revision";
const savedMessage = (workflow: Workflow) => workflow.name === "Model" ? "Model settings saved." : "Template revision 7 published.";
type Request = { method: string; path: string; body: string; key: string | null };

it("preserves a stale model draft until an explicit successful reload", async () => {
  let reads = 0;
  const latest: ModelProfile = { ...model, revision: 2, model: { ...model.model, max_output_tokens: 4096,
    pricing: { currency: "USD", input_per_million: 8, output_per_million: 9 } } };
  const requests = mockCatalog((request) => {
    if (request.method === "POST") {
      const input = JSON.parse(request.body);
      if (input.expected_version !== 2) return Response.json({ code: "lifecycle_conflict", message: "resource changed concurrently" }, { status: 409 });
      return Response.json({ ...latest, model: { ...latest.model, ...input.model }, revision: 3 }, { status: 201 });
    }
    if (request.path === "/api/admin/model-profiles/model-1") {
      reads++;
      if (reads === 1) return Response.json(model);
      if (reads === 2) return Response.json({ message: "Temporary read failure" }, { status: 503 });
      return Response.json(latest);
    }
    return undefined;
  });
  const dialog = await openRevision(workflows[0]!);
  fireEvent.click(dialog.getByLabelText("Image input"));
  fireEvent.click(dialog.getByLabelText("Set rates"));
  fireEvent.change(dialog.getByLabelText("Input (USD / 1M tokens)"), { target: { value: "3" } });
  fireEvent.change(dialog.getByLabelText("Output (USD / 1M tokens)"), { target: { value: "4" } });
  fireEvent.click(dialog.getByRole("button", { name: "Save changes" }));
  const reload = await dialog.findByRole("button", { name: "Reload latest model" });
  expect(JSON.parse(requests.find((request) => request.method === "POST")!.body).expected_version).toBe(1);
  expect((dialog.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(true);
  expect((dialog.getByLabelText("Maximum output") as HTMLInputElement).value).toBe("2048");
  expect((dialog.getByLabelText("Image input") as HTMLInputElement).checked).toBe(true);
  expect((dialog.getByLabelText("Input (USD / 1M tokens)") as HTMLInputElement).value).toBe("3");
  expect(reads).toBe(1);
  fireEvent.click(reload);
  await dialog.findByText("Temporary read failure");
  expect((dialog.getByLabelText("Maximum output") as HTMLInputElement).value).toBe("2048");
  expect((dialog.getByLabelText("Image input") as HTMLInputElement).checked).toBe(true);
  expect((dialog.getByLabelText("Input (USD / 1M tokens)") as HTMLInputElement).value).toBe("3");
  fireEvent.click(dialog.getByRole("button", { name: "Reload latest model" }));
  await waitFor(() => expect((dialog.getByLabelText("Maximum output") as HTMLInputElement).value).toBe("4096"));
  expect((dialog.getByLabelText("Image input") as HTMLInputElement).checked).toBe(false);
  expect((dialog.getByLabelText("Input (USD / 1M tokens)") as HTMLInputElement).value).toBe("8");
  expect((dialog.getByLabelText("Output (USD / 1M tokens)") as HTMLInputElement).value).toBe("9");
  fireEvent.change(dialog.getByLabelText("Maximum output"), { target: { value: "8192" } });
  fireEvent.click(dialog.getByRole("button", { name: "Save changes" }));
  await screen.findByText("Model settings saved.");
  const writes = requests.filter((request) => request.method === "POST");
  expect(writes).toHaveLength(2);
  expect(JSON.parse(writes[1]!.body).expected_version).toBe(2);
  expect(writes[1]!.key).not.toBe(writes[0]!.key);
});

it("treats refreshed A to B to A edits as new intents after an uncertain response", async () => {
  let saved = model;
  let first = true;
  const receipts = new Map<string, ModelProfile>();
  const writes: Request[] = [];
  mockCatalog((request) => {
    if (request.method === "GET" && request.path === "/api/admin/model-profiles/model-1") return Response.json(saved);
    if (request.method !== "POST") return undefined;
    writes.push(request);
    const receipt = receipts.get(request.key!);
    if (receipt) return Response.json(receipt, { status: 201 });
    const input = JSON.parse(request.body);
    if (input.expected_version !== saved.revision) return Response.json({ code: "lifecycle_conflict" }, { status: 409 });
    saved = { ...saved, display_name: input.display_name, model: { ...saved.model, ...input.model }, revision: saved.revision + 1 };
    receipts.set(request.key!, saved);
    if (first) { first = false; throw new Error("response lost after commit"); }
    return Response.json(saved, { status: 201 });
  });
  const { base_url: _endpoint, ...parameters } = model.model;
  const a = { expected_version: 1, display_name: "A", model: parameters };
  await expect(api.reviseModel(model.model_profile_id, a)).rejects.toThrow("response lost");
  const refreshed = await api.model(model.model_profile_id);
  const b = await api.reviseModel(model.model_profile_id, { ...a, expected_version: refreshed.revision, display_name: "B" });
  const final = await api.reviseModel(model.model_profile_id, { ...a, expected_version: b.revision });
  expect(saved.display_name).toBe("A");
  expect(final).toEqual(saved);
  expect(new Set(writes.map((write) => write.key)).size).toBe(3);
});

it("retries an uncertain model save with the original version and command key", async () => {
  let committed: Response | undefined;
  const requests = mockCatalog((request) => {
    if (request.method !== "POST") return undefined;
    if (committed) return committed;
    committed = Response.json({ ...model, revision: 2 }, { status: 201 });
    throw new Error("Response lost after commit");
  });
  const dialog = await openRevision(workflows[0]!);
  fireEvent.click(dialog.getByRole("button", { name: "Save changes" }));
  await dialog.findByText("Response lost after commit");
  expect(dialog.queryByRole("button", { name: "Reload latest model" })).toBeNull();
  fireEvent.click(dialog.getByRole("button", { name: "Save changes" }));
  await screen.findByText("Model settings saved.");
  const writes = requests.filter((request) => request.method === "POST");
  expect(writes).toHaveLength(2);
  expect(writes[1]!.key).toBe(writes[0]!.key);
  expect(writes[1]!.body).toBe(writes[0]!.body);
  expect(JSON.parse(writes[1]!.body).expected_version).toBe(1);
});

describe("Template stable model reference", () => {
  it("reads the current model for a historical template without rewriting template history", async () => {
    const current = { ...model, revision: 8, revision_id: "model-revision-8" };
    const requests = mockCatalog((request) => request.path === "/api/admin/model-profiles/model-1"
      ? Response.json(current) : undefined);
    render(workflows[1]!.historical);
    const link = await screen.findByRole("link", { name: "Support model · support · revision 8" });
    expect(link.getAttribute("href")).toBe("#models/model-1");
    expect(screen.getByText("Current model")).toBeTruthy();
    expect(screen.getByText("Original instructions")).toBeTruthy();
    expect(requests.map((request) => request.path)).toEqual([
      "/api/admin/templates/template-1/revisions/1", "/api/admin/model-profiles/model-1",
    ]);
  });

  it("keeps a selected model outside the first page and submits its stable ID", async () => {
    const requests = mockCatalog((request) => {
      if (request.path === "/api/admin/model-profiles") return Response.json({ items: [], next_after_id: "page-2" });
      if (request.method === "POST") return Response.json({ ...template, revision: 2 }, { status: 201 });
      return undefined;
    });
    const dialog = await openRevision(workflows[1]!);
    await waitFor(() => expect((dialog.getByLabelText("Model") as HTMLSelectElement).value).toBe(model.model_profile_id));
    fireEvent.click(dialog.getByRole("button", { name: "Publish revision" }));
    await screen.findByText("Template revision 2 published.");
    const writes = requests.filter((request) => request.method === "POST");
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]!.body)).toHaveProperty("model_profile_id", model.model_profile_id);
    expect(JSON.parse(writes[0]!.body)).not.toHaveProperty("model_profile_revision_id");
  });

  it.each(["missing", "disabled"])("never silently substitutes a %s referenced model", async (state) => {
    const alternative = { ...model, model_profile_id: "model-2", revision_id: "revision-2", display_name: "Alternative" };
    const requests = mockCatalog((request) => {
      if (request.path === "/api/admin/model-profiles") return Response.json({ items: [alternative] });
      if (request.path === "/api/admin/model-profiles/model-1") return state === "missing"
        ? Response.json({ message: "Model removed" }, { status: 404 })
        : Response.json({ ...model, enabled: false });
      if (request.method === "POST") return Response.json({ ...template, revision: 2, model_profile_id: "model-2" }, { status: 201 });
      if (request.path === "/api/admin/model-profiles/model-2") return Response.json(alternative);
      return undefined;
    });
    const dialog = await openRevision(workflows[1]!);
    const select = dialog.getByLabelText("Model") as HTMLSelectElement;
    const publish = dialog.getByRole("button", { name: "Publish revision" }) as HTMLButtonElement;
    expect(publish.disabled).toBe(true);
    expect(select.value).not.toBe(alternative.model_profile_id);
    fireEvent.click(publish);
    expect(requests.some((request) => request.method === "POST")).toBe(false);
    fireEvent.change(select, { target: { value: alternative.model_profile_id } });
    expect(publish.disabled).toBe(false);
    fireEvent.click(publish);
    await screen.findByText("Template revision 2 published.");
    expect(JSON.parse(requests.find((request) => request.method === "POST")!.body).model_profile_id).toBe("model-2");
  });

  it("merges model metadata revisions across pages without changing the selection", async () => {
    let pages = 0;
    const requests = mockCatalog((request) => {
      if (request.path === "/api/admin/model-profiles") return Response.json(++pages === 1
        ? { items: [model], next_after_id: "page-2" }
        : { items: [{ ...model, revision_id: "model-revision-2", revision: 2, display_name: "Updated model" }] });
      if (request.method === "POST") return Response.json({ ...template, revision: 2 }, { status: 201 });
      return undefined;
    });
    const dialog = await openRevision(workflows[1]!);
    fireEvent.click(dialog.getByRole("button", { name: "Load more" }));
    await dialog.findByRole("option", { name: /Updated model/ });
    const select = dialog.getByLabelText("Model") as HTMLSelectElement;
    expect(select.value).toBe(model.model_profile_id);
    expect(within(select).getAllByRole("option")).toHaveLength(1);
    fireEvent.click(dialog.getByRole("button", { name: "Publish revision" }));
    await screen.findByText("Template revision 2 published.");
    expect(JSON.parse(requests.find((request) => request.method === "POST")!.body).model_profile_id).toBe(model.model_profile_id);
  });
});

function mockCatalog(overrides: (request: Request) => Response | Promise<Response> | undefined = () => undefined) {
  const requests: Request[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit) => {
    const request = { method: init.method ?? "GET", path: new URL(input, "http://localhost").pathname,
      body: String(init.body ?? ""), key: new Headers(init.headers).get("Idempotency-Key") };
    requests.push(request);
    const response = overrides(request);
    if (response !== undefined) return response;
    if (request.method !== "GET") throw new Error(`Unexpected mutation: ${request.path}`);
    switch (request.path) {
      case "/api/admin/model-catalog": return Response.json(catalog);
      case "/api/admin/model-profiles": return Response.json({ items: [model] });
      case "/api/admin/model-profiles/model-1": return Response.json(model);
      case "/api/admin/templates/template-1":
      case "/api/admin/templates/template-1/revisions/1": return Response.json(template);
      default: throw new Error(`Unexpected read: ${request.path}`);
    }
  }));
  return requests;
}

async function openRevision(workflow: Workflow) {
  render(workflow.component);
  await waitFor(() => expect((screen.getByRole("button", { name: editLabel(workflow) }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: editLabel(workflow) }));
  const dialog = within(await screen.findByRole("dialog"));
  fireEvent.change(dialog.getByLabelText(workflow.field), { target: { value: workflow.value } });
  return dialog;
}

describe.each(workflows)("$name revision workflow", (workflow) => {
  it.each([403, 409])("keeps a rejected %i revision in its form without losing input or reporting success", async (status) => {
    const requests = mockCatalog((request) => request.method === "POST"
      ? Response.json({ message: "Revision rejected" }, { status }) : undefined);
    const dialog = await openRevision(workflow);
    fireEvent.click(dialog.getByRole("button", { name: saveLabel(workflow) }));
    expect((await dialog.findByRole("alert")).textContent).toContain("Revision rejected");
    expect((dialog.getByLabelText(workflow.field) as HTMLInputElement).value).toBe(workflow.value);
    expect(screen.queryByText(/revision .* published/)).toBeNull();
    expect(requests.filter((request) => request.method === "POST").map((request) => request.path)).toEqual([`${workflow.path}/revisions`]);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(workflow.value);
    fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: editLabel(workflow) }));
    expect((screen.getByLabelText(workflow.field) as HTMLInputElement).value).toBe(workflow.name === "Model" ? "1024" : template.system_prompt);
  });

  it("holds the dialog during publication and presents the returned revision with dismissible feedback", async () => {
    let complete!: (response: Response) => void;
    const publication = new Promise<Response>((resolve) => { complete = resolve; });
    const requests = mockCatalog((request) => request.method === "POST" ? publication : undefined);
    const dialog = await openRevision(workflow);
    const submit = dialog.getByRole("button", { name: saveLabel(workflow) }) as HTMLButtonElement;
    fireEvent.click(submit);
    await waitFor(() => expect(requests.filter((request) => request.method === "POST")).toHaveLength(1));
    expect(submit.disabled).toBe(true);
    expect(submit.getAttribute("aria-busy")).toBe("true");
    expect((dialog.getByRole("button", { name: "Close dialog" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(submit);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeTruthy();
    await act(async () => { complete(Response.json(workflow.result, { status: 201 })); });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText(savedMessage(workflow))).toBeTruthy();
    if (workflow.name === "Template") expect(screen.getByText("7")).toBeTruthy();
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(1);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(workflow.value);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss success message" }));
    expect(screen.queryByText(savedMessage(workflow))).toBeNull();
  });

  if (workflow.name === "Template") it("reads an immutable revision without requiring the current head and never exposes an edit action", async () => {
    const requests = mockCatalog((request) => request.path === workflow.path
      ? Response.json({ message: "Current head unavailable" }, { status: 503 }) : undefined);
    render(workflow.historical);
    await screen.findByRole("heading", { name: workflow.title });
    expect(screen.getByText("Viewed revision")).toBeTruthy();
    expect(screen.queryByRole("button", { name: editLabel(workflow) })).toBeNull();
    expect(screen.getByRole("link", { name: "View current revision" }).getAttribute("href")).toBe(
      workflow.name === "Model" ? "#models/model-1" : "#templates/template-1",
    );
    expect(requests.some((request) => request.path === workflow.path)).toBe(false);
    expect(requests.filter((request) => request.path === workflow.revisionPath)).toHaveLength(1);
  });

  it.each([403, 404, 410])("retains terminal %i detail failures with a return link but no retry or edit action", async (status) => {
    mockCatalog((request) => request.path === workflow.path
      ? Response.json({ message: "This revision cannot be accessed" }, { status }) : undefined);
    render(workflow.component);
    expect((await screen.findByRole("alert")).textContent).toContain("This revision cannot be accessed");
    expect(screen.getByRole("link", { name: workflow.back })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByRole("button", { name: editLabel(workflow) })).toBeNull();
  });
});

it("keeps a published Template and its acknowledgement when its referenced Model read fails", async () => {
  let published = false;
  let attempts = 0;
  const revisedModel = { ...model, revision_id: "model-revision-2", revision: 2 };
  const requests = mockCatalog((request) => {
    if (request.method === "POST") {
      published = true;
      return Response.json({ ...template, revision: 2, model_profile_id: revisedModel.model_profile_id, system_prompt: "Revised instructions" }, { status: 201 });
    }
    if (request.path === "/api/admin/model-profiles") return Response.json({ items: [revisedModel] });
    if (request.path === "/api/admin/model-profiles/model-1" && published) {
      return ++attempts === 1 ? Response.json({ message: "Model revision unavailable" }, { status: 503 }) : Response.json(revisedModel);
    }
    return undefined;
  });
  const dialog = await openRevision(workflows[1]!);
  fireEvent.change(dialog.getByLabelText("Model"), { target: { value: revisedModel.model_profile_id } });
  fireEvent.click(dialog.getByRole("button", { name: "Publish revision" }));
  const retry = await screen.findByRole("button", { name: "Retry current model" });
  expect(screen.getByRole("heading", { name: template.name })).toBeTruthy();
  expect(screen.getByText("Revised instructions")).toBeTruthy();
  expect(screen.getByText("Template revision 2 published.")).toBeTruthy();
  fireEvent.click(retry);
  expect((await screen.findByRole("link", { name: "Support model · support · revision 2" })).getAttribute("href"))
    .toBe("#models/model-1");
  expect(requests.filter((request) => request.method === "POST")).toHaveLength(1);
  expect(requests.filter((request) => request.path === "/api/admin/templates/template-1")).toHaveLength(1);
  expect(screen.getByText("Template revision 2 published.")).toBeTruthy();
});

it("reads a current model without querying historical revisions", async () => {
  const requests = mockCatalog();
  render(<ModelsPage modelID={model.model_profile_id} />);
  await screen.findByRole("heading", { name: "support" });
  expect(requests.filter((request) => request.path === "/api/admin/model-profiles/model-1")).toHaveLength(1);
  expect(requests.some((request) => request.path.includes("revisions"))).toBe(false);
  expect(screen.queryByText("Current revision")).toBeNull();
});
