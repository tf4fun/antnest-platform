import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelProfile } from "../lib/types";
import { ModelsPage } from "./models";

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

const model: ModelProfile = {
  provider_connection_id: "connection-1",
  model_profile_id: "model-1",
  display_name: "Support model",
  revision_id: "model-revision-1",
  revision: 1,
  enabled: true,
  model: {
    base_url: "https://models.example.com/v1",
    model: "support",
    context_window: 8192,
    max_output_tokens: 1024,
    supports_images: false,
  },
  created_at: "2026-09-07T00:00:00Z",
  updated_at: "2026-09-07T00:00:00Z",
};
const catalog = {
  revision: "test-catalog",
  providers: [
    {
      provider_key: "support",
      display_name: "Support models",
      description: "",
      base_url: model.model.base_url,
      custom: false,
      models: [
        {
          model_id: "support",
          display_name: "Support model",
          context_window: 8192,
          max_output_tokens: 1024,
          supports_images: false,
        },
      ],
    },
  ],
};
const usagePath = "/api/admin/model-profiles/model-1/usage";
const revisePath = "/api/admin/model-profiles/model-1/revisions";
type Request = { method: string; path: string; body: string };

function mockPage(
  overrides: (request: Request) => Response | Promise<Response> | undefined = () => undefined,
) {
  const requests: Request[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit) => {
      const request = {
        method: init.method ?? "GET",
        path: new URL(input, "http://localhost").pathname,
        body: String(init.body ?? ""),
      };
      requests.push(request);
      const response = overrides(request);
      if (response !== undefined) return response;
      if (request.method !== "GET")
        throw new Error(`Unexpected mutation: ${request.path}`);
      switch (request.path) {
        case "/api/admin/model-catalog":
          return Response.json(catalog);
        case "/api/admin/model-profiles":
          return Response.json({ items: [model] });
        case "/api/admin/skills":
          return Response.json({ items: [], next_after_id: null });
        case "/api/admin/model-profiles/model-1":
          return Response.json(model);
        case usagePath:
          return Response.json({ templates: 2, agents: 3 });
        default:
          throw new Error(`Unexpected read: ${request.path}`);
      }
    }),
  );
  return requests;
}

const posts = (requests: Request[]) =>
  requests.filter((request) => request.method !== "GET");

async function openEditor() {
  render(<ModelsPage modelID={model.model_profile_id} />);
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Edit model" }).matches(":disabled"),
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Edit model" }));
  return within(await screen.findByRole("dialog"));
}

describe("live model revision edit confirmation", () => {
  it("shows the usage count and live-vs-frozen warning when the editor opens", async () => {
    const requests = mockPage();
    const dialog = await openEditor();
    await dialog.findByText(/Used by 3 Agents in 2 Templates/);
    expect(
      requests.some(
        (request) => request.method === "GET" && request.path === usagePath,
      ),
    ).toBe(true);
    expect(posts(requests)).toHaveLength(0);
  });

  it("does not POST until the explicit confirmation step", async () => {
    const requests = mockPage((request) =>
      request.method === "POST" && request.path === revisePath
        ? Response.json(
            { ...model, revision: 2, revision_id: "model-revision-2" },
            { status: 201 },
          )
        : undefined,
    );
    const dialog = await openEditor();
    await dialog.findByText(/Used by 3 Agents in 2 Templates/);
    fireEvent.change(dialog.getByLabelText("Maximum output"), {
      target: { value: "2048" },
    });
    fireEvent.click(dialog.getByRole("button", { name: "Save changes" }));
    await dialog.findByText(/Confirm model changes/);
    await dialog.findByText(
      /Saving updates the live Model Profile for future executions/,
    );
    expect(posts(requests)).toHaveLength(0);
    fireEvent.click(dialog.getByRole("button", { name: "Confirm changes" }));
    await waitFor(() =>
      expect(posts(requests).map((request) => request.path)).toEqual([
        revisePath,
      ]),
    );
    expect(JSON.parse(posts(requests)[0]!.body).model.max_output_tokens).toBe(
      2048,
    );
  });

  it.each([
    ["Back to edit", true],
    ["Cancel", false],
  ])("stays silent on %s without posting", async (label, returns) => {
    const requests = mockPage();
    const dialog = await openEditor();
    await dialog.findByText(/Used by 3 Agents in 2 Templates/);
    fireEvent.click(dialog.getByRole("button", { name: "Save changes" }));
    await dialog.findByText(/Confirm model changes/);
    fireEvent.click(dialog.getByRole("button", { name: label }));
    if (returns) await dialog.findByRole("button", { name: "Save changes" });
    else await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(posts(requests)).toHaveLength(0);
  });

  it("requires the same confirmation step when nothing references the model", async () => {
    const requests = mockPage((request) =>
      request.path === usagePath
        ? Response.json({ templates: 0, agents: 0 })
        : request.method === "POST" && request.path === revisePath
          ? Response.json({ ...model, revision: 2 }, { status: 201 })
          : undefined,
    );
    const dialog = await openEditor();
    await dialog.findByText(/Used by 0 Agents in 0 Templates/);
    fireEvent.click(dialog.getByRole("button", { name: "Save changes" }));
    await dialog.findByText(/Confirm model changes/);
    expect(posts(requests)).toHaveLength(0);
  });

  it("blocks saving while usage fails or loads and recovers through Retry", async () => {
    let failures = 1;
    const requests = mockPage((request) => {
      if (request.path === usagePath && failures > 0) {
        failures -= 1;
        return Response.json({ message: "unavailable" }, { status: 503 });
      }
      return undefined;
    });
    const dialog = await openEditor();
    await dialog.findByRole("alert");
    expect(
      (
        dialog.getByRole("button", {
          name: "Save changes",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(posts(requests)).toHaveLength(0);
    fireEvent.click(dialog.getByRole("button", { name: /Retry|reload/i }));
    await dialog.findByText(/Used by 3 Agents in 2 Templates/);
    expect(
      (
        dialog.getByRole("button", {
          name: "Save changes",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    expect(
      requests.filter((request) => request.path === usagePath),
    ).toHaveLength(2);
  });
});

describe("usage fetch guards", () => {
  it("records one POST for a rapid double confirm", async () => {
    const requests = mockPage((request) => request.method === "POST" && request.path === revisePath
      ? Response.json({ ...model, revision: 2 }, { status: 201 })
      : undefined);
    const dialog = await openEditor();
    await dialog.findByText(/Used by 3 Agents in 2 Templates/);
    fireEvent.click(dialog.getByRole("button", { name: "Save changes" }));
    const confirm = await dialog.findByRole("button", { name: "Confirm changes" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(posts(requests)).toHaveLength(1));
    await screen.findByText("Model settings saved.");
    expect(posts(requests)).toHaveLength(1);
  });

  it("ignores a stale usage read that resolves after the dialog is reopened", async () => {
    let first!: (response: Response) => void;
    let calls = 0;
    mockPage((request) => request.path === usagePath
      ? (++calls === 1 ? new Promise<Response>((done) => { first = done; }) : Response.json({ templates: 5, agents: 9 }))
      : undefined);
    const firstDialog = await openEditor();
    expect((firstDialog.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(firstDialog.getByRole("button", { name: "Close dialog" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(await screen.findByRole("button", { name: "Edit model" }));
    const reopened = within(await screen.findByRole("dialog"));
    await reopened.findByText(/Used by 9 Agents in 5 Templates/);
    first(Response.json({ templates: 1, agents: 1 }));
    await waitFor(() => expect((reopened.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(false));
    await reopened.findByText(/Used by 9 Agents in 5 Templates/);
    expect(reopened.queryByText(/Used by 1 Agents/)).toBeNull();
  });
});
