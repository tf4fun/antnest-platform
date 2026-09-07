import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Overview } from "../lib/types";
import { DashboardPage } from "./dashboard";

afterEach(cleanup);

function overview(directoryStatus = 200): Overview {
  return {
    directory: directoryStatus === 200
      ? { status: "available", data: { users: [], groups: [] } }
      : {
        status: "unavailable",
        error: { status: directoryStatus, code: "upstream_rejected", message: "Directory could not be refreshed" },
      },
    model_profiles: { status: "available", data: { items: [] } },
    templates: { status: "available", data: { items: [] } },
    agents: {
      status: "available",
      data: {
        items: [{
          agent_id: "agent-1", owner_user_id: "user-1", name: "Support assistant",
          desired_state: "enabled", lifecycle_state: "available", aggregate_sequence: 1,
          created_at: "2026-09-07T00:00:00Z", updated_at: "2026-09-07T00:00:00Z",
        }],
      },
    },
    defaults: { runtime_image_ref: "" },
  };
}

function response(status: number): Response {
  return Response.json({ code: "upstream_rejected", message: "Overview access denied" }, { status });
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("Overview recovery at the browser boundary", () => {
  it.each([403, 404, 410])("does not offer retry after aggregate status %s", async (status) => {
    const fetch = vi.fn().mockResolvedValue(response(status));
    vi.stubGlobal("fetch", fetch);
    render(<DashboardPage />);

    expect((await screen.findByRole("alert")).textContent).toContain("Overview access denied");
    expect(screen.queryByRole("button", { name: "Retry overview" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Overview" })).toBeTruthy();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([403, 404, 410])("keeps the fleet visible when an optional section returns %s", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(overview(status))));
    render(<DashboardPage />);

    expect(await screen.findByRole("link", { name: /Support assistant/ })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Directory could not be refreshed");
    expect(screen.queryByRole("button", { name: "Retry overview" })).toBeNull();
  });

  it("recovers a transient section without clearing the fleet or admitting duplicate refreshes", async () => {
    const pending = deferredResponse();
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json(overview(503)))
      .mockReturnValueOnce(pending.promise);
    vi.stubGlobal("fetch", fetch);
    render(<DashboardPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Retry overview" }));
    const refreshing = screen.getByRole("button", { name: "Refreshing overview" }) as HTMLButtonElement;
    expect(refreshing.disabled).toBe(true);
    expect(refreshing.getAttribute("aria-busy")).toBe("true");
    fireEvent.click(refreshing);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("link", { name: /Support assistant/ })).toBeTruthy();

    await act(async () => pending.resolve(Response.json(overview())));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.getByRole("link", { name: /Support assistant/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /overview/i })).toBeNull();
  });

  it("does not reuse an old transient error to offer retry after refresh is forbidden", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json(overview(503)))
      .mockResolvedValueOnce(response(403)));
    render(<DashboardPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Retry overview" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Overview access denied"));
    expect(screen.getByRole("alert").textContent).toContain("previously loaded overview");
    expect(screen.getByRole("link", { name: /Support assistant/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry overview" })).toBeNull();
  });

  it("retries a transient initial error and renders the recovered overview", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockRejectedValueOnce(new TypeError("Network unavailable"))
      .mockResolvedValueOnce(Response.json(overview())));
    render(<DashboardPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Retry overview" }));
    expect(await screen.findByRole("link", { name: /Support assistant/ })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("aborts an unmounted read and ignores its late completion", async () => {
    const pending = deferredResponse();
    const fetch = vi.fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(response(403));
    vi.stubGlobal("fetch", fetch);
    const oldPage = render(<DashboardPage />);
    const signal = fetch.mock.calls[0]?.[1].signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    oldPage.unmount();
    expect(signal.aborted).toBe(true);

    render(<DashboardPage />);
    await screen.findByRole("alert");
    await act(async () => pending.resolve(Response.json(overview())));
    expect(screen.getByRole("alert").textContent).toContain("Overview access denied");
    expect(screen.queryByRole("link", { name: /Support assistant/ })).toBeNull();
  });
});
