import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ModelsPage } from "./models";
import type { ProviderConnection } from "../lib/types";

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});
const connection: ProviderConnection = {
  connection_id: "c1",
  provider_key: "deepseek",
  display_name: "DeepSeek",
  base_url: "https://api.deepseek.com",
  credential_method: "api_key",
  credential_version: "v1",
  credential_revision: 1,
  enabled: true,
  created_at: "2026-09-11T00:00:00Z",
  updated_at: "2026-09-11T00:00:00Z",
};
const preset = {
  model_id: "flash",
  display_name: "Flash",
  context_window: 1000000,
  max_output_tokens: 384000,
  supports_images: false,
};
function backend(empty = false, conflict = false) {
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init: RequestInit) => {
      if (init.method === "POST") {
        writes.push({ path, body: JSON.parse(String(init.body)) });
        if (conflict)
          return Response.json(
            {
              code: "conflict",
              message: "Credential changed. Refresh the connection.",
            },
            { status: 409 },
          );
        if (path === "/api/admin/model-profiles")
          return Response.json(
            {
              ...writes.at(-1)!.body,
              model_profile_id: "m1",
              revision_id: "r1",
              revision: 1,
              enabled: true,
              model: {
                ...(writes.at(-1)!.body.model as object),
                base_url: connection.base_url,
              },
            },
            { status: 201 },
          );
        return Response.json(
          { ...connection, credential_version: "v2", credential_revision: 2 },
          { status: 201 },
        );
      }
      if (path.includes("model-catalog"))
        return Response.json({
          revision: "test",
          providers: [
            {
              provider_key: "deepseek",
              display_name: "DeepSeek",
              base_url: connection.base_url,
              custom: false,
              models: [preset],
            },
          ],
        });
      if (path.includes("model-profiles")) return Response.json({ items: [] });
      if (path.endsWith("/c1"))
        return Response.json({ ...connection, credential_version: "v2" });
      if (path.includes("provider-connections"))
        return Response.json({ items: empty ? [] : [connection] });
      throw new Error(path);
    }),
  );
  return writes;
}

it("connects a provider with selected catalogue models and no model secrets or endpoint copies", async () => {
  const writes = backend(true);
  render(<ModelsPage />);
  await waitFor(() =>
    expect(
      screen
        .getAllByRole("button", { name: "Add provider" })[0]!
        .matches(":disabled"),
    ).toBe(false),
  );
  fireEvent.click(screen.getAllByRole("button", { name: "Add provider" })[0]!);
  const form = within(await screen.findByRole("dialog"));
  expect(form.queryByLabelText("Provider name")).toBeNull();
  expect(
    form.getByRole("checkbox", { name: "Flash" }).matches(":checked"),
  ).toBe(true);
  fireEvent.change(form.getByLabelText("API key"), {
    target: { value: "synthetic-secret" },
  });
  fireEvent.click(form.getByRole("button", { name: "Connect provider" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(writes[0]?.path).toBe("/api/admin/provider-connections");
  expect(writes[0]?.body).toMatchObject({
    provider_key: "deepseek",
    credential: { method: "api_key", api_key: "synthetic-secret" },
    models: [{ model: { model: "flash", context_window: 1000000 } }],
  });
  expect(JSON.stringify(writes[0]?.body.models)).not.toMatch(
    /api_key|base_url|profile_key/,
  );
  expect(JSON.stringify({ ...sessionStorage })).not.toContain(
    "synthetic-secret",
  );
});

it("rotates credentials independently and displays the new version", async () => {
  const writes = backend();
  render(<ModelsPage />);
  fireEvent.click(await screen.findByRole("button", { name: /DeepSeek/ }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Change API key" }),
  );
  const form = within(await screen.findByRole("dialog"));
  fireEvent.change(form.getByLabelText("New API key"), {
    target: { value: "rotated-secret" },
  });
  fireEvent.click(form.getByRole("button", { name: "Save API key" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(writes).toEqual([
    {
      path: "/api/admin/provider-connections/c1/credentials",
      body: {
        expected_version: "v1",
        credential: { method: "api_key", api_key: "rotated-secret" },
      },
    },
  ]);
  expect(screen.getByText(/Credential revision 2/)).toBeTruthy();
});

it("does not silently replace a stale credential after a conflict", async () => {
  const writes = backend(false, true);
  render(<ModelsPage />);
  fireEvent.click(await screen.findByRole("button", { name: /DeepSeek/ }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Change API key" }),
  );
  const form = within(await screen.findByRole("dialog"));
  fireEvent.change(form.getByLabelText("New API key"), {
    target: { value: "secret" },
  });
  fireEvent.click(form.getByRole("button", { name: "Save API key" }));
  await form.findByRole("alert");
  expect(writes).toHaveLength(1);
  expect(writes[0]?.body.expected_version).toBe("v1");
  expect(screen.getByText(/Credential revision 1/)).toBeTruthy();
  expect(
    form.getByRole("button", { name: "Save API key" }).matches(":disabled"),
  ).toBe(true);
  fireEvent.click(form.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Refresh connection" }));
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Change API key" })
        .matches(":disabled"),
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Change API key" }));
  fireEvent.change(screen.getByLabelText("New API key"), {
    target: { value: "confirmed-new-key" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save API key" }));
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(writes[1]?.body.expected_version).toBe("v2");
});

it("allows a credential connection without initial models", async () => {
  const writes = backend(true);
  render(<ModelsPage />);
  await waitFor(() =>
    expect(
      screen
        .getAllByRole("button", { name: "Add provider" })[0]!
        .matches(":disabled"),
    ).toBe(false),
  );
  fireEvent.click(screen.getAllByRole("button", { name: "Add provider" })[0]!);
  fireEvent.click(screen.getByRole("checkbox", { name: "Flash" }));
  fireEvent.change(screen.getByLabelText("API key"), {
    target: { value: "key" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Connect provider" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(writes[0]?.body.models).toEqual([]);
});

it("adds a model to the selected connection without asking for credentials", async () => {
  const writes = backend();
  render(<ModelsPage />);
  fireEvent.click(await screen.findByRole("button", { name: /DeepSeek/ }));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Add model" }).matches(":disabled"),
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Add model" }));
  const form = within(await screen.findByRole("dialog"));
  expect(form.queryByLabelText("API key")).toBeNull();
  fireEvent.click(form.getByRole("button", { name: "Add model" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(writes[0]?.body.provider_connection_id).toBe("c1");
  expect(JSON.stringify(writes[0]?.body)).not.toMatch(
    /api_key|credential|base_url/,
  );
  expect(screen.getByRole("link", { name: /Flash/ }).getAttribute("href")).toBe(
    "#models/m1",
  );
});

it("holds credential publication open and replays a lost response with the same CAS intent", async () => {
  backend();
  const fetcher = globalThis.fetch;
  const writes: { body: string; key: string | null }[] = [];
  let finish!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn((path: string, init: RequestInit) => {
      if (init.method !== "POST") return fetcher(path, init);
      writes.push({
        body: String(init.body),
        key: new Headers(init.headers).get("Idempotency-Key"),
      });
      if (writes.length === 1) return pending;
      return Promise.resolve(
        Response.json(
          { ...connection, credential_version: "v2", credential_revision: 2 },
          { status: 201 },
        ),
      );
    }),
  );
  render(<ModelsPage />);
  fireEvent.click(await screen.findByRole("button", { name: /DeepSeek/ }));
  fireEvent.click(screen.getByRole("button", { name: "Change API key" }));
  const form = within(await screen.findByRole("dialog"));
  fireEvent.change(form.getByLabelText("New API key"), {
    target: { value: "replacement" },
  });
  fireEvent.click(form.getByRole("button", { name: "Save API key" }));
  expect(
    form.getByRole("button", { name: "Close dialog" }).matches(":disabled"),
  ).toBe(true);
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(screen.getByRole("dialog")).toBeTruthy();
  await act(async () => {
    finish(new Response("broken-json", { status: 201 }));
  });
  await form.findByRole("alert");
  fireEvent.click(form.getByRole("button", { name: "Save API key" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual(writes[0]);
  expect(JSON.stringify({ ...sessionStorage })).not.toContain("replacement");
});
