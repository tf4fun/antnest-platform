import { afterEach, expect, it, vi } from "vitest";
import { api, resetSessionRequests } from "./api";

afterEach(() => {
  vi.restoreAllMocks();
  resetSessionRequests();
});

it("Console writes and logout deliver the prefixed session-bound CSRF token", async () => {
  vi.spyOn(document, "cookie", "get").mockReturnValue(
    "antnest_csrf=planted; __Host-antnest_csrf=bound-session-token",
  );
  const fetcher = vi.fn()
    .mockResolvedValueOnce(Response.json({ resource_id: "template", enabled: false, updated_at: "2026-10-10T00:00:00Z" }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetcher);
  await api.setCatalogAvailability("templates", "template", { expected_enabled: true, enabled: false });
  await api.logout();
  expect(fetcher.mock.calls.map(([, init]) => init.method)).toEqual(["PUT", "DELETE"]);
  for (const [, init] of fetcher.mock.calls) {
    expect(new Headers(init.headers).get("X-Antnest-CSRF-Token")).toBe("bound-session-token");
    expect(init.credentials).toBe("same-origin");
  }
});
