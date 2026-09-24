import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AgentPresence } from "./AgentPresence";

afterEach(cleanup);

describe("Agent presence announcements", () => {
  it("announces a changing workspace status from the top bar", () => {
    const view = render(<AgentPresence status="unknown" announce />);
    expect(screen.getByRole("status").textContent).toBe("Status unavailable");
    view.rerender(<AgentPresence status="offline" announce />);
    expect(screen.getByRole("status").textContent).toBe("Offline");
  });

  it("keeps a repeated sidebar status out of the live region", () => {
    render(<AgentPresence status="unknown" />);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText("Status unavailable")).toBeTruthy();
  });
});
