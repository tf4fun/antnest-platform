import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, resetSessionRequests } from "./api";

const principal = { organization_id: "org-1", user_id: "user-1", membership_id: "member-1" };
const replacement = { principal: { ...principal, organization_name: "Engineering", organization_slug: "engineering", system_role: "admin", organization_role: "admin", active: true }, expires_at: "2026-10-12T00:00:00Z", idle_expires_at: "2026-10-11T12:30:00Z", activity_interval_ms: 10000 };
let cookie: string;

beforeEach(() => {
  cookie = "__Host-antnest_csrf=session-one";
  vi.spyOn(document, "cookie", "get").mockImplementation(() => cookie);
  resetSessionRequests(principal);
});

afterEach(() => {
  vi.restoreAllMocks();
  resetSessionRequests();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

it.each([200, 204, 401])("discards an old %s response and cancels its request after a local session replacement", async (status) => {
  const response = deferred<Response>();
  const fetcher = vi.fn((_path: string, _init?: RequestInit) => response.promise);
  const expired = vi.fn();
  window.addEventListener("antnest:session-expired", expired);
  vi.stubGlobal("fetch", fetcher);
  try {
    const pending = api.directory().catch((error: unknown) => error);
    const signal = fetcher.mock.calls[0]?.[1]?.signal;
    resetSessionRequests(principal);
    response.resolve(status === 204 ? new Response(null, { status }) : Response.json({ users: [], groups: [] }, { status }));
    expect(await pending).toMatchObject({ name: "AbortError" });
    expect(signal?.aborted).toBe(true);
    expect(expired).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener("antnest:session-expired", expired);
  }
});

it.each([200, 204, 401])("requires current-session validation when another tab replaces the Cookie before a %s response", async (status) => {
  const response = deferred<Response>();
  const validate = vi.fn();
  const expired = vi.fn();
  window.addEventListener("antnest:session-validation-required", validate);
  window.addEventListener("antnest:session-expired", expired);
  vi.stubGlobal("fetch", vi.fn(() => response.promise));
  try {
    const pending = api.directory().catch((error: unknown) => error);
    cookie = "__Host-antnest_csrf=session-two";
    response.resolve(status === 204 ? new Response(null, { status }) : Response.json({ users: [], groups: [] }, { status }));
    expect(await pending).toMatchObject({ name: "AbortError" });
    expect(validate).toHaveBeenCalledTimes(1);
    expect(expired).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener("antnest:session-validation-required", validate);
    window.removeEventListener("antnest:session-expired", expired);
  }
});

it.each(["", "__Host-antnest_csrf=session-two"])("does not dispatch a mutation after the Cookie hint becomes %s", async (next) => {
  const fetcher = vi.fn(async () => Response.json({}));
  const validate = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  window.addEventListener("antnest:session-validation-required", validate);
  try {
    cookie = next;
    await expect(api.changeOwnPassword("old synthetic password", "new synthetic password")).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(validate).toHaveBeenCalledTimes(1);
  } finally {
    window.removeEventListener("antnest:session-validation-required", validate);
  }
});

it("validates the new Cookie after password rotation and discards requests from the replaced session", async () => {
  const old = deferred<Response>();
  const fetcher = vi.fn(async (path: string) => {
    if (path === "/api/admin/directory") return old.promise;
    if (path === "/api/session/password") {
      cookie = "__Host-antnest_csrf=session-two";
      return Response.json(replacement);
    }
    if (path === "/api/session") return Response.json(replacement);
    throw new Error(`Unexpected request ${path}`);
  });
  vi.stubGlobal("fetch", fetcher);
  const pending = api.directory().catch((error: unknown) => error);
  const result = await api.changeOwnPassword("old synthetic password", "new synthetic password");
  expect(result).toEqual(replacement);
  expect(fetcher.mock.calls.map(([path]) => path)).toEqual(["/api/admin/directory", "/api/session/password", "/api/session"]);
  old.resolve(Response.json({ users: [{ stale: true }], groups: [] }));
  expect(await pending).toMatchObject({ name: "AbortError" });
  expect(Object.keys(sessionStorage).filter(key => key.includes("password"))).toEqual([]);
});

it("requires session validation after a password writer unexpectedly returns no content", async () => {
  const validate = vi.fn();
  window.addEventListener("antnest:session-validation-required", validate);
  vi.stubGlobal("fetch", vi.fn(async () => {
    cookie = "__Host-antnest_csrf=session-two";
    return new Response(null, { status: 204 });
  }));
  try {
    await expect(api.changeOwnPassword("old synthetic password", "new synthetic password")).rejects.toMatchObject({ code: "invalid_response" });
    expect(validate).toHaveBeenCalledTimes(1);
  } finally { window.removeEventListener("antnest:session-validation-required", validate); }
});

it.each(["fetch", "body"])("validates Cookie replacement even when artifact %s fails", async stage => {
  let fail!: (cause: Error) => void;
  const failure = new Promise<never>((_resolve, reject) => { fail = reject; });
  const response = new Response("synthetic artifact");
  if (stage === "body") vi.spyOn(response, "blob").mockReturnValue(failure);
  vi.stubGlobal("fetch", vi.fn(() => stage === "fetch" ? failure : Promise.resolve(response)));
  const validate = vi.fn();
  window.addEventListener("antnest:session-validation-required", validate);
  try {
    const pending = api.skillArtifact("skill-1", 1).catch((error: unknown) => error);
    await Promise.resolve();
    cookie = "__Host-antnest_csrf=session-two";
    fail(new TypeError("Download interrupted"));
    expect(await pending).toMatchObject({ name: "AbortError" });
    expect(validate).toHaveBeenCalledTimes(1);
  } finally { window.removeEventListener("antnest:session-validation-required", validate); }
});

it.each([0, 30001, 1.5, undefined])("rejects a session without a usable activity hint %s", async hint => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...replacement, activity_interval_ms: hint })));
  await expect(api.session()).rejects.toMatchObject({ code: "invalid_response" });
});

it("requires a fresh login when a validated session still has no delivery hint", async () => {
  cookie = "";
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(replacement)));
  await expect(api.session()).rejects.toMatchObject({ status: 401 });
});

it.each(["generation", "cookie", "signal"])("does not accept a session when %s changes between the response check and session commit", async change => {
  const body = deferred<string>();
  const response = Response.json(replacement);
  vi.spyOn(response, "text").mockReturnValue(body.promise);
  vi.stubGlobal("fetch", vi.fn(async () => response));
  const controller = new AbortController();
  const pending = api.session(controller.signal).catch((error: unknown) => error);
  await Promise.resolve();
  expect(response.text).toHaveBeenCalledTimes(1);
  void body.promise.then(() => {
    if (change === "generation") resetSessionRequests({ ...principal, user_id: "new-user" });
    else if (change === "signal") controller.abort();
    else cookie = "__Host-antnest_csrf=next-tab";
  });
  body.resolve(JSON.stringify(replacement));
  expect(await pending).toMatchObject({ name: "AbortError" });
});

it.each([400, 503])("preserves the current session and never replays a password command after %s", async (status) => {
  const fetcher = vi.fn(async (_path: string) => Response.json({ code: status === 400 ? "invalid_current_password" : "identity_unavailable" }, { status }));
  const expired = vi.fn();
  window.addEventListener("antnest:session-expired", expired);
  vi.stubGlobal("fetch", fetcher);
  try {
    await expect(api.changeOwnPassword("old synthetic password", "new synthetic password")).rejects.toMatchObject({ status });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/session/password");
    expect(expired).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener("antnest:session-expired", expired);
  }
});

it("rejects artifact bytes and a deferred upload prepared under an old session", async () => {
  const response = deferred<Response>();
  const bytes = deferred<ArrayBuffer>();
  const fetcher = vi.fn(() => response.promise);
  vi.stubGlobal("fetch", fetcher);
  const download = api.skillArtifact("skill-1", 1).catch((error: unknown) => error);
  const file = new File(["synthetic zip"], "skill.zip");
  Object.defineProperty(file, "arrayBuffer", { value: () => bytes.promise });
  const upload = api.publishSkill(file).catch((error: unknown) => error);
  resetSessionRequests(principal);
  response.resolve(new Response("old private artifact"));
  bytes.resolve(new ArrayBuffer(8));
  expect(await download).toMatchObject({ name: "AbortError" });
  expect(await upload).toMatchObject({ name: "AbortError" });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("Console writes and logout deliver the prefixed session-bound CSRF token", async () => {
  cookie = "antnest_csrf=planted; __Host-antnest_csrf=bound-session-token";
  resetSessionRequests(principal);
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
