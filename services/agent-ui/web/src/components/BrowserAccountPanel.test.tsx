import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { BrowserAccountPanel } from "./BrowserAccountPanel";
import { BrowserSessionClient } from "../lib/browser-session";

const metadata = { expires_at: "2026-10-12T00:00:00Z", idle_expires_at: "2026-10-11T12:30:00Z", activity_interval_ms: 1666 };
const session = { ...metadata, principal: { user_id: "user-1", organization_id: "org-1", membership_id: "member-1",
  organization_slug: "engineering", organization_name: "Engineering", system_role: "user", organization_role: "member", active: true } };
const account = { user_id: "user-1", organization_id: "org-1", membership_id: "member-1", email: "person@example.test", display_name: "Person", source: "scim", local_password_available: false };
const entry = (id: string) => ({ id, organization_id: "org-1", organization_slug: "engineering", organization_name: "Engineering",
  ...metadata, created_at: "2026-10-11T12:00:00Z", last_active_at: "2026-10-11T12:05:00Z", user_agent_hint: '<img src=x onerror="alert(1)">', current: id === "first" });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const dialogDescriptors = Object.getOwnPropertyDescriptors(HTMLDialogElement.prototype);
beforeAll(() => {
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value(this: HTMLDialogElement) { this.setAttribute("open", ""); } },
    close: { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute("open"); } },
  });
});
afterAll(() => {
  for (const name of ["showModal", "close"]) {
    const descriptor = dialogDescriptors[name];
    if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, name, descriptor);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, name);
  }
});

async function setup(local = false) {
  let hint = "csrf-old";
  let status = 200;
  const calls: { path: string; init?: RequestInit }[] = [];
  const events: string[] = [];
  const client = new BrowserSessionClient({ csrf: () => hint, fetch: async (input, init) => {
    const path = String(input); calls.push({ path, init });
    if (path === "/api/session") return Response.json(session);
    if (path === "/api/session/account") return Response.json({ account: { ...account, local_password_available: local } });
    if (path === "/api/session/sessions?limit=50") return Response.json({ sessions: [entry("first")], next_after_id: "next" });
    if (path.endsWith("after_id=next")) return Response.json({ sessions: [entry("second")] });
    if (path.endsWith("/password")) {
      if (status !== 200) return Response.json({ code: "invalid_current_password", message: "Current password is incorrect." }, { status });
      hint = "csrf-replacement"; return Response.json(session);
    }
    if (path.endsWith("/revoke")) return Response.json(status === 200
      ? { revoked_count: 2, current_revoked: JSON.parse(String(init?.body)).mode === "all" }
      : { code: "unavailable", message: "Session service is unavailable." }, { status });
    throw new Error(`Unexpected ${path}`);
  } });
  await client.read();
  client.subscribe(event => events.push(event.type));
  const close = vi.fn();
  const rendered = render(<BrowserAccountPanel client={client} onClose={close} />);
  await screen.findByText("person@example.test");
  return { client, calls, events, close, rendered, status: (value: number) => { status = value; }, hint: (value: string) => { hint = value; } };
}

test("OIDC-only account exposes paginated sessions and escaped agent hints without password controls", async () => {
  const { calls, client } = await setup();
  expect(screen.queryByLabelText("Current password")).toBeNull();
  expect(screen.getByRole("button", { name: "Sign out other sessions" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Sign out all sessions" })).toBeTruthy();
  expect(screen.getByText('<img src=x onerror="alert(1)">')).toBeTruthy();
  expect(document.querySelector("dialog img")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Load more sessions" }));
  await waitFor(() => expect(screen.getAllByText('<img src=x onerror="alert(1)">')).toHaveLength(2));
  expect(calls.some(call => call.path.endsWith("after_id=next"))).toBe(true);
  client.dispose();
});

test("revoke requires confirmation and a 503 preserves authentication without replay", async () => {
  const { client, calls, status, events } = await setup();
  status(503);
  fireEvent.click(screen.getByRole("button", { name: "Sign out other sessions" }));
  expect(calls.filter(call => call.path.endsWith("/revoke"))).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Confirm sign out other sessions" }));
  expect(await screen.findByText("Session service is unavailable.")).toBeTruthy();
  expect(calls.filter(call => call.path.endsWith("/revoke"))).toHaveLength(1);
  expect(events).toEqual([]);
  expect(client.capture().hint).toBe("csrf-old");
  client.dispose();
});

test("replacement between opening confirmation and confirming sends no old command", async () => {
  const { client, calls, hint, events } = await setup();
  fireEvent.click(screen.getByRole("button", { name: "Sign out all sessions" }));
  hint("another-tab");
  fireEvent.click(screen.getByRole("button", { name: "Confirm sign out all sessions" }));
  await act(async () => {});
  expect(calls.filter(call => call.path.endsWith("/revoke"))).toHaveLength(0);
  expect(events).toEqual(["validation_required"]);
  client.dispose();
});

test("self-all ends the current instance without logout or Cookie replay", async () => {
  const { client, calls, events } = await setup();
  fireEvent.click(screen.getByRole("button", { name: "Sign out all sessions" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm sign out all sessions" }));
  await waitFor(() => expect(events).toEqual(["ended"]));
  expect(calls.filter(call => call.init?.method === "DELETE")).toHaveLength(0);
  expect(calls.filter(call => call.path.endsWith("/revoke"))).toHaveLength(1);
  client.dispose();
});

test("password errors preserve the session and success performs fresh validation before closing", async () => {
  const { client, status, calls, close, events } = await setup(true);
  fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "current-password" } });
  fireEvent.change(screen.getByLabelText("New password"), { target: { value: "replacement-password" } });
  fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "replacement-password" } });
  status(400);
  fireEvent.click(screen.getByRole("button", { name: "Update password" }));
  expect(await screen.findByText("Current password is incorrect.")).toBeTruthy();
  expect(events).toEqual([]);
  expect(close).not.toHaveBeenCalled();
  status(200);
  fireEvent.click(screen.getByRole("button", { name: "Update password" }));
  await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  expect(events).toEqual(["transition", "ready"]);
  expect(calls.filter(call => call.path === "/api/session")).toHaveLength(2);
  expect(client.capture().hint).toBe("csrf-replacement");
  client.dispose();
});

test("StrictMode replacement keeps old aborted loads from changing the new panel", async () => {
  const { StrictMode } = await import("react");
  const loads: Array<{ path: string; resolve: (response: Response) => void; signal: AbortSignal }> = [];
  const client = new BrowserSessionClient({ csrf: () => "csrf", fetch: async (path, init) => {
    if (String(path) === "/api/session") return Response.json(session);
    return new Promise<Response>(resolve => loads.push({ path: String(path), resolve, signal: init!.signal! }));
  } });
  await client.read();
  render(<StrictMode><BrowserAccountPanel client={client} onClose={() => {}} /></StrictMode>);
  await waitFor(() => expect(loads).toHaveLength(4));
  await act(async () => {});
  expect(loads[0]!.signal.aborted).toBe(true);
  expect(loads[1]!.signal.aborted).toBe(true);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByText("Loading sessions…")).toBeTruthy();
  await act(async () => {
    for (const load of loads.slice(2)) load.resolve(Response.json(load.path.endsWith("/account")
      ? { account } : { sessions: [entry("first")] }));
  });
  expect(await screen.findByText("person@example.test")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  client.dispose();
});
