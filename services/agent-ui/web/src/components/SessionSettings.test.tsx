import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { SessionSettings } from "./SessionSettings";

afterEach(cleanup);

test("Provider fallback notices follow ACP configuration updates and disappear on recovery", () => {
  const notice = "DeepSeek is unavailable. Switched to OpenRouter GPT-4o mini.";
  const change = vi.fn();
  const view = render(
    <SessionSettings
      options={[{ ...model, description: notice }]}
      disabled={false}
      onChange={change}
    />,
  );
  expect(screen.getByRole("status").textContent).toBe(notice);
  expect(
    screen.getByRole("combobox", { name: "Model" }).hasAttribute("disabled"),
  ).toBe(false);
  view.rerender(
    <SessionSettings options={[model]} disabled={false} onChange={change} />,
  );
  expect(screen.queryByRole("status")).toBeNull();
  expect(change).not.toHaveBeenCalled();
});

test("a non-searchable picker focuses its selected option, not its first option", () => {
  const change = vi.fn();
  render(
    <SessionSettings
      options={[
        {
          id: "thinking_effort",
          name: "Thinking",
          type: "select",
          category: "thought_level",
          currentValue: "high",
          options: [
            { value: "low", name: "Low" },
            { value: "high", name: "High" },
          ],
        },
      ]}
      disabled={false}
      onChange={change}
    />,
  );
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Thinking" }), {
    key: "ArrowDown",
  });
  expect(document.activeElement).toBe(
    screen.getByRole("option", { name: "High" }),
  );
  fireEvent.click(document.activeElement!);
  expect(change).not.toHaveBeenCalled();
});
const model: SessionConfigOption = {
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue: "flash",
  options: [
    {
      group: "deepseek",
      name: "DeepSeek",
      options: [
        {
          value: "flash",
          name: "DeepSeek V4 Flash",
          description: "deepseek-v4-flash",
        },
        {
          value: "pro",
          name: "DeepSeek V4 Pro",
          description: "deepseek-v4-pro",
        },
      ],
    },
  ],
};

test("model picker exposes grouped, searchable choices and the current selection", () => {
  const change = vi.fn();
  render(
    <SessionSettings options={[model]} disabled={false} onChange={change} />,
  );
  const trigger = screen.getByRole("combobox", { name: "Model" });
  expect(trigger.textContent).toContain("DeepSeek V4 Flash");
  fireEvent.click(trigger);
  expect(screen.getByRole("group", { name: "DeepSeek" })).toBeTruthy();
  expect(
    screen.getByRole("option", { name: /Flash/ }).getAttribute("aria-selected"),
  ).toBe("true");
  fireEvent.change(screen.getByRole("searchbox", { name: "Search Model" }), {
    target: { value: "pro" },
  });
  expect(screen.queryByRole("option", { name: /Flash/ })).toBeNull();
  fireEvent.click(screen.getByRole("option", { name: /Pro/ }));
  expect(change).toHaveBeenCalledWith("model", "pro");
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

test("keyboard navigation, Escape, outside clicks and disabled changes close the menu", () => {
  const change = vi.fn();
  const view = render(
    <SessionSettings options={[model]} disabled={false} onChange={change} />,
  );
  const trigger = screen.getByRole("combobox", { name: "Model" });
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  const search = screen.getByRole("searchbox");
  fireEvent.keyDown(search, { key: "ArrowDown" });
  expect(document.activeElement).toBe(
    screen.getByRole("option", { name: /Flash/ }),
  );
  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
  expect(document.activeElement).toBe(
    screen.getByRole("option", { name: /Pro/ }),
  );
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(document.activeElement).toBe(trigger);
  expect(screen.queryByRole("listbox")).toBeNull();
  fireEvent.click(trigger);
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("listbox")).toBeNull();
  fireEvent.click(trigger);
  view.rerender(
    <SessionSettings options={[model]} disabled onChange={change} />,
  );
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(change).not.toHaveBeenCalled();
});

test("selecting the current value makes no request; zero results are explicit", () => {
  const change = vi.fn();
  render(
    <SessionSettings options={[model]} disabled={false} onChange={change} />,
  );
  fireEvent.click(screen.getByRole("combobox"));
  fireEvent.click(screen.getByRole("option", { name: /Flash/ }));
  expect(change).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("combobox"));
  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: "missing" },
  });
  expect(screen.getByText("No matching options")).toBeTruthy();
});
