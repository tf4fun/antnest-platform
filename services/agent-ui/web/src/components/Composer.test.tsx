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
