import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Composer } from "./Composer";

afterEach(cleanup);
const props = () => ({
  fileAccept: "image/*",
  configuring: false,
  historyReady: true,
  value: "An unsent draft",
  attachments: [],
  agentStatus: "ready" as const,
  connected: true,
  sending: false,
  cancelling: false,
  cancellable: false,
  onChange: vi.fn(),
  onFiles: vi.fn(),
  onRemoveAttachment: vi.fn(),
  onCancel: vi.fn(),
  onSubmit: vi.fn(),
});

test("expanding and collapsing the editor preserves the draft and never submits", () => {
  const input = props();
  const { container } = render(<Composer {...input} />);
  const area = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: "Message",
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Expand message editor" }),
  );
  expect(container.querySelector(".composer-expanded")).not.toBeNull();
  expect(document.activeElement).toBe(area);
  expect(area.value).toBe(input.value);
  fireEvent.keyDown(area, { key: "Escape" });
  expect(container.querySelector(".composer-expanded")).toBeNull();
  expect(input.onSubmit).not.toHaveBeenCalled();
  expect(input.onChange).not.toHaveBeenCalled();
});

test("IME confirmation never submits or collapses the composer", () => {
  const input = props();
  const { container } = render(<Composer {...input} />);
  const area = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" });
  fireEvent.click(screen.getByRole("button", { name: "Expand message editor" }));
  fireEvent.keyDown(area, { key: "Enter", isComposing: true });
  fireEvent.keyDown(area, { key: "Enter", keyCode: 229 });
  fireEvent.keyDown(area, { key: "Escape", keyCode: 229 });
  expect(input.onSubmit).not.toHaveBeenCalled();
  expect(container.querySelector(".composer-expanded")).not.toBeNull();
  fireEvent.keyDown(area, { key: "Enter" });
  expect(input.onSubmit).toHaveBeenCalledOnce();
});

test("configuration, connection and execution gating survive toolbar integration", () => {
  const input = props();
  const { rerender } = render(<Composer {...input} configuring />);
  const area = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: "Message",
  });
  expect(area.disabled).toBe(true);
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Send message" })
      .disabled,
  ).toBe(true);
  rerender(<Composer {...input} connected={false} />);
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Attach files" })
      .disabled,
  ).toBe(true);
  rerender(<Composer {...input} sending cancellable />);
  expect(area.disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Stop operation" }));
  expect(input.onCancel).toHaveBeenCalledOnce();
  expect(input.onSubmit).not.toHaveBeenCalled();
});

test("composer hint keeps one live region through availability changes", () => {
  const input = props();
  const { rerender } = render(<Composer {...input} />);
  const hint = screen.getByRole("status");
  const editor = screen.getByRole("textbox", { name: "Message" });
  expect(hint.textContent).toBe("");
  expect(editor.hasAttribute("aria-describedby")).toBe(false);

  rerender(<Composer {...input} connected={false} />);
  expect(screen.getByRole("status")).toBe(hint);
  expect(hint.textContent).toBe("Connection unavailable");
  expect(editor.getAttribute("aria-describedby")).toBe(hint.id);

  rerender(<Composer {...input} historyReady={false} />);
  expect(screen.getByRole("status")).toBe(hint);
  expect(hint.textContent).toBe("Conversation not yet synchronized");

  rerender(<Composer {...input} />);
  expect(screen.getByRole("status")).toBe(hint);
  expect(hint.textContent).toBe("");
  expect(editor.hasAttribute("aria-describedby")).toBe(false);
});

test("opening history keeps the draft mounted with an accurate disabled hint", () => {
  const input = props();
  const { rerender } = render(<Composer {...input} connected={false}
    historyReady={false} openingHistory />);
  const editor = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" });
  expect(editor.value).toBe("An unsent draft");
  expect(editor.disabled).toBe(true);
  expect(screen.getByRole("status").textContent).toBe("Opening conversation history");
  rerender(<Composer {...input} connected={false} historyReady={false} openingFailure />);
  expect(screen.getByRole("status").textContent).toBe("Conversation history unavailable");
  expect(editor.value).toBe("An unsent draft");
});

test("unsynchronized history blocks a new message while an active Run can still be stopped", () => {
  const input = props();
  render(<Composer {...input} historyReady={false} cancellable />);
  expect(screen.getByText("Conversation not yet synchronized")).toBeTruthy();
  expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" }).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Stop operation" }));
  expect(input.onCancel).toHaveBeenCalledOnce();
  expect(input.onSubmit).not.toHaveBeenCalled();
});

test("keyboard submission restores the editor only when focus was lost to the page", () => {
  const input = props();
  const { rerender } = render(<Composer {...input} />);
  const area = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" });
  area.focus();
  fireEvent.keyDown(area, { key: "Enter" });
  expect(input.onSubmit).toHaveBeenCalledOnce();
  rerender(<Composer {...input} sending />);
  document.body.tabIndex = -1;
  document.body.focus();
  expect(document.activeElement).toBe(document.body);
  rerender(<Composer {...input} />);
  expect(document.activeElement).toBe(area);

  fireEvent.keyDown(area, { key: "Enter" });
  rerender(<Composer {...input} sending />);
  const expand = screen.getByRole<HTMLButtonElement>("button", { name: "Expand message editor" });
  expand.focus();
  rerender(<Composer {...input} />);
  expect(document.activeElement).toBe(expand);

  area.focus();
  fireEvent.keyDown(area, { key: "Enter" });
  rerender(<Composer {...input} sending />);
  fireEvent.pointerDown(document.body);
  document.body.focus();
  rerender(<Composer {...input} />);
  expect(document.activeElement).toBe(document.body);
  document.body.removeAttribute("tabindex");
});

test("removing a focused attachment moves focus to the next attachment or editor", () => {
  const input = props();
  const first = { id: "first", name: "first.txt", kind: "file" as const, sizeLabel: "1 B" };
  const second = { id: "second", name: "second.txt", kind: "file" as const, sizeLabel: "1 B" };
  const { rerender } = render(<Composer {...input} attachments={[first, second]} />);
  const removeFirst = screen.getByRole<HTMLButtonElement>("button", { name: "Remove first.txt" });
  removeFirst.focus();
  fireEvent.click(removeFirst);
  rerender(<Composer {...input} attachments={[second]} />);
  const removeSecond = screen.getByRole<HTMLButtonElement>("button", { name: "Remove second.txt" });
  expect(document.activeElement).toBe(removeSecond);
  fireEvent.click(removeSecond);
  rerender(<Composer {...input} attachments={[]} />);
  expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Message" }));
});

test("removing the last attachment keeps focus on an available control when the editor is disabled", () => {
  const input = props();
  const attachment = { id: "draft", name: "draft.txt", kind: "file" as const, sizeLabel: "1 B" };
  const { rerender } = render(<Composer {...input} connected={false} attachments={[attachment]} />);
  const remove = screen.getByRole("button", { name: "Remove draft.txt" });
  remove.focus();
  fireEvent.click(remove);
  rerender(<Composer {...input} connected={false} attachments={[]} />);
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Expand message editor" }));
});
