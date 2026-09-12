import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ModelCatalog, ModelProfile } from "../lib/types";
import { ModelsPage } from "./models";
import { ModelEditorFixture } from "./model-editor-fixture";

afterEach(() => { cleanup(); sessionStorage.clear(); });

const profile: ModelProfile = {
  provider_connection_id: "connection-1", model_profile_id: "native", display_name: "Native model", revision_id: "native-1", revision: 1, enabled: true,
  model: { base_url: "https://custom.test/v1", model: "native", context_window: 8192, max_output_tokens: 1024,
    supports_images: false, supports_audio: true, supports_pdf: true },
  created_at: "2026-09-09T00:00:00Z", updated_at: "2026-09-09T00:00:00Z",
};
const catalog: ModelCatalog = {
  revision: "native-catalog",
  providers: [
    { provider_key: "known", display_name: "Known API", description: "", base_url: "https://known.test/v1", custom: false,
      models: [{ model_id: "known", display_name: "Known model", context_window: 8192, max_output_tokens: 1024,
        supports_images: true, supports_pdf: true }] },
    { provider_key: "custom", display_name: "Custom API", description: "", base_url: "", custom: true, models: [] },
  ],
};

function mockModels(rejectFirst = false, value = profile) {
  const writes: Array<{ path: string; body: Record<string, unknown>; key: string | null }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit) => {
    const path = new URL(input, "http://localhost").pathname;
    if (init.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      writes.push({ path, body, key: new Headers(init.headers).get("Idempotency-Key") });
      if (rejectFirst && writes.length === 1) return Response.json({ message: "Try publication again" }, { status: 503 });
      return Response.json({ ...value, model: { ...value.model, ...(body.model as object) }, revision: 2, revision_id: "native-2" }, { status: 201 });
    }
    if (path === "/api/admin/model-catalog") return Response.json(catalog);
    if (path === "/api/admin/model-profiles") return Response.json({ items: [value] });
    if (path === "/api/admin/model-profiles/native" || path === "/api/admin/model-profile-revisions/native-1") return Response.json(value);
    throw new Error(`Unexpected request: ${path}`);
  }));
  return writes;
}

async function openEditor(edit = false) {
  render(edit ? <ModelsPage modelID="native" /> : <ModelEditorFixture catalog={catalog} />);
  if (edit) {
    await waitFor(() => expect(screen.getByRole("button", { name: "Create revision" }).matches(":disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Create revision" }));
  }
  return within(await screen.findByRole("dialog"));
}

it("adds an unlisted model with independent capabilities without a key or endpoint", async () => {
  const writes = mockModels();
  const form = await openEditor();
  fireEvent.change(form.getByLabelText("Model"), { target: { value: "" } });
  for (const name of ["Image input", "Audio input", "PDF input"]) expect(form.getByRole("checkbox", { name }).matches(":checked")).toBe(false);
  fireEvent.click(form.getByRole("checkbox", { name: "Audio input" }));
  fireEvent.change(form.getByLabelText("Model ID"), { target: { value: "native" } });
  fireEvent.change(form.getByLabelText("Context window"), { target: { value: "8192" } });
  fireEvent.change(form.getByLabelText("Maximum output"), { target: { value: "1024" } });
  expect(form.queryByLabelText("API key")).toBeNull();
  expect(form.queryByLabelText("API endpoint")).toBeNull();
  fireEvent.click(form.getByRole("button", { name: "Add model" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(writes[0]?.body.model).toMatchObject({ supports_images: false, supports_audio: true });
  expect(writes[0]?.body).toHaveProperty("provider_connection_id", "connection-1");
  expect(JSON.stringify(writes[0]?.body)).not.toMatch(/api_key|base_url/);
});

it("preserves revision flags through a rejected publication and identical retry", async () => {
  const writes = mockModels(true);
  const form = await openEditor(true);
  expect((form.getByRole("checkbox", { name: "Audio input" }) as HTMLInputElement).checked).toBe(true);
  expect((form.getByRole("checkbox", { name: "PDF input" }) as HTMLInputElement).checked).toBe(true);
  fireEvent.click(form.getByRole("button", { name: "Publish revision" }));
  await form.findByRole("alert");
  expect((form.getByRole("checkbox", { name: "Audio input" }) as HTMLInputElement).checked).toBe(true);
  fireEvent.click(form.getByRole("button", { name: "Publish revision" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual(writes[0]);
  expect(writes[1]?.body.model).toMatchObject({ supports_audio: true, supports_pdf: true });
  expect(screen.getByText("Text, Audio, PDF")).toBeTruthy();
  expect(JSON.stringify({ ...sessionStorage })).not.toContain("native-replacement");
});

it("explicitly clears native flags in a new revision", async () => {
  const writes = mockModels();
  const form = await openEditor(true);
  fireEvent.click(form.getByRole("checkbox", { name: "Audio input" }));
  fireEvent.click(form.getByRole("checkbox", { name: "PDF input" }));
  fireEvent.click(form.getByRole("button", { name: "Publish revision" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(writes[0]?.body.model).toMatchObject({ supports_audio: false, supports_pdf: false });
  expect(screen.getByText("Text")).toBeTruthy();
});

it("prefills builtin capabilities and keeps API identity immutable in revisions", async () => {
  const writes = mockModels();
  const form = await openEditor();
  expect(form.getByRole("checkbox", { name: "PDF input", hidden: true }).matches(":checked")).toBe(true);
  fireEvent.click(form.getByText("Model settings"));
  fireEvent.click(form.getByRole("checkbox", { name: "PDF input" }));
  fireEvent.click(form.getByRole("button", { name: "Add model" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(writes[0]?.body.model).toMatchObject({ model: "known", supports_pdf: false });
  cleanup();
  const revision = await openEditor(true);
  expect((revision.getByLabelText("Model ID") as HTMLInputElement).readOnly).toBe(true);
  expect(revision.queryByLabelText("Provider")).toBeNull();
  expect(revision.queryByLabelText("API endpoint")).toBeNull();
});

it("reads native capabilities from an immutable revision instead of current catalog metadata", async () => {
  mockModels(false, { ...profile, model: { ...profile.model, base_url: "https://known.test/v1", model: "known" } });
  render(<ModelsPage modelID="native" revisionID="native-1" />);
  expect(await screen.findByText("Text, Audio, PDF")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Create revision" })).toBeNull();
});

it("treats omitted native capabilities as disabled when editing a custom profile", async () => {
  const { supports_audio: _audio, supports_pdf: _pdf, ...model } = profile.model;
  mockModels(false, { ...profile, model });
  const form = await openEditor(true);
  expect((form.getByRole("checkbox", { name: "Audio input" }) as HTMLInputElement).checked).toBe(false);
  expect((form.getByRole("checkbox", { name: "PDF input" }) as HTMLInputElement).checked).toBe(false);
});

it("does not reset saved builtin metadata to newer defaults when publishing", async () => {
  const stored = { ...profile, model: { ...profile.model, base_url: "https://known.test/v1", model: "known",
    context_window: 4096, max_output_tokens: 512, temperature: 0.3 } };
  const writes = mockModels(false, stored);
  const form = await openEditor(true);
  fireEvent.click(form.getByRole("button", { name: "Publish revision" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  const { base_url: _endpoint, ...parameters } = stored.model;
  expect(writes[0]?.body.model).toEqual(parameters);
});
