import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, resetSessionRequests } from "./api";

const principal = { organization_id: "org-1", user_id: "user-1", membership_id: "membership-1" };
let cookie: string;
beforeEach(() => {
  cookie = "__Host-antnest_csrf=external-session";
  vi.spyOn(document, "cookie", "get").mockImplementation(() => cookie);
  resetSessionRequests(principal);
});
afterEach(() => { vi.restoreAllMocks(); resetSessionRequests(); sessionStorage.clear(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

const calls = () => [
  () => api.externalIdentities({ afterID: "binding.1", noticeAfterID: "notice-1" }),
  () => api.externalIdentityProviders("provider-1"),
  () => api.organizationExternalIdentities("membership-1", "binding-1"),
  () => api.bindExternalIdentity("membership-1", { provider_id: "provider-1", subject: "  é 😀  ", restore_revoked: true }),
  () => api.unbindExternalIdentity("binding-1", true),
  () => api.unbindOrganizationExternalIdentity("membership-1", "binding-1", false),
  () => api.acknowledgeExternalIdentityNotices(["notice-1", "notice-3"]),
];

it("uses the Gateway self API and exact Membership BFF paths without browser authority", async () => {
  const fetcher = vi.fn(async (_path: string, _init?: RequestInit) => Response.json({ bindings: [], notices: [], providers: [], revoked_count: 0, current_revoked: false, acknowledged_count: 2 }));
  vi.stubGlobal("fetch", fetcher);
  for (const call of calls()) await call();
  expect(fetcher.mock.calls.map(([path]) => path)).toEqual([
    "/api/session/external-identities?limit=50&after_id=binding.1&notice_after_id=notice-1",
    "/api/admin/directory/identity-providers?limit=50&after_id=provider-1",
    "/api/admin/directory/memberships/membership-1/external-identities?limit=50&after_id=binding-1",
    "/api/admin/directory/memberships/membership-1/external-identities",
    "/api/session/external-identities/binding-1",
    "/api/admin/directory/memberships/membership-1/external-identities/binding-1",
    "/api/session/external-identities/notices/acknowledge",
  ]);
  const writes = fetcher.mock.calls.slice(3).map(([, init]) => init!);
  expect(writes.map(init => init.method)).toEqual(["POST", "DELETE", "DELETE", "POST"]);
  expect(writes.map(init => JSON.parse(String(init.body)))).toEqual([
    { provider_id: "provider-1", subject: "  é 😀  ", restore_revoked: true },
    { allow_lockout: true }, { allow_lockout: false }, { notice_ids: ["notice-1", "notice-3"] },
  ]);
  for (const init of writes) {
    expect(new Headers(init.headers).get("X-Antnest-CSRF-Token")).toBe("external-session");
    expect(new Headers(init.headers).get("Idempotency-Key")).toBeTruthy();
  }
  expect(Object.keys(sessionStorage)).toEqual([]);
});

it.each([0, 1, 2, 3, 4, 5, 6])("invalidates the current view for external identity operation %s returning 401", async index => {
  const expired = vi.fn();
  window.addEventListener("antnest:session-expired", expired);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ code: "unauthenticated" }, { status: 401 })));
  try {
    await expect(calls()[index]!()).rejects.toMatchObject({ status: 401 });
    expect(expired).toHaveBeenCalledTimes(1);
  } finally { window.removeEventListener("antnest:session-expired", expired); }
});

it.each([3, 4, 5, 6])("preserves the view and never replays external identity command %s after 503", async index => {
  const expired = vi.fn();
  const fetcher = vi.fn(async () => Response.json({ code: "dependency_unavailable" }, { status: 503 }));
  vi.stubGlobal("fetch", fetcher);
  window.addEventListener("antnest:session-expired", expired);
  try {
    await expect(calls()[index]!()).rejects.toMatchObject({ status: 503 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(expired).not.toHaveBeenCalled();
    expect(Object.keys(sessionStorage)).toEqual([]);
  } finally { window.removeEventListener("antnest:session-expired", expired); }
});

it.each([4, 5])("retires the current session immediately after committed unbind %s without logout or refresh", async index => {
  const expired = vi.fn();
  window.addEventListener("antnest:session-expired", expired);
  const fetcher = vi.fn(async () => Response.json({ revoked_count: 2, current_revoked: true }));
  vi.stubGlobal("fetch", fetcher);
  try {
    expect(await calls()[index]!()).toEqual({ revoked_count: 2, current_revoked: true });
    expect(expired).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally { window.removeEventListener("antnest:session-expired", expired); }
});

it.each(["generation", "cookie"])("discards delayed body success and 401 after %s replacement", async change => {
  for (const index of [0, 4, 6]) for (const status of [200, 401]) {
    resetSessionRequests(principal);
    const body = deferred<string>();
    const response = new Response(null, { status });
    vi.spyOn(response, "text").mockReturnValue(body.promise);
    const fetcher = vi.fn(async () => response);
    vi.stubGlobal("fetch", fetcher);
    const expired = vi.fn();
    window.addEventListener("antnest:session-expired", expired);
    try {
      const pending = calls()[index]!().catch((error: unknown) => error);
      await Promise.resolve();
      expect(response.text).toHaveBeenCalledTimes(1);
      if (change === "generation") resetSessionRequests({ ...principal, membership_id: "replacement" });
      else cookie += "-replacement";
      body.resolve(JSON.stringify({ revoked_count: 1, current_revoked: true, code: "unauthenticated" }));
      expect(await pending).toMatchObject({ name: "AbortError" });
      expect(expired).not.toHaveBeenCalled();
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally { window.removeEventListener("antnest:session-expired", expired); }
  }
});

it("never dispatches a destructive command prepared for another Cookie", async () => {
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  cookie = "__Host-antnest_csrf=replacement";
  await expect(api.unbindExternalIdentity("binding-1", true)).rejects.toMatchObject({ name: "AbortError" });
  expect(fetcher).not.toHaveBeenCalled();
});
