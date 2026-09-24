import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageView } from "./MessageView";

describe("Bridge content preview", () => {
  afterEach(cleanup);
  it("labels an incomplete answer and does not offer copying its partial text", () => {
    render(<MessageView message={{ id: "answer", role: "assistant", content: "Partial",
      contentIncomplete: true }} answer />);
    expect(screen.getByText("More content available")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copy response" })).toBeNull();
  });

  it("loads the full block sequence only when requested", () => {
    const load = vi.fn();
    render(<MessageView message={{ id: "turn-1:answer", role: "assistant", content: "Partial",
      contentIncomplete: true }} answer onLoadContent={load} />);
    fireEvent.click(screen.getByRole("button", { name: "Load full content" }));
    expect(load).toHaveBeenCalledWith("turn-1:answer");
  });
});
