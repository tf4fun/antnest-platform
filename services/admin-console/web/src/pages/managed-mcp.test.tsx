import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentTemplate, ManagedMCPServer } from "../lib/types";
import { TemplatesPage } from "./templates";

afterEach(() => { cleanup(); sessionStorage.clear(); });

const server: ManagedMCPServer = { id: "documents", command: "node", args: ["server.js", "two words", ""], env: { TOKEN: "synthetic-token", EMPTY: "" } };
const template: AgentTemplate = {
  template_id: "template-1", revision: 1, name: "Support template", enabled: true,
  model_profile_id: "model-1", system_prompt: "", max_model_requests: 32,
  context_policy_version: "context-v1", skill_refs: [], created_at: "2026-09-07T00:00:00Z", updated_at: "2026-09-07T00:00:00Z",
  runtime: { image_ref: "runtime:local", resources: { memory_bytes: 1024, pids_limit: 128, tmpfs_bytes: 1024 }, mcp_servers: [server] },
};

function catalog(rejectFirst = false) {
  const writes: Array<{ runtime: { mcp_servers: ManagedMCPServer[] } }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit) => {
    const path = new URL(input, "http://localhost").pathname;
    if (init.method === "POST") {
      const body = JSON.parse(String(init.body));
      writes.push(body);
      if (rejectFirst && writes.length === 1) return Response.json({ code: "invalid_config", message: "Correct the MCP command." }, { status: 400 });
      return Response.json({ ...template, ...body, revision: 2 }, { status: 201 });
    }
    if (path === "/api/admin/templates") return Response.json({ items: [template] });
    if (path.startsWith("/api/admin/templates/")) return Response.json(template);
    if (path === "/api/admin/template-defaults") return Response.json({ runtime_image_ref: "runtime:local" });
    const model = { model_profile_id: "model-1", revision_id: "model-rev-1", revision: 1, display_name: "Support model", enabled: true, model: { model: "support" } };
    if (path === "/api/admin/model-profiles") return Response.json({ items: [model] });
    if (path.startsWith("/api/admin/model-profiles/")) return Response.json(model);
    throw new Error(`Unexpected request: ${path}`);
  }));
  return writes;
}

describe("Managed MCP template configuration", () => {
  it("creates structured stdio configuration with the platform image", async () => {
    const writes = catalog();
    render(<TemplatesPage />);
    const create = await screen.findByRole("button", { name: "Create template" });
    await waitFor(() => expect((create as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(create);
    const dialog = within(await screen.findByRole("dialog"));
    fireEvent.change(dialog.getByLabelText("Template name"), { target: { value: "New template" } });
    fireEvent.change(dialog.getByLabelText("Model"), { target: { value: "model-1" } });
    fireEvent.click(dialog.getByRole("button", { name: "Add MCP server" }));
    fireEvent.change(dialog.getByLabelText("Server ID"), { target: { value: "documents" } });
    fireEvent.change(dialog.getByLabelText("Command"), { target: { value: "node" } });
    fireEvent.click(dialog.getByRole("button", { name: "Add argument" }));
    fireEvent.change(dialog.getByLabelText("Argument 1"), { target: { value: "two words" } });
    fireEvent.click(dialog.getByRole("button", { name: "Add environment variable" }));
    fireEvent.change(dialog.getByLabelText("Variable 1 name"), { target: { value: "TOKEN" } });
    expect((dialog.getByLabelText("Variable 1 value") as HTMLInputElement).type).toBe("password");
    fireEvent.click(dialog.getByRole("button", { name: "Show Variable 1 value" }));
    fireEvent.change(dialog.getByLabelText("Variable 1 value"), { target: { value: "synthetic-token" } });
    fireEvent.click(dialog.getByRole("button", { name: "Create template" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!.runtime).toEqual({ mcp_servers: [{ id: "documents", command: "node", args: ["two words"], env: { TOKEN: "synthetic-token" } }] });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("preserves arguments and masked environment on edits and rejected retries", async () => {
    const writes = catalog(true);
    render(<TemplatesPage templateID="template-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Create revision" }));
    const dialog = within(await screen.findByRole("dialog"));
    fireEvent.change(dialog.getByLabelText("Template name"), { target: { value: "Renamed template" } });
    fireEvent.click(dialog.getByRole("button", { name: "Publish revision" }));
    await screen.findByText("Correct the MCP command.");
    fireEvent.click(dialog.getByRole("button", { name: "Show Variable 1 value" }));
    expect((dialog.getByLabelText("Variable 1 value") as HTMLTextAreaElement).value).toBe("synthetic-token");
    expect(writes[0]!.runtime.mcp_servers).toEqual([server]);
    fireEvent.click(dialog.getByRole("button", { name: "Publish revision" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(writes[1]!.runtime.mcp_servers).toEqual([server]);
  });

  it("explicitly clears all servers on a new revision", async () => {
    const writes = catalog();
    render(<TemplatesPage templateID="template-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Create revision" }));
    const dialog = within(await screen.findByRole("dialog"));
    fireEvent.click(dialog.getByRole("button", { name: "Remove MCP server 1" }));
    fireEvent.click(dialog.getByRole("button", { name: "Publish revision" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!.runtime.mcp_servers).toEqual([]);
  });

  it("rejects duplicate server IDs before sending a revision", async () => {
    const writes = catalog();
    render(<TemplatesPage templateID="template-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Create revision" }));
    const dialog = within(await screen.findByRole("dialog"));
    fireEvent.click(dialog.getByRole("button", { name: "Add MCP server" }));
    fireEvent.change(dialog.getAllByLabelText("Server ID")[1]!, { target: { value: "documents" } });
    fireEvent.change(dialog.getAllByLabelText("Command")[1]!, { target: { value: "python" } });
    fireEvent.click(dialog.getByRole("button", { name: "Publish revision" }));
    await screen.findByText("Duplicate server ID: documents");
    expect(writes).toHaveLength(0);
    fireEvent.click(dialog.getByRole("button", { name: "Show Variable 1 value" }));
    expect((dialog.getByLabelText("Variable 1 value") as HTMLTextAreaElement).value).toBe("synthetic-token");
  });

  it("locks the pending form and keeps environment values out of browser storage", async () => {
    catalog();
    const persist = vi.fn();
    vi.stubGlobal("localStorage", { setItem: persist });
    const read = globalThis.fetch;
    let finish!: (response: Response) => void;
    let posted = 0;
    vi.stubGlobal("fetch", vi.fn((input: string, init: RequestInit) => {
      if (init.method !== "POST") return read(input, init);
      posted++;
      return new Promise<Response>((resolve) => { finish = resolve; });
    }));
    render(<TemplatesPage templateID="template-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Create revision" }));
    const dialog = within(await screen.findByRole("dialog"));
    fireEvent.click(dialog.getByRole("button", { name: "Publish revision" }));
    await waitFor(() => expect(posted).toBe(1));
    expect(dialog.getByLabelText("Command").matches(":disabled")).toBe(true);
    expect((dialog.getByRole("button", { name: "Publish revision" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(dialog.getByRole("button", { name: "Publish revision" }));
    expect(posted).toBe(1);
    expect(JSON.stringify(sessionStorage)).not.toContain("synthetic-token");
    expect(persist).not.toHaveBeenCalled();
    finish(Response.json({ ...template, revision: 2 }, { status: 201 }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("keeps historical configuration read-only and masks environment values", async () => {
    catalog();
    render(<TemplatesPage templateID="template-1" revisionID="1" />);
    expect(await screen.findByText("documents")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create revision" })).toBeNull();
    expect(screen.queryByText("synthetic-token")).toBeNull();
    const value = screen.getByLabelText("TOKEN value") as HTMLInputElement;
    expect(value.type).toBe("password");
    expect(value.readOnly).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Show TOKEN value" }));
    expect((screen.getByLabelText("TOKEN value") as HTMLTextAreaElement).value).toBe("synthetic-token");
  });

  it.each(["\n", "\r\n", "\r"])("preserves multiline argument/environment edits with %j endings", async (newline) => {
    const writes = catalog();
    const read = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn((input: string, init: RequestInit) => {
      if (init.method === "GET" && input === "/api/admin/templates/template-1") return Promise.resolve(Response.json({
        ...template, runtime: { ...template.runtime, mcp_servers: [{ ...server, args: [`a${newline}b`], env: { CERT: `a${newline}b` } }] },
      }));
      return read(input, init);
    }));
    render(<TemplatesPage templateID="template-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Create revision" }));
    const dialog = within(await screen.findByRole("dialog"));
    const argument = dialog.getByLabelText("Argument 1") as HTMLTextAreaElement;
    expect(argument.value).toBe("a\nb");
    expect(argument.rows).toBe(2);
    fireEvent.change(argument, { target: { value: argument.value + "c" } });
    fireEvent.click(dialog.getByRole("button", { name: "Show Variable 1 value" }));
    const env = dialog.getByLabelText("Variable 1 value") as HTMLTextAreaElement;
    fireEvent.change(env, { target: { value: env.value + "c" } });
    fireEvent.click(dialog.getByRole("button", { name: "Publish revision" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!.runtime.mcp_servers[0]).toEqual({ ...server, args: [`a${newline}bc`], env: { CERT: `a${newline}bc` } });
  });
});
