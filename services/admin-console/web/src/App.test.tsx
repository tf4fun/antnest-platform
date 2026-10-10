import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import App from "./App";
import { api, APIError } from "./lib/api";
import type { Session } from "./lib/types";

afterEach(() => {
  cleanup();
  window.location.hash = "";
  sessionStorage.clear();
});

const session: Session = {
  principal: {
    user_id: "admin-1", organization_id: "org-1", membership_id: "membership-1",
    system_role: "admin", organization_role: "admin", active: true,
  },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function application(
  logout: () => Promise<Response>,
  compact = false,
  readSession = async () => Response.json(session),
  changePassword = async () => Response.json({ status: "changed" }),
) {
  vi.stubGlobal("matchMedia", vi.fn(() => ({
    matches: compact, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })));
  vi.stubGlobal("scrollTo", vi.fn());
  const request = vi.fn(async (input: string, init: RequestInit) => {
    if (input === "/api/session") {
      return init.method === "DELETE" ? logout() : readSession();
    }
    switch (input) {
      case "/api/admin/account/password": return changePassword();
      case "/api/admin/account": return Response.json({ account: {
        email: "admin@example.com", display_name: "Test administrator", source: "local",
        organization_slug: "test", organization_name: "Test organization", local_password_available: true,
      } });
      case "/api/admin/directory": return Response.json({ users: [], groups: [] });
      case "/api/session/login-methods": return Response.json({ methods: [] });
      case "/api/session/login": return Response.json(session);
      default: throw new Error(`Unexpected request: ${init.method} ${input}`);
    }
  });
  vi.stubGlobal("fetch", request);
  window.location.hash = "directory";
  render(<App />);
  return request;
}

async function signInAgain() {
  await screen.findByRole("heading", { name: "Welcome back" });
  fireEvent.change(screen.getByRole("textbox", { name: "Email" }), { target: { value: "admin@example.com" } });
  fireEvent.change(screen.getByLabelText("Password", { exact: true }), { target: { value: "test-password" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  await screen.findByRole("heading", { name: "Directory" });
}

it("keeps the execution audit navigation reachable without an Agent lookup", async () => {
  application(async () => new Response(null, { status: 204 }));
  await screen.findByRole("heading", { name: "Directory" });
  expect(screen.getByRole("link", { name: "Execution history" }).getAttribute("href")).toBe("#audits");
});

it.each(["invalid_current_password", "unauthenticated"])("handles password command %s through the real API and session owner", async (code) => {
  const logout = vi.fn(async () => new Response(null, { status: 204 }));
  const change = vi.fn(async () => Response.json({ code, message: "Password command rejected" }, { status: 401 }));
  application(logout, false, async () => Response.json(session), change);
  fireEvent.click(await screen.findByRole("button", { name: "Change local password" }));
  fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "synthetic old password" } });
  for (const name of ["New password", "Confirm new password"]) {
    fireEvent.change(screen.getByLabelText(name), { target: { value: "synthetic new password" } });
  }
  fireEvent.click(screen.getByRole("button", { name: "Update password" }));
  if (code === "invalid_current_password") {
    expect((await screen.findByRole("alert")).textContent).toContain("Password command rejected");
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Welcome back" })).toBeNull();
  } else {
    await signInAgain();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Change local password" }));
    for (const name of ["Current password", "New password", "Confirm new password"]) {
      expect((screen.getByLabelText(name) as HTMLInputElement).value).toBe("");
    }
  }
  expect(change).toHaveBeenCalledTimes(1);
  expect(logout).not.toHaveBeenCalled();
});

it.each(["json", "malformed", "unreadable"])("ignores an old password request's late %s 401 after login", async (format) => {
  const command = deferred<Response>();
  const change = vi.fn(() => command.promise);
  application(async () => new Response(null, { status: 204 }), false, async () => Response.json(session), change);
  fireEvent.click(await screen.findByRole("button", { name: "Change local password" }));
  for (const name of ["Current password", "New password", "Confirm new password"]) {
    fireEvent.change(screen.getByLabelText(name), { target: { value: "synthetic password" } });
  }
  fireEvent.click(screen.getByRole("button", { name: "Update password" }));
  act(() => window.dispatchEvent(new Event("antnest:session-expired")));
  await signInAgain();
  const response = format === "json"
    ? Response.json({ code: "unauthenticated" }, { status: 401 })
    : new Response("not JSON", { status: 401 });
  if (format === "unreadable") vi.spyOn(response, "text").mockRejectedValue(new TypeError("Body interrupted"));
  await act(async () => command.resolve(response));
  expect(screen.getByRole("heading", { name: "Directory" })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Welcome back" })).toBeNull();
  expect(change).toHaveBeenCalledTimes(1);
});

it.each(["start", "end"])("invalidates pending request notifications on session %s independently", async (boundary) => {
  const command = deferred<Response>();
  function pendingRead() {
    vi.stubGlobal("fetch", vi.fn(() => command.promise));
    return api.currentAccount().catch((error: unknown) => error);
  }
  const beforeStart = boundary === "start" ? pendingRead() : undefined;
  application(async () => new Response(null, { status: 204 }));
  await screen.findByRole("heading", { name: "Directory" });
  const pending = beforeStart ?? pendingRead();
  if (boundary === "end") {
    act(() => window.dispatchEvent(new Event("antnest:session-expired")));
    await screen.findByRole("heading", { name: "Welcome back" });
  }
  const expired = vi.fn();
  window.addEventListener("antnest:session-expired", expired);
  try {
    await act(async () => {
      command.resolve(Response.json({ code: "unauthenticated" }, { status: 401 }));
      expect(await pending).toBeInstanceOf(APIError);
    });
    expect(expired).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener("antnest:session-expired", expired);
  }
});

it.each([204, 401])("ends a confirmed or already invalid session after logout %s and prevents duplicate sign-out", async (status) => {
  const command = deferred<Response>();
  const logout = vi.fn(() => command.promise);
  const request = application(logout);
  const button = await screen.findByRole("button", { name: "Sign out" });
  fireEvent.click(button);
  expect((button as HTMLButtonElement).disabled).toBe(true);
  expect(button.getAttribute("aria-busy")).toBe("true");
  fireEvent.click(button);
  expect(logout).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("heading", { name: "Welcome back" })).toBeNull();
  expect(screen.getByRole("heading", { name: "Directory" })).toBeTruthy();
  const call = request.mock.calls.find(([, init]) => init.method === "DELETE");
  expect(call?.[0]).toBe("/api/session");
  expect(call?.[1].credentials).toBe("same-origin");
  await act(async () => command.resolve(new Response(null, { status })));
  expect(await screen.findByRole("heading", { name: "Welcome back" })).toBeTruthy();
  expect(screen.queryByRole("navigation", { name: "Primary navigation" })).toBeNull();
});

it.each(["unavailable", "network", "forbidden"] as const)("keeps a %s logout failure visible without pretending to sign out", async (failure) => {
  const logout = vi.fn(async () => {
    if (failure === "network") throw new TypeError("Failed to fetch");
    return Response.json({ message: failure === "forbidden" ? "Request could not be verified" : "Session could not be revoked" }, {
      status: failure === "forbidden" ? 403 : 503,
    });
  });
  application(logout);
  fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
  expect((await screen.findByRole("alert")).textContent).toMatch(/sign out could not be confirmed/i);
  expect(screen.queryByRole("heading", { name: "Welcome back" })).toBeNull();
  const button = screen.getByRole("button", { name: "Sign out" });
  expect((button as HTMLButtonElement).disabled).toBe(false);
  expect(logout).toHaveBeenCalledTimes(1);
  logout.mockResolvedValueOnce(new Response(null, { status: 204 }));
  fireEvent.click(button);
  expect(await screen.findByRole("heading", { name: "Welcome back" })).toBeTruthy();
  expect(logout).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("alert")).toBeNull();
});

it.each(["logout", "expiration"] as const)("does not carry an open drawer or account dialog across %s and login", async (ending) => {
  const logout = vi.fn(async () => new Response(null, { status: 204 }));
  application(logout, true);
  fireEvent.click(await screen.findByRole("button", { name: "Open navigation" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Open navigation", hidden: true }).getAttribute("aria-expanded")).toBe("true"));
  if (ending === "logout") {
    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
  } else {
    fireEvent.click(await screen.findByRole("button", { name: "Change local password" }));
    await screen.findByRole("dialog");
    act(() => window.dispatchEvent(new Event("antnest:session-expired")));
  }
  await signInAgain();
  expect(screen.getByRole("button", { name: "Open navigation" }).getAttribute("aria-expanded")).toBe("false");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(logout).toHaveBeenCalledTimes(ending === "logout" ? 1 : 0);
});

it.each([204, 401, 503])("ignores an old logout's late HTTP %s after expiration and a new login", async (status) => {
  const command = deferred<Response>();
  const logout = vi.fn(() => command.promise);
  application(logout);
  fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
  act(() => window.dispatchEvent(new Event("antnest:session-expired")));
  await signInAgain();
  await act(async () => command.resolve(status === 204
    ? new Response(null, { status })
    : Response.json({ message: "Old logout unavailable" }, { status })));
  expect(screen.getByRole("heading", { name: "Directory" })).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  expect((screen.getByRole("button", { name: "Sign out" }) as HTMLButtonElement).disabled).toBe(false);
  expect(logout).toHaveBeenCalledTimes(1);
});

it.each([
  [403, "Console access denied"], [404, "Console not found"], [410, "Console not found"],
] as const)("does not offer or automatically issue a retry after startup HTTP %s", async (status, heading) => {
  const read = vi.fn(async () => Response.json({ message: "Session endpoint rejected access" }, { status }));
  const request = application(async () => new Response(null, { status: 204 }), false, read);
  expect(await screen.findByRole("heading", { name: heading })).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toContain("Session endpoint rejected access");
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  expect(screen.queryByRole("navigation")).toBeNull();
  expect(screen.getByRole("link", { name: "Open Agent workspace" }).getAttribute("href")).toBe("/workspace/");
  expect(read).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledTimes(1);
});

it("opens login on startup 401 without treating it as an outage", async () => {
  application(async () => new Response(null, { status: 204 }), false,
    async () => Response.json({ message: "Session expired" }, { status: 401 }));
  expect(await screen.findByRole("heading", { name: "Welcome back" })).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
});

it.each(["HTTP", "network"] as const)("retries only the session read after a startup %s failure", async (failure) => {
  const response = deferred<Response>();
  const read = vi.fn(async () => {
    if (failure === "network") throw new TypeError("Network unavailable");
    return Response.json({ message: "Identity unavailable" }, { status: 503 });
  });
  const request = application(async () => new Response(null, { status: 204 }), false, read);
  await screen.findByRole("alert");
  expect(request).toHaveBeenCalledTimes(1);
  read.mockImplementationOnce(() => response.promise);
  const retry = screen.getByRole("button", { name: "Retry" });
  fireEvent.click(retry);
  expect((retry as HTMLButtonElement).disabled).toBe(true);
  expect(retry.getAttribute("aria-busy")).toBe("true");
  expect(screen.getByRole("alert")).toBeTruthy();
  fireEvent.click(retry);
  expect(request).toHaveBeenCalledTimes(2);
  await act(async () => response.resolve(Response.json(session)));
  expect(await screen.findByRole("heading", { name: "Directory" })).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(read).toHaveBeenCalledTimes(2);
});
