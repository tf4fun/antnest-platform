import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigurationSynchronization } from "./configuration-synchronization";

afterEach(cleanup);
const record = {
  revision: 8,
  applied_revision: 7,
  updated_at: "2026-09-14T00:00:00Z",
  applied_at: "2026-09-13T00:00:00Z",
};

describe("configuration delivery observation", () => {
  it.each([
    { synchronization: null, label: "No execution configuration published" },
    { synchronization: record, label: "Configuration delivery pending" },
    {
      synchronization: { ...record, applied_revision: 0, applied_at: null },
      label: "Configuration delivery pending",
    },
    {
      synchronization: { ...record, applied_revision: 8 },
      label: "Configuration acknowledged",
    },
  ])(
    "shows $label without interpreting it as runtime readiness",
    async ({ synchronization, label }) => {
      const fetcher = vi
        .fn()
        .mockResolvedValue(Response.json({ synchronization }));
      const interval = vi.spyOn(window, "setInterval");
      vi.stubGlobal("fetch", fetcher);
      await act(async () => {
        render(<ConfigurationSynchronization />);
      });
      expect(screen.getByText(label)).toBeTruthy();
      expect(screen.queryByText(/Ready to chat|Agent ready|Idle/i)).toBeNull();
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(fetcher.mock.calls[0]![0]).toBe(
        "/api/admin/execution-synchronization",
      );
      expect(interval).not.toHaveBeenCalled();
    },
  );

  it("refreshes on an explicit request or committed configuration hint, never retries a write", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ synchronization: record }))
      .mockResolvedValueOnce(
        Response.json(
          { message: "Delivery status unavailable" },
          { status: 503 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({ synchronization: { ...record, applied_revision: 8 } }),
      );
    vi.stubGlobal("fetch", fetcher);
    render(<ConfigurationSynchronization />);
    await screen.findByText("Configuration delivery pending");
    act(() => window.dispatchEvent(new Event("antnest:configuration-changed")));
    await screen.findByText("Configuration delivery unknown");
    expect(screen.queryByText("Configuration delivery pending")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh configuration delivery" }),
    );
    await screen.findByText("Configuration acknowledged");
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls.every(([, init]) => init.method === "GET")).toBe(
      true,
    );
  });

  it("ignores an older read after a new configuration hint", async () => {
    let old!: (response: Response) => void;
    const fetcher = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            old = resolve;
          }),
      )
      .mockResolvedValueOnce(
        Response.json({ synchronization: { ...record, revision: 9 } }),
      );
    vi.stubGlobal("fetch", fetcher);
    render(<ConfigurationSynchronization />);
    act(() => window.dispatchEvent(new Event("antnest:configuration-changed")));
    await screen.findByText(/Saved revision 9/);
    await act(async () =>
      old(
        Response.json({ synchronization: { ...record, applied_revision: 8 } }),
      ),
    );
    expect(screen.queryByText("Configuration acknowledged")).toBeNull();
    expect((fetcher.mock.calls[0]![1] as RequestInit).signal?.aborted).toBe(
      true,
    );
  });

  it("unsubscribes and cancels reads when leaving configuration pages", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(Response.json({ synchronization: null }));
    vi.stubGlobal("fetch", fetcher);
    const { unmount } = render(<ConfigurationSynchronization />);
    await screen.findByText("No execution configuration published");
    unmount();
    act(() => window.dispatchEvent(new Event("antnest:configuration-changed")));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect((fetcher.mock.calls[0]![1] as RequestInit).signal?.aborted).toBe(
      true,
    );
  });
});
