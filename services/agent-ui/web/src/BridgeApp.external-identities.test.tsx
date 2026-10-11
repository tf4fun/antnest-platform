import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import BridgeApp from "./BridgeApp";

const session = {
  principal: { user_id: "user-1", organization_id: "org-1", membership_id: "member-1", organization_slug: "engineering", organization_name: "Engineering", system_role: "user", organization_role: "member", active: true },
  expires_at: "2026-10-12T00:00:00Z", idle_expires_at: "2026-10-11T12:30:00Z", activity_interval_ms: 1666,
};
const bootstrap = { principal: { organizationSlug: "engineering", organizationName: "Engineering", userId: "user-1", organizationId: "org-1", administrator: false }, agents: [], renderedAt: "2026-10-11T12:00:00Z", bridgeEpoch: "epoch-1" };
const details = { provider_id: "provider-2", provider_name: "workforce", provider_display_name: "Workforce", organization_id: "org-2", organization_slug: "research", organization_name: "Research", membership_id: "member-2", subject: "  <script>private subject</script>  ", method: "admin", created_at: "2026-10-10T00:00:00Z" };
const inventory = { bindings: [{ ...details, id: "binding-2", bound_at: "2026-10-11T00:00:00Z", revoked_at: null, provider_enabled: true }], notices: [{ ...details, id: "notice-2", binding_id: "binding-2" }] };
const base = "/api/session/external-identities";
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
beforeEach(() => {
  window.history.replaceState(null, "", "/workspace");
  vi.spyOn(document, "cookie", "get").mockReturnValue("antnest_csrf=csrf");
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value() { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value() { this.open = false; } });
});
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
});

test.each([200, 503])("ordinary members can review external notices without an Agent, even with bootstrap status %s", async status => {
  const writes: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method && init.method !== "GET") writes.push(path);
    if (path === "/api/session") return Response.json(session);
    if (path.endsWith("/bootstrap")) return Response.json(status === 200 ? bootstrap : { code: "unavailable", message: "Workspace unavailable" }, { status });
    if (path.startsWith(base)) return Response.json(inventory);
    if (path === "/api/session/account") return Response.json({ account: { user_id: session.principal.user_id, organization_id: session.principal.organization_id, membership_id: session.principal.membership_id, email: "member@example.test", display_name: "Member", source: "scim", local_password_available: false } });
    if (path.startsWith("/api/session/sessions")) return Response.json({ sessions: [] });
    throw new Error(`Unexpected ${path}`);
  }));
  render(<BridgeApp />);
  fireEvent.click(await screen.findByRole("button", { name: "Review external login notices" }));
  const panel = within(await screen.findByRole("dialog", { name: "Account and sessions" }));
  expect(await panel.findByRole("heading", { name: "External logins" })).toBeTruthy();
  expect(panel.getAllByText("Research")).toHaveLength(2);
  expect(panel.getAllByText((_, element) => element?.tagName === "CODE" && element.textContent === details.subject)).toHaveLength(2);
  expect(panel.queryByRole("button", { name: "Update password" })).toBeNull();
  expect(writes).toEqual([]);
  fireEvent.click(panel.getByRole("button", { name: "Close account and sessions" }));
  expect(screen.getByRole("button", { name: "Review external login notices" })).toBeTruthy();
});

test("SSR does not read bindings or notices until browser credentials are freshly validated", async () => {
  const validation = deferred<Response>();
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input); calls.push(path);
    if (path === "/api/session") return validation.promise;
    if (path.endsWith("/bootstrap")) return Response.json(bootstrap);
    if (path.startsWith(base)) return Response.json(inventory);
    throw new Error(`Unexpected ${path}`);
  }));
  render(<BridgeApp initialBootstrap={bootstrap} initialRoute={{ agentId: "", sessionId: null }} />);
  await waitFor(() => expect(calls).toEqual(["/api/session"]));
  expect(screen.queryByRole("button", { name: "Review external login notices" })).toBeNull();
  await act(async () => { validation.resolve(Response.json(session)); });
  expect(await screen.findByRole("button", { name: "Review external login notices" })).toBeTruthy();
  expect(calls.filter(path => path.startsWith(base))).toEqual([base + "?limit=50"]);
});
