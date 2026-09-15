import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { api, APIError } from "../lib/api";
import { ProviderModelDiscovery } from "./provider-model-discovery";
import type { ModelCatalog, ProviderConnection } from "../lib/types";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const preset = {
  model_id: "known",
  display_name: "Known",
  context_window: 128000,
  max_output_tokens: 8192,
  supports_images: false,
};
const connection: ProviderConnection = {
  connection_id: "c1",
  provider_key: "openrouter",
  display_name: "OpenRouter",
  base_url: "https://openrouter.ai/api/v1",
  credential_method: "api_key",
  credential_version: "v1",
  credential_revision: 1,
  enabled: true,
  created_at: "",
  updated_at: "",
};
const catalog: ModelCatalog = {
  revision: "test",
  providers: [
    {
      provider_key: "openrouter",
      display_name: "OpenRouter",
      description: "",
      base_url: connection.base_url,
      custom: false,
      models: [preset],
    },
  ],
};
function setup() {
  vi.spyOn(api, "models").mockResolvedValue({ items: [] });
  const discover = vi.spyOn(api, "discoverProviderModels").mockResolvedValue({
    models: [preset, { ...preset, model_id: "live", display_name: "Live" }],
  });
  const save = vi
    .spyOn(api, "createModel")
    .mockImplementation(async (input) => ({
      ...input,
      model_profile_id: input.model.model,
      revision_id: "r1",
      revision: 1,
      enabled: true,
      created_at: "",
      updated_at: "",
      model: { ...input.model, base_url: connection.base_url },
    }));
  const onSaved = vi.fn();
  const onClose = vi.fn();
  const start = () =>
    render(
      <ProviderModelDiscovery
        connection={connection}
        catalog={catalog}
        onSaved={onSaved}
        onClose={onClose}
        onBusy={vi.fn()}
      />,
    );
  return { discover, save, onSaved, onClose, start };
}
it("discovers without writes and saves only explicitly selected models", async () => {
  const state = setup();
  state.start();
  const known = await screen.findByRole("checkbox", { name: "Known" });
  expect(known.matches(":checked")).toBe(false);
  expect(state.save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("checkbox", { name: "Live" }));
  fireEvent.click(screen.getByRole("button", { name: "Add selected models" }));
  await waitFor(() => expect(state.onClose).toHaveBeenCalledOnce());
  expect(state.save).toHaveBeenCalledOnce();
  expect(state.save.mock.calls[0]?.[0]).toMatchObject({
    provider_connection_id: "c1",
    model: { model: "live" },
  });
});
it("merges builtin models on empty success and reports discovery failures", async () => {
  const state = setup();
  state.discover.mockResolvedValue({ models: [] });
  state.start();
  await screen.findByRole("checkbox", { name: "Known" });
  expect(screen.queryByRole("alert")).toBeNull();
  state.discover.mockRejectedValue(new Error("upstream unavailable"));
  fireEvent.click(screen.getByRole("button", { name: "Refresh models" }));
  await screen.findByRole("checkbox", { name: "Known" });
  expect(screen.getByRole("alert").textContent).toContain("builtin");
  expect(state.save).not.toHaveBeenCalled();
});
it.each([
  [403, "forbidden"],
  [500, "internal_error"],
  [503, "dependency_unavailable"],
] as const)(
  "does not turn internal access failure %s into static fallback",
  async (status, code) => {
    const state = setup();
    state.discover.mockRejectedValue(new APIError(status, code, "Denied"));
    state.start();
    await screen.findByRole("alert");
    expect(screen.queryByRole("checkbox", { name: "Known" })).toBeNull();
  },
);

it("merges all saved pages without allowing saved models to be added again", async () => {
  const state = setup();
  const saved = {
    provider_connection_id: "c1",
    model_profile_id: "m",
    revision_id: "r1",
    revision: 1,
    enabled: true,
    created_at: "",
    updated_at: "",
    display_name: "Saved name",
    model: {
      model: "live",
      context_window: 32000,
      max_output_tokens: 1000,
      supports_images: false,
      base_url: connection.base_url,
    },
  };
  vi.mocked(api.models)
    .mockResolvedValueOnce({ items: [], next_after_id: "page2" })
    .mockResolvedValueOnce({ items: [saved] });
  state.start();
  expect(
    (await screen.findByRole("checkbox", { name: "Saved name" })).matches(
      ":disabled",
    ),
  ).toBe(true);
  expect(screen.queryByRole("checkbox", { name: "Live" })).toBeNull();
  expect(api.models).toHaveBeenNthCalledWith(2, { afterID: "page2" });
  expect(state.save).not.toHaveBeenCalled();
});

it("requires missing remote limits before saving", async () => {
  const state = setup();
  state.discover.mockResolvedValue({
    models: [{ model_id: "unknown", display_name: "Unknown" }],
  });
  state.start();
  fireEvent.click(await screen.findByRole("checkbox", { name: "Unknown" }));
  expect(
    screen
      .getByRole("button", { name: "Add selected models" })
      .matches(":disabled"),
  ).toBe(true);
  expect(state.save).not.toHaveBeenCalled();
});
it("preserves successful additions when the remaining save fails", async () => {
  const state = setup();
  state.start();
  fireEvent.click(await screen.findByRole("checkbox", { name: "Known" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Live" }));
  state.save.mockRejectedValueOnce(new Error("save failed"));
  fireEvent.click(screen.getByRole("button", { name: "Add selected models" }));
  await screen.findByRole("alert");
  expect(state.onSaved).not.toHaveBeenCalled();
  expect(state.onClose).not.toHaveBeenCalled();
  state.save
    .mockImplementationOnce(async (input) => ({
      ...input,
      model_profile_id: "m1",
      revision_id: "r1",
      revision: 1,
      enabled: true,
      created_at: "",
      updated_at: "",
      model: { ...input.model, base_url: connection.base_url },
    }))
    .mockRejectedValueOnce(new Error("second failed"));
  fireEvent.click(screen.getByRole("button", { name: "Add selected models" }));
  await waitFor(() => expect(state.onSaved).toHaveBeenCalledOnce());
  await screen.findByText("second failed");
  expect(
    screen.getByRole("checkbox", { name: "Known" }).matches(":disabled"),
  ).toBe(true);
});
