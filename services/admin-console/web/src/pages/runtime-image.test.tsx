import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentTemplate, ModelProfile } from "../lib/types";
import { TemplatesPage } from "./templates";

afterEach(() => { cleanup(); sessionStorage.clear(); });

const model: ModelProfile = {
  provider_connection_id: "connection-1", model_profile_id: "model-1", display_name: "Support model",
  revision_id: "model-revision-1", revision: 1, enabled: true,
  model: { base_url: "https://models.example.com/v1", model: "support", context_window: 8192, max_output_tokens: 1024, supports_images: false },
  created_at: "2026-09-07T00:00:00Z", updated_at: "2026-09-07T00:00:00Z",
};
const template: AgentTemplate = {
  template_id: "template-1", name: "Support template", revision: 1,
  model_profile_id: model.model_profile_id, system_prompt: "", max_model_requests: 32,
  context_policy_version: "context-v1", enabled: true, skill_refs: [],
  runtime: {
    image_ref: `sha256:${"a".repeat(64)}`,
    image_source: "antnest/runtime:local",
    resources: { memory_bytes: 1024, pids_limit: 128, tmpfs_bytes: 1024 },
  },
  created_at: model.created_at, updated_at: model.updated_at,
};

function mockCatalog(defaultImage: string, reject = false) {
  const writes: unknown[] = [];
  const fetch = vi.fn(async (input: string, init: RequestInit) => {
    const url = new URL(input, "http://localhost");
    if (init.method === "POST") {
      writes.push(JSON.parse(String(init.body)));
      if (reject) return Response.json({ code: "runtime_image_invalid", message: "Select an installed repository:tag image." }, { status: 400 });
      return Response.json({ ...template, revision: 2 }, { status: 201 });
    }
    switch (url.pathname) {
      case "/api/admin/templates": return Response.json({ items: [template] });
      case "/api/admin/templates/template-1": return Response.json(template);
      case "/api/admin/model-profiles": return Response.json({ items: [model] });
      case "/api/admin/model-profiles/model-1": return Response.json(model);
      case "/api/admin/template-defaults": return Response.json({ runtime_image_ref: defaultImage });
      default: throw new Error(`Unexpected request: ${url.pathname}`);
    }
  });
  vi.stubGlobal("fetch", fetch);
  return { fetch, writes };
}

describe("Runtime image presentation", () => {
  it("creates using the platform default without asking for or posting a digest", async () => {
    const { writes } = mockCatalog(template.runtime.image_ref);
    render(<TemplatesPage />);
    const create = await screen.findByRole("button", { name: "Create template" });
    await waitFor(() => expect((create as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(create);
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.queryByLabelText("Image tag")).toBeNull();
    expect(dialog.getByText("Platform runtime")).toBeTruthy();
    expect(screen.queryByText(/sha256:/)).toBeNull();
    fireEvent.change(dialog.getByLabelText("Template name"), { target: { value: "Support template" } });
    fireEvent.change(dialog.getByLabelText("Model"), { target: { value: model.model_profile_id } });
    fireEvent.click(dialog.getByRole("button", { name: "Create template" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).not.toHaveProperty("runtime");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("allows an explicit tag when the platform default is missing", async () => {
    const { writes } = mockCatalog("");
    render(<TemplatesPage />);
    const create = await screen.findByRole("button", { name: "Create template" });
    await waitFor(() => expect((create as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(create);
    const dialog = within(await screen.findByRole("dialog"));
    fireEvent.change(dialog.getByLabelText("Template name"), { target: { value: "Support template" } });
    fireEvent.change(dialog.getByLabelText("Model"), { target: { value: model.model_profile_id } });
    fireEvent.change(dialog.getByLabelText("Image tag"), { target: { value: "registry.example:5000/runtime:v2" } });
    fireEvent.click(dialog.getByRole("button", { name: "Create template" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toHaveProperty("runtime", { image_ref: "registry.example:5000/runtime:v2" });
  });

  it.each(["", `sha256:${"b".repeat(64)}`])("keeps the pinned image on revision with deployment default %s", async (defaultImage) => {
    const { fetch, writes } = mockCatalog(defaultImage);
    render(<TemplatesPage templateID={template.template_id} />);
    fireEvent.click(await screen.findByRole("button", { name: "Create revision" }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.queryByLabelText("Image tag")).toBeNull();
    expect(dialog.getByText("antnest/runtime:local")).toBeTruthy();
    expect(screen.queryByText(/sha256:/)).toBeNull();
    fireEvent.click(dialog.getByRole("button", { name: "Publish revision" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toHaveProperty("runtime", { image_ref: template.runtime.image_ref, resources: template.runtime.resources, mcp_servers: [] });
    expect(fetch.mock.calls.some(([url]) => url.includes("template-defaults"))).toBe(false);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("explicitly reselects a tag without posting its prior pin or server source", async () => {
    const { writes } = mockCatalog("");
    render(<TemplatesPage templateID={template.template_id} />);
    fireEvent.click(await screen.findByRole("button", { name: "Create revision" }));
    const dialog = within(await screen.findByRole("dialog"));
    fireEvent.change(dialog.getByLabelText("Runtime image"), { target: { value: "custom" } });
    expect((dialog.getByLabelText("Image tag") as HTMLInputElement).value).toBe("antnest/runtime:local");
    fireEvent.click(dialog.getByRole("button", { name: "Publish revision" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toHaveProperty("runtime", { image_ref: "antnest/runtime:local", resources: template.runtime.resources, mcp_servers: [] });
  });

  it("keeps a rejected tag selection open for correction", async () => {
    const { writes } = mockCatalog("", true);
    render(<TemplatesPage templateID={template.template_id} />);
    fireEvent.click(await screen.findByRole("button", { name: "Create revision" }));
    const dialog = within(await screen.findByRole("dialog"));
    fireEvent.change(dialog.getByLabelText("Runtime image"), { target: { value: "custom" } });
    fireEvent.change(dialog.getByLabelText("Image tag"), { target: { value: "runtime:missing" } });
    fireEvent.click(dialog.getByRole("button", { name: "Publish revision" }));
    await screen.findByText("Select an installed repository:tag image.");
    expect((dialog.getByLabelText("Image tag") as HTMLInputElement).value).toBe("runtime:missing");
    expect((dialog.getByRole("button", { name: "Publish revision" }) as HTMLButtonElement).disabled).toBe(false);
    expect(writes).toHaveLength(1);
  });
});
