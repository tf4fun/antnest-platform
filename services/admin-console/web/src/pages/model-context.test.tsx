import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type {
  ModelCatalog,
  ModelProviderPreset,
  ModelSpec,
  ProviderModelInput,
} from "../lib/types";
import { ModelEditor } from "./model-editor";

afterEach(() => cleanup());

const catalog: ModelCatalog = { revision: "context", providers: [] };
const custom: ModelProviderPreset = {
  provider_key: "custom",
  display_name: "Custom",
  description: "",
  base_url: "",
  custom: true,
  models: [],
};

function renderEditor(
  options: { pending?: boolean; initialModel?: ModelSpec } = {},
) {
  const onSubmit = vi.fn<(value: ProviderModelInput) => Promise<void>>(() => Promise.resolve());
  const onCancel = vi.fn();
  render(
    <ModelEditor
      catalog={catalog}
      provider={custom}
      pending={options.pending ?? false}
      submitLabel="Save model"
      onCancel={onCancel}
      onSubmit={onSubmit}
      {...(options.initialModel === undefined ? {} : { initialModel: options.initialModel })}
    />,
  );
  return { onSubmit, onCancel };
}

function fillRequired() {
  fireEvent.change(screen.getByLabelText("Model ID"), { target: { value: "meta-model" } });
  fireEvent.change(screen.getByLabelText("Context window"), { target: { value: "8192" } });
  fireEvent.change(screen.getByLabelText("Maximum output"), { target: { value: "1024" } });
}

it("exposes tokenizer select and compaction profile input with optional defaults", () => {
  renderEditor();
  const tokenizer = screen.getByLabelText("Tokenizer");
  expect(tokenizer).not.toBeNull();
  expect((tokenizer as HTMLSelectElement).value).toBe("");
  expect(tokenizer.querySelectorAll("option")).toHaveLength(4);
  expect([...tokenizer.querySelectorAll("option")].map((option) => option.value)).toEqual([
    "",
    "o200k",
    "cl100k",
    "none",
  ]);
  const reference = screen.getByLabelText("Compaction model profile ID");
  expect(reference).not.toBeNull();
  expect((reference as HTMLInputElement).value).toBe("");
});

it("submits tokenizer selection and compaction reference inside model parameters", async () => {
  const { onSubmit } = renderEditor();
  fillRequired();
  fireEvent.change(screen.getByLabelText("Tokenizer"), { target: { value: "o200k" } });
  fireEvent.change(screen.getByLabelText("Compaction model profile ID"), {
    target: { value: "compactor-1" },
  });
  fireEvent.click(screen.getByText("Save model"));
  await vi.waitFor(() => expect(onSubmit).toHaveBeenCalled());
  const value = onSubmit.mock.calls[0]![0];
  expect(value.display_name).toBe("meta-model");
  expect(value.model).toMatchObject({
    tokenizer: "o200k",
    compaction_model_profile_id: "compactor-1",
  });
});

it("renders saved fields and clearing them removes the optional keys", async () => {
  const { onSubmit } = renderEditor({
    initialModel: {
      base_url: "https://known.test/v1",
      model: "known",
      context_window: 8192,
      max_output_tokens: 1024,
      supports_images: false,
      tokenizer: "cl100k",
      compaction_model_profile_id: "compactor-1",
    },
  });
  expect((screen.getByLabelText("Tokenizer") as HTMLSelectElement).value).toBe("cl100k");
  expect((screen.getByLabelText("Compaction model profile ID") as HTMLInputElement).value).toBe(
    "compactor-1",
  );
  fireEvent.change(screen.getByLabelText("Tokenizer"), { target: { value: "" } });
  fireEvent.change(screen.getByLabelText("Compaction model profile ID"), {
    target: { value: "" },
  });
  fireEvent.click(screen.getByText("Save model"));
  await vi.waitFor(() => expect(onSubmit).toHaveBeenCalled());
  const value = onSubmit.mock.calls[0]![0];
  expect(value.model).not.toHaveProperty("tokenizer");
  expect(value.model).not.toHaveProperty("compaction_model_profile_id");
});

it("invokes cancel callback when enabled", () => {
  const { onCancel } = renderEditor();
  fireEvent.click(screen.getByText("Cancel"));
  expect(onCancel).toHaveBeenCalled();
});

it("disables context controls while pending and blocks cancel", () => {
  const { onCancel } = renderEditor({ pending: true });
  expect((screen.getByLabelText("Tokenizer") as HTMLElement).matches(":disabled")).toBe(true);
  expect(
    (screen.getByLabelText("Compaction model profile ID") as HTMLElement).matches(":disabled"),
  ).toBe(true);
  const cancel = screen.getByText("Cancel");
  expect((cancel as HTMLElement).matches(":disabled")).toBe(true);
  fireEvent.click(cancel);
  expect(onCancel).not.toHaveBeenCalled();
});
