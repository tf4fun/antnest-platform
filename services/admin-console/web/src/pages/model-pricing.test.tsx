import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ModelCatalog, ModelPricing, ModelProfile, ModelSpec } from "../lib/types";
import { ModelsPage } from "./models";
import { ModelEditorFixture } from "./model-editor-fixture";

afterEach(() => { cleanup(); sessionStorage.clear(); });

const saved: ModelPricing = { currency: "USD", input_per_million: 0.00001234567, output_per_million: 8, cache_read_per_million: 0 };
const listed: ModelPricing = { currency: "USD", input_per_million: 2, output_per_million: 10, cache_write_per_million: 3 };
const profile: ModelProfile = {
  provider_connection_id: "connection-1", model_profile_id: "priced", display_name: "Priced model", revision_id: "priced-1", revision: 1, enabled: true,
  model: { base_url: "https://known.test/v1", model: "known", context_window: 8192, max_output_tokens: 1024, supports_images: false, pricing: saved },
  created_at: "2026-09-09T00:00:00Z", updated_at: "2026-09-09T00:00:00Z",
};
const catalog: ModelCatalog = { revision: "pricing", providers: [
  { provider_key: "known", display_name: "Known API", description: "", base_url: "https://known.test/v1", custom: false,
    models: ["known", "other"].map((id) => ({ model_id: id, display_name: id, context_window: 8192, max_output_tokens: 1024, supports_images: false, pricing: listed })) },
  { provider_key: "custom", display_name: "Custom API", description: "", base_url: "", custom: true, models: [] },
] };

function backend(first?: "503" | "malformed", value = profile, catalogFailure = false) {
  const writes: Array<{ body: { model: ModelSpec }; key: string | null }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit) => {
    const path = new URL(input, "http://localhost").pathname;
    if (init.method === "POST") {
      const body = JSON.parse(String(init.body)) as { model: ModelSpec };
      writes.push({ body, key: new Headers(init.headers).get("Idempotency-Key") });
      if (writes.length === 1 && first === "503") return Response.json({ message: "Retry publication" }, { status: 503 });
      if (writes.length === 1 && first === "malformed") return new Response("invalid-json", { status: 201 });
      return Response.json({ ...value, model: { ...value.model, ...body.model, pricing: body.model.pricing }, revision: 2, revision_id: "priced-2" }, { status: 201 });
    }
    if (path === "/api/admin/model-catalog") return catalogFailure ? Response.json({ message: "Catalog unavailable" }, { status: 503 }) : Response.json(catalog);
    if (path === "/api/admin/model-profiles") return Response.json({ items: [value] });
    return Response.json(value);
  }));
  return writes;
}

async function editor(edit = false) {
  render(edit ? <ModelsPage modelID="priced" /> : <ModelEditorFixture catalog={catalog} />);
  if (edit) {
    const button = await screen.findByRole("button", { name: "Create revision" });
    await waitFor(() => expect(button.matches(":disabled")).toBe(false));
    fireEvent.click(button);
  }
  return within(await screen.findByRole("dialog"));
}

function publish(form: ReturnType<typeof within>, edit = false) {
  fireEvent.click(form.getByRole("button", { name: edit ? "Publish revision" : "Add model" }));
}

it("prefills and submits catalogue prices explicitly", async () => {
  const writes = backend();
  const form = await editor();
  expect((form.getByRole("checkbox", { name: "Set rates" }) as HTMLInputElement).checked).toBe(true);
  expect((form.getByLabelText("Input (USD / 1M tokens)") as HTMLInputElement).value).toBe("2");
  publish(form);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(writes[0]?.body.model.pricing).toEqual(listed);
});

it.each(["503", "malformed"] as const)("preserves saved prices, draft and retry identity after %s", async (failure) => {
  const writes = backend(failure);
  const form = await editor(true);
  expect((form.getByLabelText("Input (USD / 1M tokens)") as HTMLInputElement).value).toBe(String(saved.input_per_million));
  expect((form.getByLabelText("Cache write (USD / 1M tokens)") as HTMLInputElement).value).toBe("");
  publish(form, true);
  await form.findByRole("alert");
  expect(JSON.stringify({ ...sessionStorage })).not.toContain("synthetic-price-key");
  publish(form, true);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(writes[0]?.body.model.pricing).toEqual(saved);
  expect(writes[1]).toEqual(writes[0]);
});

it("can remove pricing without a hidden catalogue fallback", async () => {
  const writes = backend();
  const form = await editor(true);
  fireEvent.click(form.getByRole("checkbox", { name: "Set rates" }));
  expect(form.getByText("Not configured")).toBeTruthy();
  publish(form, true);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(writes[0]?.body.model).not.toHaveProperty("pricing");
  expect(screen.getByText("Not configured")).toBeTruthy();
});

it("keeps zero distinct from blank and rejects incomplete edits before publishing", async () => {
  const writes = backend();
  const form = await editor(true);
  fireEvent.change(form.getByLabelText("Input (USD / 1M tokens)"), { target: { value: "" } });
  fireEvent.submit(form.getByRole("button", { name: "Publish revision" }).closest("form")!);
  expect(await form.findByRole("alert")).toBeTruthy();
  expect(writes).toHaveLength(0);
  expect(document.activeElement).toBe(form.getByLabelText("Input (USD / 1M tokens)"));
  for (const label of ["Input", "Output", "Cache read"]) fireEvent.change(form.getByLabelText(`${label} (USD / 1M tokens)`), { target: { value: "0" } });
  publish(form, true);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(writes[0]?.body.model.pricing).toEqual({ currency: "USD", input_per_million: 0, output_per_million: 0, cache_read_per_million: 0 });
});

it("resets defaults when selecting another new model and discards cancelled revision edits", async () => {
  backend();
  const form = await editor();
  fireEvent.change(form.getByLabelText("Input (USD / 1M tokens)"), { target: { value: "999" } });
  fireEvent.change(form.getByLabelText("Model"), { target: { value: "other" } });
  expect((form.getByLabelText("Input (USD / 1M tokens)") as HTMLInputElement).value).toBe("2");
  fireEvent.change(form.getByLabelText("Model"), { target: { value: "" } });
  expect(form.getByText("Not configured")).toBeTruthy();
  cleanup();
  const revision = await editor(true);
  fireEvent.change(revision.getByLabelText("Input (USD / 1M tokens)"), { target: { value: "999" } });
  fireEvent.click(revision.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Create revision" }));
  expect((screen.getByLabelText("Input (USD / 1M tokens)") as HTMLInputElement).value).toBe(String(saved.input_per_million));
});

it.each([true, false])("historical pricing never follows catalog data (unavailable=%s)", async (unavailable) => {
  backend(undefined, profile, unavailable);
  render(<ModelsPage modelID="priced" revisionID="priced-1" />);
  expect(await screen.findByText("$8")).toBeTruthy();
  expect(screen.queryByText("$10")).toBeNull();
  expect(screen.queryByRole("button", { name: "Create revision" })).toBeNull();
});

it("does not fill an unpriced historical revision with current catalog rates", async () => {
  const { pricing: _pricing, ...model } = profile.model;
  backend(undefined, { ...profile, model });
  render(<ModelsPage modelID="priced" revisionID="priced-1" />);
  expect(await screen.findByText("Not configured")).toBeTruthy();
  expect(screen.queryByText("$2")).toBeNull();
});

it("locks publication controls and does not project a late revision into another profile", async () => {
  const writes = backend();
  const fetcher = globalThis.fetch;
  let complete!: (response: Response) => void;
  const response = new Promise<Response>((resolve) => { complete = resolve; });
  vi.stubGlobal("fetch", vi.fn((input: string, init: RequestInit) => {
    if (init.method === "POST") { void fetcher(input, init); return response; }
    if (String(input).endsWith("/another")) return Promise.resolve(Response.json({ ...profile, model_profile_id: "another", model: { ...profile.model, model: "another-model" } }));
    return fetcher(input, init);
  }));
  const view = render(<ModelsPage modelID="priced" />);
  const open = await screen.findByRole("button", { name: "Create revision" });
  await waitFor(() => expect((open as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(open);
  const form = within(await screen.findByRole("dialog"));
  publish(form, true);
  await waitFor(() => expect(writes).toHaveLength(1));
  for (const control of [form.getByLabelText("Model ID"), form.getByLabelText("Input (USD / 1M tokens)")]) {
    expect(control.matches(":disabled")).toBe(true);
  }
  expect((form.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.submit(form.getByRole("button", { name: "Publish revision" }).closest("form")!);
  expect(writes).toHaveLength(1);
  view.rerender(<ModelsPage modelID="another" />);
  await screen.findByRole("heading", { name: "another-model" });
  await act(async () => { complete(Response.json({ ...profile, revision: 2 })); });
  expect(screen.getByRole("heading", { name: "another-model" })).toBeTruthy();
  expect(screen.queryByText("Model revision 2 published.")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Create revision" }));
  expect(screen.queryByLabelText("Replacement API key")).toBeNull();
});

it("keeps an unlisted model unpriced unless rates are supplied", async () => {
  const writes = backend();
  const form = await editor();
  fireEvent.change(form.getByLabelText("Model"), { target: { value: "" } });
  fireEvent.change(form.getByLabelText("Model ID"), { target: { value: "unlisted" } });
  fireEvent.change(form.getByLabelText("Context window"), { target: { value: "8192" } });
  fireEvent.change(form.getByLabelText("Maximum output"), { target: { value: "1024" } });
  expect(form.getByText("Not configured")).toBeTruthy();
  publish(form);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(writes[0]?.body.model).not.toHaveProperty("pricing");
});

it("treats a changed rate after rejection as a new publication intent", async () => {
  const writes = backend("503");
  const form = await editor(true);
  publish(form, true);
  await form.findByRole("alert");
  fireEvent.change(form.getByLabelText("Output (USD / 1M tokens)"), { target: { value: "9" } });
  publish(form, true);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(writes).toHaveLength(2);
  expect(writes[1]?.key).not.toBe(writes[0]?.key);
  expect(writes[1]?.body.model.pricing?.output_per_million).toBe(9);
});

it("does not replace unknown saved prices while editing an existing builtin model", async () => {
  const { pricing: _pricing, ...model } = profile.model;
  const writes = backend(undefined, { ...profile, model });
  const form = await editor(true);
  expect((form.getByRole("checkbox", { name: "Set rates" }) as HTMLInputElement).checked).toBe(false);
  publish(form, true);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(writes[0]?.body.model).not.toHaveProperty("pricing");
});
