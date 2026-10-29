import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TemplatesPage } from "./templates";
import { TemplateModelPolicyEditor, ModelCallPolicyDetails } from "../components/model-call-policy";
import type { AgentTemplate } from "../lib/types";

const model = {
  model_profile_id: "model-1",
  provider_connection_id: "connection-1",
  display_name: "GPT-4o",
  revision: 2,
  context_policy_version: "v1",
  model: { model: "gpt-4o", base_url: "", options: {} },
  enabled: true,
  created_at: "t",
  updated_at: "t",
};

const baseTemplate: AgentTemplate = {
  template_id: "template-1",
  name: "Existing",
  revision: 2,
  model_profile_id: "model-1",
  system_prompt: "",
  max_model_requests: 4,
  context_policy_version: "v1",
  runtime: {
    image_ref: "runtime:latest",
    resources: { memory_bytes: 1, pids_limit: 1, tmpfs_bytes: 1 },
  },
  skill_refs: [],
  enabled: true,
  created_at: "t",
  updated_at: "t",
};

function stub(handlers: (path: string, init: RequestInit) => Response | undefined) {
  const calls: { path: string; method: string; body?: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit = {}) => {
    const path = new URL(input, "http://localhost").pathname;
    const method = init.method ?? "GET";
    const response = handlers(path, init);
    if (!response) throw new Error(`unexpected ${method} ${path}`);
    if (method !== "GET") calls.push({ path, method, body: JSON.parse(String(init.body)) });
    return response;
  }));
  return calls;
}

const listStubs = (templates: AgentTemplate[] = []) => (path: string) => {
  if (path === "/api/admin/templates") return Response.json({ items: templates });
  if (path === "/api/admin/model-profiles") return Response.json({ items: [model] });
  if (path === "/api/admin/template-defaults") return Response.json({ runtime_image_ref: "runtime:latest" });
  return undefined;
};

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe("template model policy", () => {
  it("create forwards custom retry 0, never failover and zero budget", async () => {
    const calls = stub((path, init) => {
      if (path === "/api/admin/templates" && init.method === "POST") return Response.json(baseTemplate, { status: 200 });
      return listStubs()(path);
    });
    render(<TemplatesPage />);
    fireEvent.click((await screen.findAllByRole("button", { name: "Create template" }))[0]!);
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/Template name/), { target: { value: "Policy template" } });
    fireEvent.change(within(dialog).getByLabelText(/^Model$/), { target: { value: "model-1" } });
    fireEvent.change(within(dialog).getByLabelText(/Retry policy/), { target: { value: "custom" } });
    fireEvent.change(within(dialog).getByLabelText(/^Retries$/), { target: { value: "0" } });
    fireEvent.change(within(dialog).getByLabelText(/Failover/), { target: { value: "never" } });
    fireEvent.change(within(dialog).getByLabelText(/Input token limit/), { target: { value: "0" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create template" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")!.body).toMatchObject({
      model_retry: { max: 0, base_ms: 200, cap_ms: 30000 },
      failover: "never",
      run_budget: { max_input_tokens: 0 },
    });
  });

  it("create omits absent policy fields entirely", async () => {
    const calls = stub((path, init) => {
      if (path === "/api/admin/templates" && init.method === "POST") return Response.json(baseTemplate, { status: 200 });
      return listStubs()(path);
    });
    render(<TemplatesPage />);
    fireEvent.click((await screen.findAllByRole("button", { name: "Create template" }))[0]!);
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/Template name/), { target: { value: "Plain" } });
    fireEvent.change(within(dialog).getByLabelText(/^Model$/), { target: { value: "model-1" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create template" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    const body = calls.find((c) => c.method === "POST")!.body!;
    expect("model_retry" in body).toBe(false);
    expect("failover" in body).toBe(false);
    expect("run_budget" in body).toBe(false);
  });

  it("keeps the draft after a failed save and reports the error", async () => {
    stub((path, init) => {
      if (path === "/api/admin/templates" && init.method === "POST") {
        return Response.json({ code: "invalid_request", message: "rejected" }, { status: 400 });
      }
      return listStubs()(path);
    });
    render(<TemplatesPage />);
    fireEvent.click((await screen.findAllByRole("button", { name: "Create template" }))[0]!);
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/Template name/), { target: { value: "Draft kept" } });
    fireEvent.change(within(dialog).getByLabelText(/^Model$/), { target: { value: "model-1" } });
    fireEvent.change(within(dialog).getByLabelText(/Failover/), { target: { value: "before_output" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create template" }));
    await screen.findByText(/rejected/);
    expect((within(dialog).getByLabelText(/Template name/) as HTMLInputElement).value).toBe("Draft kept");
    expect((within(dialog).getByLabelText(/Failover/) as HTMLSelectElement).value).toBe("before_output");
  });

  it("details render stored overrides read-only and defaults otherwise", () => {
    const { rerender } = render(<ModelCallPolicyDetails policy={{}} />);
    expect(screen.getAllByText("Platform default").length).toBeGreaterThan(0);
    rerender(<ModelCallPolicyDetails policy={{
      model_retry: { max: 0, base_ms: 5, cap_ms: 9 },
      failover: "before_output",
      run_budget: { max_cost_usd_micros: 1500000 },
    }} />);
    expect(screen.getByText(/0 retries, 5–9 ms/)).toBeTruthy();
    expect(screen.getByText("before_output")).toBeTruthy();
    expect(screen.getByText(/\$1\.5/)).toBeTruthy();
  });

  it("revision dialog prefills the stored policy and forwards it unchanged", async () => {
    const stored = {
      ...baseTemplate,
      model_retry: { max: 0, base_ms: 1, cap_ms: 30000 },
      failover: "never" as const,
      run_budget: { max_input_tokens: 0 },
    };
    const calls = stub((path, init) => {
      if (path === `/api/admin/templates/${baseTemplate.template_id}`) return Response.json(stored);
      if (path === `/api/admin/templates/${baseTemplate.template_id}/revisions` && init.method === "POST") {
        return Response.json({ ...stored, revision: 3 });
      }
      if (path === "/api/admin/model-profiles") return Response.json({ items: [model] });
      if (path === `/api/admin/model-profiles/${model.model_profile_id}`) return Response.json(model);
      return listStubs()(path);
    });
    render(<TemplatesPage templateID="template-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Create revision" }));
    const dialog = await screen.findByRole("dialog");
    // The stored custom retry (0), never failover and zero budget must prefill.
    expect((within(dialog).getByLabelText(/Retry policy/) as HTMLSelectElement).value).toBe("custom");
    expect((within(dialog).getByLabelText(/^Retries$/) as HTMLInputElement).value).toBe("0");
    expect((within(dialog).getByLabelText(/Failover/) as HTMLSelectElement).value).toBe("never");
    expect((within(dialog).getByLabelText(/Input token limit/) as HTMLInputElement).value).toBe("0");
    fireEvent.click(within(dialog).getByRole("button", { name: /Publish revision/ }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/revisions"))).toBe(true));
    expect(calls.find((c) => c.method === "POST")!.body).toMatchObject({
      model_retry: { max: 0, base_ms: 1, cap_ms: 30000 },
      failover: "never",
      run_budget: { max_input_tokens: 0 },
    });
  });

  it("keeps the revision draft open after a transient failure", async () => {
    const stored = { ...baseTemplate, failover: "before_output" as const };
    stub((path, init) => {
      if (path === `/api/admin/templates/${baseTemplate.template_id}`) return Response.json(stored);
      if (path === `/api/admin/templates/${baseTemplate.template_id}/revisions` && init.method === "POST") {
        return new Response("unavailable", { status: 503 });
      }
      if (path === "/api/admin/model-profiles") return Response.json({ items: [model] });
      if (path === `/api/admin/model-profiles/${model.model_profile_id}`) return Response.json(model);
      return listStubs()(path);
    });
    render(<TemplatesPage templateID="template-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Create revision" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /Publish revision/ }));
    await screen.findByText(/unavailable|could not|failed/i);
    expect((within(dialog).getByLabelText(/Failover/) as HTMLSelectElement).value).toBe("before_output");
  });

  it("shows a historical revision read-only without a revise button", async () => {
    const historical = { ...baseTemplate, revision: 1, failover: "never" as const };
    stub((path) => {
      if (path === `/api/admin/templates/${baseTemplate.template_id}`) return Response.json(baseTemplate);
      if (path === `/api/admin/templates/${baseTemplate.template_id}/revisions/1`) return Response.json(historical);
      if (path === "/api/admin/model-profiles") return Response.json({ items: [model] });
      if (path === `/api/admin/model-profiles/${model.model_profile_id}`) return Response.json(model);
      return listStubs()(path);
    });
    render(<TemplatesPage templateID="template-1" revisionID="1" />);
    await screen.findByText("Model call policy");
    expect(screen.getByText("never")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create revision" })).toBeNull();
  });

  it("template detail shows the stored policy", async () => {
    const stored = { ...baseTemplate, failover: "never" as const, run_budget: { max_input_tokens: 42 } };
    stub((path) => {
      if (path === `/api/admin/templates/${baseTemplate.template_id}`) return Response.json(stored);
      if (path === "/api/admin/model-profiles") return Response.json({ items: [model] });
      if (path === `/api/admin/model-profiles/${model.model_profile_id}`) return Response.json(model);
      return listStubs()(path);
    });
    render(<TemplatesPage templateID="template-1" />);
    await screen.findByText("Model call policy");
    expect(screen.getByText("never")).toBeTruthy();
    expect(screen.getByText(/max_input_tokens: 42/)).toBeTruthy();
  });
});
