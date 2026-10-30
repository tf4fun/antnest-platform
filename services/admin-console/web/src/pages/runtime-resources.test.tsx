import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentTemplate, ModelProfile } from "../lib/types";
import { TemplatesPage } from "./templates";

afterEach(() => { cleanup(); sessionStorage.clear(); });

const model: ModelProfile = {
  provider_connection_id: "connection-1", model_profile_id: "model-1", display_name: "Support model", revision_id: "model-revision-1", revision: 1, enabled: true,
  model: { base_url: "https://models.example.com/v1", model: "support", context_window: 8192, max_output_tokens: 1024, supports_images: false },
  created_at: "2026-09-07T00:00:00Z", updated_at: "2026-09-07T00:00:00Z",
};

const baseResources = { memory_bytes: 1073741824, pids_limit: 256, tmpfs_bytes: 268435456 };
const boundedResources = { ...baseResources, cpu_millis: 2500, workspace_bytes: 67108864 };

const templateWithLimits: AgentTemplate = {
  template_id: "template-1", name: "Support template", revision: 1, enabled: true,
  model_profile_id: model.model_profile_id, system_prompt: "Original instructions", max_model_requests: 32,
  context_policy_version: "context-v1", skill_refs: [],
  runtime: { image_ref: `sha256:${"a".repeat(64)}`, resources: boundedResources },
  created_at: model.created_at, updated_at: model.updated_at,
};

const templateLegacy: AgentTemplate = {
  ...templateWithLimits,
  runtime: { image_ref: templateWithLimits.runtime.image_ref, resources: baseResources },
};

type RecordedRequest = { method: string; path: string; body: string };

function mockConsole(template: AgentTemplate) {
  const requests: RecordedRequest[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit) => {
    const request = { method: init.method ?? "GET", path: new URL(input, "http://localhost").pathname, body: String(init.body ?? "") };
    requests.push(request);
    if (request.method === "POST" && request.path.endsWith("/revisions")) {
      return Response.json({ ...template, revision: 2 });
    }
    if (request.method !== "GET") throw new Error(`Unexpected mutation: ${request.path}`);
    switch (request.path) {
      case "/api/admin/templates/template-1":
      case "/api/admin/templates/template-1/revisions/1":
        return Response.json(template);
      case "/api/admin/model-profiles/model-1":
        return Response.json(model);
      case "/api/admin/skills":
        return Response.json({ items: [], next_after_id: null });
      default:
        return Response.json({}, { status: 404 });
    }
  }));
  return requests;
}

describe("Runtime resource limits", () => {
  it("displays explicit CPU and workspace facts without claiming enforcement", async () => {
    mockConsole(templateWithLimits);
    render(<TemplatesPage templateID="template-1" />);
    expect(await screen.findByText("2500 mCPU")).toBeTruthy();
    expect(screen.getByText("Workspace request")).toBeTruthy();
    expect(screen.getByText(/64(\.\d+)? ?M(i)?B/)).toBeTruthy();
    expect(screen.getByText("Workspace enforcement depends on the Runtime Controller storage backend.")).toBeTruthy();
  });

  it("shows contract defaults for a legacy template without claiming a quota", async () => {
    mockConsole(templateLegacy);
    render(<TemplatesPage templateID="template-1" />);
    expect(await screen.findByText("1000 mCPU")).toBeTruthy();
    expect(screen.getByText("Workspace request")).toBeTruthy();
    expect(screen.getByText(/10(\.\d+)? ?G(i)?B/)).toBeTruthy();
    expect(screen.getByText("Workspace enforcement depends on the Runtime Controller storage backend.")).toBeTruthy();
  });

  it("preserves resource fields when publishing a revision", async () => {
    const requests = mockConsole(templateWithLimits);
    render(<TemplatesPage templateID="template-1" />);
    const edit = await screen.findByRole("button", { name: /create revision/i });
    fireEvent.click(edit);
    const publish = await screen.findByRole("button", { name: /publish revision/i });
    fireEvent.click(publish);
    await waitFor(() => {
      const post = requests.find((request) => request.method === "POST" && request.path.endsWith("/revisions"));
      expect(post).toBeTruthy();
    });
    const post = requests.find((request) => request.method === "POST" && request.path.endsWith("/revisions"))!;
    const body = JSON.parse(post.body);
    expect(body.runtime.resources.cpu_millis).toBe(2500);
    expect(body.runtime.resources.workspace_bytes).toBe(67108864);
    expect(body.runtime.resources.memory_bytes).toBe(1073741824);
  });
});
