import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent, AgentTemplate, ModelProfile, ProviderConnection } from "../lib/types";
import { AgentsPage } from "./agents";
import { ModelsPage } from "./models";
import { TemplatesPage } from "./templates";

afterEach(cleanup);

const timestamps = { created_at: "2026-09-07T00:00:00Z", updated_at: "2026-09-07T00:00:00Z" };
const model = (id: string): ModelProfile => ({
  ...timestamps, provider_connection_id: "connection-1", model_profile_id: id, display_name: id, revision_id: `${id}-revision`, revision: 1, enabled: true,
  model: { base_url: "https://models.example.com/v1", model: id, context_window: 8192, max_output_tokens: 1024, supports_images: false },
});
const provider = (id: string): ProviderConnection => ({ ...timestamps, connection_id: id, display_name: id, provider_key: "deepseek", base_url: "https://api.deepseek.com", credential_method: "api_key", credential_version: "v1", credential_revision: 1, enabled: true });
const template = (id: string): AgentTemplate => ({
  ...timestamps, template_id: id, name: id, revision: 1, model_profile_id: "model", enabled: true,
  system_prompt: "", max_model_requests: 32, context_policy_version: "context-v1", skill_refs: [],
  runtime: { image_ref: `sha256:${"a".repeat(64)}`, resources: { memory_bytes: 1024, pids_limit: 128, tmpfs_bytes: 1024 } },
});
const agent = (id: string, view: string): Agent => ({
  ...timestamps, agent_id: id, name: id, owner_user_id: "owner", aggregate_sequence: 1,
  desired_state: view === "deleted" ? "deleted" : "enabled", lifecycle_state: view === "deleted" ? "deleted" : "created",
  activation_state: view === "deleted" ? undefined : "enabled", runtime_state: view === "deleted" ? "absent" : "available",
});
const inventories = [
  { name: "Providers", component: <ModelsPage />, path: "/api/admin/provider-connections", cursor: "after_id", next: "next_after_id", row: provider, list: "Model providers", view: "" },
  { name: "Templates", component: <TemplatesPage />, path: "/api/admin/templates", cursor: "after_id", next: "next_after_id", row: template, list: "Agent templates", view: "" },
  ...["current", "deleted"].map((view) => ({
    name: `${view} Agents`, component: <AgentsPage />, path: "/api/admin/agents", cursor: "cursor", next: "next_cursor",
    row: (id: string) => agent(id, view), list: view === "deleted" ? "Deleted Agents" : "Current Agents", view,
  })),
];
type Inventory = typeof inventories[number];

function mockInventory(inventory: Inventory, page: (url: URL) => Response | Promise<Response>) {
  const requests: URL[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const url = new URL(input, "http://localhost");
    if (url.pathname === inventory.path && (!inventory.view || url.searchParams.get("view") === inventory.view)) {
      requests.push(url);
      return page(url);
    }
    switch (url.pathname) {
      case "/api/admin/model-catalog": return Response.json({ revision: "test", providers: [] });
      case "/api/admin/model-profiles": return Response.json({ items: [model("model")] });
      case "/api/admin/templates": return Response.json({ items: [template("template")] });
      case "/api/admin/template-defaults": return Response.json({ runtime_image_ref: template("template").runtime.image_ref });
      case "/api/admin/directory": return Response.json({ users: [], groups: [] });
      case "/api/admin/agents": return Response.json({ items: [agent("other-view-agent", url.searchParams.get("view") ?? "current")] });
      default: throw new Error(`Unexpected request: ${url}`);
    }
  }));
  return requests;
}

async function openInventory(inventory: Inventory) {
  render(inventory.component);
  if (inventory.view === "deleted") fireEvent.click(await screen.findByRole("tab", { name: "Deleted" }));
  await screen.findByRole("list", { name: inventory.list });
}

function rows(inventory: Inventory) {
  return within(screen.getByRole("list", { name: inventory.list })).getAllByRole("listitem");
}

describe.each(inventories)("$name inventory pagination", (inventory) => {
  it.each([403, 404, 410])("retains loaded records and stops traversal after %i", async (status) => {
    const requests = mockInventory(inventory, (url) => url.searchParams.has(inventory.cursor)
      ? Response.json({ message: "This page is not available" }, { status })
      : Response.json({ items: [inventory.row("first")], [inventory.next]: "page-two" }));
    await openInventory(inventory);
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await screen.findByText("This page is not available");
    expect(rows(inventory)).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    expect(requests).toHaveLength(2);
    if (inventory.view) {
      fireEvent.click(screen.getByRole("tab", { name: inventory.view === "current" ? "Deleted" : "Current" }));
      await screen.findByRole("list", { name: inventory.view === "current" ? "Deleted Agents" : "Current Agents" });
      expect(screen.queryByText("This page is not available")).toBeNull();
      fireEvent.click(screen.getByRole("tab", { name: inventory.view === "current" ? "Current" : "Deleted" }));
      expect(screen.getByText("This page is not available")).toBeTruthy();
      expect(requests).toHaveLength(2);
    }
  });

  it("retries only its failed cursor, prevents duplicate requests, and merges the recovered page", async () => {
    let respond!: (response: Response) => void;
    const retry = new Promise<Response>((resolve) => { respond = resolve; });
    let attempts = 0;
    const requests = mockInventory(inventory, (url) => {
      if (!url.searchParams.has(inventory.cursor)) return Response.json({ items: [inventory.row("first")], [inventory.next]: "page-two" });
      return ++attempts === 1 ? Response.json({ message: "Page temporarily unavailable" }, { status: 503 }) : retry;
    });
    await openInventory(inventory);
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    const pending = screen.getByRole("button", { name: "Load more" }) as HTMLButtonElement;
    expect(pending.disabled).toBe(true);
    expect(pending.getAttribute("aria-busy")).toBe("true");
    fireEvent.click(pending);
    expect(rows(inventory)).toHaveLength(1);
    expect(requests).toHaveLength(3);
    expect(requests[2]!.toString()).toBe(requests[1]!.toString());
    await act(async () => { respond(Response.json({ items: [inventory.row("first"), inventory.row("second")] })); });
    await waitFor(() => expect(rows(inventory)).toHaveLength(2));
    expect(screen.queryByRole("button", { name: /Load more|Retry/ })).toBeNull();
    expect(screen.queryByText("Page temporarily unavailable")).toBeNull();
  });
});

describe("Deleted Agent initial read", () => {
  it.each([403, 404, 410, 503])("does not automatically repeat a failed %i read or erase the current Fleet", async (status) => {
    const inventory = inventories.find((item) => item.view === "deleted")!;
    let respond!: (response: Response) => void;
    const first = new Promise<Response>((resolve) => { respond = resolve; });
    let attempts = 0;
    // Hold an unexpected second request so the regression cannot spin a test loop.
    const requests = mockInventory(inventory, () => ++attempts === 1 ? first : new Promise<Response>(() => {}));
    render(<AgentsPage />);
    fireEvent.click(await screen.findByRole("tab", { name: "Deleted" }));
    await act(async () => { respond(Response.json({ message: "Deleted records unavailable" }, { status })); });
    expect(requests).toHaveLength(1);
    expect(screen.getByText("Deleted records unavailable")).toBeTruthy();
    expect(Boolean(screen.queryByRole("button", { name: "Retry deleted records" }))).toBe(status === 503);
    expect(screen.queryByText("No deleted Agents")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Current" }));
    expect(screen.getByRole("list", { name: "Current Agents" })).toBeTruthy();
    expect(screen.queryByText("Deleted records unavailable")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Deleted" }));
    expect(screen.getByText("Deleted records unavailable")).toBeTruthy();
    expect(requests).toHaveLength(1);
  });

  it("recovers a transient failure through one explicit retry", async () => {
    const inventory = inventories.find((item) => item.view === "deleted")!;
    let attempts = 0;
    const requests = mockInventory(inventory, () => ++attempts === 1
      ? Response.json({ message: "Deleted records unavailable" }, { status: 503 })
      : Response.json({ items: [agent("retained-agent", "deleted")] }));
    render(<AgentsPage />);
    fireEvent.click(await screen.findByRole("tab", { name: "Deleted" }));
    fireEvent.click(await screen.findByRole("button", { name: "Retry deleted records" }));
    await screen.findByRole("list", { name: "Deleted Agents" });
    expect(requests).toHaveLength(2);
    expect(screen.queryByText("Deleted records unavailable")).toBeNull();
  });
});
