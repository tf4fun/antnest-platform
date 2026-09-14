import { useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CatalogAvailabilityControl } from "./catalog-availability";
import type { CatalogKind } from "../lib/catalog-availability";

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

function Harness({ kind = "model-profiles" }: { kind?: CatalogKind }) {
  const [enabled, setEnabled] = useState(true);
  return (
    <CatalogAvailabilityControl
      kind={kind}
      resourceID="item-1"
      enabled={enabled}
      onReload={async () => {
        const response = await fetch("/current");
        if (!response.ok) throw new Error("Current state unavailable");
        setEnabled((await response.json()).enabled);
      }}
    />
  );
}

function receipt(enabled = false) {
  return Response.json({
    resource_id: "item-1",
    enabled,
    updated_at: "2026-09-14T00:00:00Z",
  });
}

describe("catalog availability", () => {
  it.each(["provider-connections", "model-profiles", "templates"] as const)(
    "updates %s only after reloading current state",
    async (kind) => {
      let finish!: (value: Response) => void;
      const fetcher = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<Response>((resolve) => {
              finish = resolve;
            }),
        )
        .mockResolvedValueOnce(Response.json({ enabled: false }));
      vi.stubGlobal("fetch", fetcher);
      render(<Harness kind={kind} />);
      const toggle = screen.getByRole("switch");
      fireEvent.click(toggle);
      expect(toggle.getAttribute("aria-checked")).toBe("true");
      expect((toggle as HTMLButtonElement).disabled).toBe(true);
      await act(async () => finish(receipt()));
      await screen.findByText("Availability change saved.");
      expect(toggle.getAttribute("aria-checked")).toBe("false");
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(fetcher.mock.calls[1]![0]).toBe("/current");
    },
  );

  it("does not replace current state with a historical replay receipt", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(receipt(false))
        .mockResolvedValueOnce(Response.json({ enabled: true })),
    );
    render(<Harness />);
    fireEvent.click(screen.getByRole("switch"));
    await screen.findByText("Availability change saved.");
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  it("retries only the read when the write succeeded", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(receipt())
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(Response.json({ enabled: false }));
    vi.stubGlobal("fetch", fetcher);
    render(<Harness />);
    fireEvent.click(screen.getByRole("switch"));
    await screen.findByText(/Saved, but current state could not be refreshed/);
    fireEvent.click(screen.getByRole("button", { name: "Retry refresh" }));
    await screen.findByText("Availability change saved.");
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual([
      "/api/admin/model-profiles/item-1/availability",
      "/current",
      "/current",
    ]);
  });

  it("retries an unconfirmed write with the same key and body", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Connection lost"))
      .mockResolvedValueOnce(receipt())
      .mockResolvedValueOnce(Response.json({ enabled: false }));
    vi.stubGlobal("fetch", fetcher);
    render(<Harness />);
    fireEvent.click(screen.getByRole("switch"));
    await screen.findByText(/Change is unconfirmed/);
    expect((screen.getByRole("switch") as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry change" }));
    await screen.findByText("Availability change saved.");
    const first = fetcher.mock.calls[0]![1] as RequestInit;
    const retry = fetcher.mock.calls[1]![1] as RequestInit;
    expect(retry.body).toBe(first.body);
    expect(new Headers(retry.headers).get("Idempotency-Key")).toBe(
      new Headers(first.headers).get("Idempotency-Key"),
    );
  });

  it("shows owner-supplied references and never cascades or auto-retries", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          {
            code: "resource_in_use",
            message: "Resource is referenced",
            references: [
              { kind: "template", resource_id: "template 1" },
              { kind: "agent", resource_id: "agent-1" },
              {
                kind: "lifecycle_operation",
                resource_id: "operation-1",
                agent_id: "agent-2",
              },
            ],
            references_truncated: true,
          },
          { status: 409 },
        ),
      )
      .mockResolvedValueOnce(Response.json({ enabled: false }));
    vi.stubGlobal("fetch", fetcher);
    render(<Harness />);
    fireEvent.click(screen.getByRole("switch"));
    await screen.findByText("Resource is referenced");
    expect(
      screen
        .getByRole("link", { name: "Template template 1" })
        .getAttribute("href"),
    ).toBe("#templates/template%201");
    expect(
      screen.getByRole("link", { name: "Agent agent-1" }).getAttribute("href"),
    ).toBe("#agents/agent-1");
    expect(
      screen
        .getByRole("link", { name: /Operation operation-1/ })
        .getAttribute("href"),
    ).toBe("#agents/agent-2");
    expect(screen.getByText("Reference list is incomplete.")).toBeTruthy();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("switch") as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh current state" }),
    );
    await waitFor(() =>
      expect((screen.getByRole("switch") as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe(
      "false",
    );
  });

  it("does not refresh another resource after the old control unmounts", async () => {
    let finish!: (value: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      ),
    );
    const onReload = vi.fn();
    const { rerender } = render(
      <CatalogAvailabilityControl
        kind="templates"
        resourceID="item-1"
        enabled
        onReload={onReload}
      />,
    );
    fireEvent.click(screen.getByRole("switch"));
    rerender(
      <CatalogAvailabilityControl
        kind="templates"
        resourceID="item-2"
        enabled
        onReload={onReload}
      />,
    );
    await act(async () => finish(receipt()));
    expect(onReload).not.toHaveBeenCalled();
    expect(screen.queryByText("Availability change saved.")).toBeNull();
  });
});
