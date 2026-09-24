import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { CopyButton } from "./CopyButton";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("copy result is announced outside the button without changing its action name", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const view = render(<CopyButton text="Saved answer" label="Copy response" />);
  const button = screen.getByRole("button", { name: "Copy response" });
  const status = screen.getByRole("status");
  expect(button.contains(status)).toBe(false);
  expect(status.textContent).toBe("");

  fireEvent.click(button);
  await waitFor(() => expect(status.textContent).toBe("Copied"));
  expect(writeText).toHaveBeenCalledWith("Saved answer");
  expect(screen.getByRole("button", { name: "Copy response" })).toBe(button);

  view.rerender(<CopyButton text="Updated answer" label="Copy response" />);
  expect(screen.getByRole("status")).toBe(status);
  expect(status.textContent).toBe("");
});

test("clipboard failure has a readable retry announcement", async () => {
  const writeText = vi.fn().mockRejectedValue(new Error("Clipboard unavailable"));
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  render(<CopyButton text="Saved answer" label="Copy response" />);
  fireEvent.click(screen.getByRole("button", { name: "Copy response" }));
  await waitFor(() => expect(screen.getByRole("status").textContent)
    .toBe("Copy failed. Try again"));
});
