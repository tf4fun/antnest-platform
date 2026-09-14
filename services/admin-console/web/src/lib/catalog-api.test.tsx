import { afterEach, describe, expect, it, vi } from "vitest";
import { api, APIError, resetSessionRequests } from "./api";

afterEach(() => {
  sessionStorage.clear();
  resetSessionRequests();
});

describe("catalog command boundary", () => {
  it.each(["admin-a", "admin-b"])(
    "isolates pending keys and ignores stale-session cleanup after login as %s",
    async (user) => {
      let finishOld!: (response: Response) => void;
      let failNew!: (cause: Error) => void;
      const fetcher = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<Response>((resolve) => {
              finishOld = resolve;
            }),
        )
        .mockImplementationOnce(
          () =>
            new Promise<Response>((_, reject) => {
              failNew = reject;
            }),
        )
        .mockResolvedValueOnce(
          Response.json({
            resource_id: "item",
            enabled: false,
            updated_at: "2026-09-15T00:00:00Z",
          }),
        );
      vi.stubGlobal("fetch", fetcher);
      const input = { expected_enabled: true, enabled: false };
      resetSessionRequests({
        organization_id: "org",
        user_id: "admin-a",
        membership_id: "membership-a",
      });
      const old = api.setCatalogAvailability("templates", "item", input);
      resetSessionRequests({
        organization_id: "org",
        user_id: user,
        membership_id: user === "admin-a" ? "membership-a" : "membership-b",
      });
      const current = api
        .setCatalogAvailability("templates", "item", input)
        .catch((cause: unknown) => cause);
      finishOld(
        Response.json({
          resource_id: "item",
          enabled: false,
          updated_at: "2026-09-15T00:00:00Z",
        }),
      );
      await old;
      failNew(new Error("New response lost"));
      await current;
      await api.setCatalogAvailability("templates", "item", input);
      const keys = fetcher.mock.calls.map(([, init]) =>
        new Headers(init.headers).get("Idempotency-Key"),
      );
      if (user === "admin-b") expect(keys[0]).not.toBe(keys[1]);
      else expect(keys[0]).toBe(keys[1]);
      expect(keys[1]).toBe(keys[2]);
    },
  );

  it.each(["provider-connections", "model-profiles", "templates"] as const)(
    "sends one scoped %s PUT and retries an uncertain intent",
    async (kind) => {
      const fetcher = vi
        .fn()
        .mockRejectedValueOnce(new TypeError("Response lost"))
        .mockResolvedValueOnce(
          Response.json({
            resource_id: "resource one",
            enabled: false,
            updated_at: "2026-09-14T00:00:00Z",
          }),
        );
      vi.stubGlobal("fetch", fetcher);
      const input = { expected_enabled: true, enabled: false };
      await expect(
        api.setCatalogAvailability(kind, "resource one", input),
      ).rejects.toThrow("Response lost");
      await api.setCatalogAvailability(kind, "resource one", input);
      expect(fetcher).toHaveBeenCalledTimes(2);
      const [path, first] = fetcher.mock.calls[0]!;
      const [, second] = fetcher.mock.calls[1]!;
      expect(path).toBe(`/api/admin/${kind}/resource%20one/availability`);
      expect(first.method).toBe("PUT");
      expect(JSON.parse(first.body)).toEqual(input);
      expect(new Headers(first.headers).get("Idempotency-Key")).toBe(
        new Headers(second.headers).get("Idempotency-Key"),
      );
      expect(sessionStorage.length).toBe(0);
    },
  );

  it("preserves structured references without retrying or modifying them", async () => {
    const details = {
      code: "resource_in_use",
      message: "Referenced",
      references: [{ kind: "template", resource_id: "template-1" }],
      references_truncated: true,
    };
    const fetcher = vi
      .fn()
      .mockResolvedValue(Response.json(details, { status: 409 }));
    vi.stubGlobal("fetch", fetcher);
    const failure = await api
      .setCatalogAvailability("model-profiles", "model-1", {
        expected_enabled: true,
        enabled: false,
      })
      .catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(APIError);
    expect(failure).toMatchObject({
      status: 409,
      code: "resource_in_use",
      details,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(sessionStorage.length).toBe(0);
  });

  it("emits a configuration hint only after confirmed configuration writes", async () => {
    const listener = vi.fn();
    window.addEventListener("antnest:configuration-changed", listener);
    try {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce(
            Response.json({ code: "resource_in_use" }, { status: 409 }),
          )
          .mockResolvedValueOnce(
            Response.json({
              resource_id: "model-1",
              enabled: false,
              updated_at: "2026-09-14T00:00:00Z",
            }),
          )
          .mockResolvedValueOnce(Response.json({ synchronization: null }))
          .mockResolvedValueOnce(Response.json({ status: "changed" })),
      );
      const input = { expected_enabled: true, enabled: false };
      await api
        .setCatalogAvailability("model-profiles", "model-1", input)
        .catch(() => {});
      expect(listener).not.toHaveBeenCalled();
      await api.setCatalogAvailability("model-profiles", "model-1", input);
      expect(listener).toHaveBeenCalledTimes(1);
      await api.executionSynchronization();
      await api.changeOwnPassword("test-only-old", "test-only-new");
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("antnest:configuration-changed", listener);
    }
  });

  it("does not notify a new login about an old session's write", async () => {
    let complete!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            complete = resolve;
          }),
      ),
    );
    const listener = vi.fn();
    window.addEventListener("antnest:configuration-changed", listener);
    try {
      const pending = api.setCatalogAvailability("templates", "template-1", {
        expected_enabled: true,
        enabled: false,
      });
      resetSessionRequests();
      complete(
        Response.json({
          resource_id: "template-1",
          enabled: false,
          updated_at: "2026-09-14T00:00:00Z",
        }),
      );
      await pending;
      expect(listener).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("antnest:configuration-changed", listener);
    }
  });
});
