import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { ModelProfile } from "../lib/types";
import { FallbackModels } from "./fallback-models";

afterEach(cleanup);
const models = ["primary", "backup", "third"].map((id) => ({
  model_profile_id: id,
  provider_connection_id: `provider-${id}`,
  display_name: id,
  enabled: true,
  model: { model: id },
})) as ModelProfile[];

it("retains insertion order, reorders and removes backups without changing the primary", () => {
  const { container } = render(
    <form>
      <FallbackModels models={models} primaryID="primary" />
    </form>,
  );
  const pick = screen.getByLabelText("Backup model");
  for (const id of ["backup", "third"]) {
    fireEvent.change(pick, { target: { value: id } });
    fireEvent.click(screen.getByRole("button", { name: "Add backup" }));
  }
  const values = () =>
    new FormData(container.querySelector("form")!).getAll(
      "fallback_model_profile_ids",
    );
  expect(values()).toEqual(["backup", "third"]);
  fireEvent.click(screen.getByRole("button", { name: "Move third up" }));
  expect(values()).toEqual(["third", "backup"]);
  fireEvent.click(screen.getByRole("button", { name: "Remove backup" }));
  expect(values()).toEqual(["third"]);
});

it("preserves references absent from a partial catalogue, and excludes duplicate connections", () => {
  const { container } = render(
    <form>
      <FallbackModels
        primaryID="primary"
        initial={["missing"]}
        models={[
          ...models,
          {
            ...models[0]!,
            model_profile_id: "same-provider",
            display_name: "Same Provider",
          },
        ]}
      />
    </form>,
  );
  expect(screen.getByText("missing")).toBeTruthy();
  expect(
    new FormData(container.querySelector("form")!).getAll(
      "fallback_model_profile_ids",
    ),
  ).toEqual(["missing"]);
  expect(screen.queryByRole("option", { name: /Same Provider/ })).toBeNull();
  expect(screen.queryByRole("option", { name: /^primary/ })).toBeNull();
});
