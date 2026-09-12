import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelCatalog, ModelProfile } from "../lib/types";
import { ModelsPage } from "./models";
import { TemplatesPage } from "./templates";

afterEach(() => { cleanup(); sessionStorage.clear(); });

const model: ModelProfile = {
  provider_connection_id: "connection-1", model_profile_id: "model-1", display_name: "Support model",
  revision_id: "model-revision-1", revision: 1, enabled: true,
  model: { base_url: "https://models.example.com/v1", model: "support", context_window: 8192, max_output_tokens: 1024, supports_images: false },
  created_at: "2026-09-07T00:00:00Z", updated_at: "2026-09-07T00:00:00Z",
};
const catalog: ModelCatalog = {
  revision: "test-catalog",
  providers: [{ provider_key: "support", display_name: "Support models", description: "", base_url: model.model.base_url, custom: false,
    models: [{ model_id: "support", display_name: "Support model", context_window: 8192, max_output_tokens: 1024, supports_images: false }] }],
};
const template = {
  template_id: "template-1", name: "Support template",
  revision: 1, model_profile_id: model.model_profile_id, system_prompt: "", max_model_requests: 32,
  context_policy_version: "context-v1", enabled: true, skill_refs: [],
  runtime: { image_ref: `sha256:${"a".repeat(64)}`, resources: {memory_bytes: 1024, pids_limit: 128, tmpfs_bytes: 1024} },
  created_at: model.created_at, updated_at: model.updated_at,
};
const workflows = [
  { name: "model", component: <ModelsPage />, path: "/api/admin/provider-connections", key: "profile_key",
    open: "Add provider", dialog: "Connect model provider", submit: "Connect provider", result: { connection_id: "connection-1", provider_key: "support", display_name: "Support models", base_url: model.model.base_url, credential_method: "api_key", credential_version: "v1", credential_revision: 1, enabled: true } },
  { name: "template", component: <TemplatesPage />, path: "/api/admin/templates", key: "template_key",
    open: "Create template", dialog: "Create template", submit: "Create template", result: template },
];

function fillForm(name: string) {
  if (name === "model") {
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "test-provider-secret" } });
  } else {
    fireEvent.change(screen.getByLabelText("Template name"), { target: { value: "Support template" } });
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: model.model_profile_id } });
  }
}

describe.each(workflows)("$name creation retry", (workflow) => {
  it.each(["lost response", "503"])("replays one creation after %s and acknowledges success", async (failure) => {
    const sent: Array<{ body: string; key: string | null }> = [];
    let committed = false;
    let time = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => time);
    vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit) => {
      const url = new URL(input, "http://localhost");
      if (init.method === "POST" && url.pathname === workflow.path) {
        sent.push({body: String(init.body), key: new Headers(init.headers).get("Idempotency-Key")});
        committed = true;
        if (sent.length === 1) {
          if (failure === "lost response") throw new TypeError("Response lost after commit");
          return Response.json({message: "Response unavailable"}, {status: 503});
        }
        return Response.json(workflow.result, {status: 201});
      }
      if (url.pathname === "/api/admin/provider-connections") return Response.json({items: []});
      if (url.pathname === "/api/admin/model-catalog") return Response.json(catalog);
      if (url.pathname === "/api/admin/model-profiles") return Response.json({items: [model]});
      if (url.pathname === "/api/admin/templates") return Response.json({items: committed ? [template] : []});
      if (url.pathname === "/api/admin/template-defaults") return Response.json({runtime_image_ref: template.runtime.image_ref});
      throw new Error(`Unexpected request: ${init.method} ${url.pathname}`);
    }));

    render(workflow.component);
    await waitFor(() => {
      const button = screen.getAllByRole("button", {name: workflow.open})[0] as HTMLButtonElement;
      expect(button.disabled).toBe(false);
    });
    fireEvent.click(screen.getAllByRole("button", {name: workflow.open})[0]!);
    let dialog = within(await screen.findByRole("dialog", {name: workflow.dialog}));
    fillForm(workflow.name);
    fireEvent.click(dialog.getByRole("button", {name: workflow.submit}));
    await dialog.findByRole("alert");
    expect(screen.queryByText(/ connected\.|Support template created\./)).toBeNull();

    time += 60_000;
    fireEvent.click(dialog.getByRole("button", {name: workflow.submit}));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("status").textContent).toMatch(/connected\.|created\./);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    expect(JSON.parse(sent[0]!.body)).not.toHaveProperty(workflow.key);
    if (workflow.name === "template") {
      expect(JSON.parse(sent[0]!.body)).toHaveProperty("model_profile_id", model.model_profile_id);
      expect(JSON.parse(sent[0]!.body)).not.toHaveProperty("model_profile_revision_id");
    }
    expect(JSON.stringify({...sessionStorage})).not.toContain("test-provider-secret");

    fireEvent.click(screen.getByRole("button", {name: "Dismiss success message"}));
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.click(screen.getAllByRole("button", {name: workflow.open})[0]!);
    dialog = within(await screen.findByRole("dialog", {name: workflow.dialog}));
    fillForm(workflow.name);
    fireEvent.click(dialog.getByRole("button", {name: workflow.submit}));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(sent).toHaveLength(3);
    expect(sent[2]!.key).not.toBe(sent[1]!.key);
    expect(sent[2]!.body).toBe(sent[1]!.body);
  });
});
