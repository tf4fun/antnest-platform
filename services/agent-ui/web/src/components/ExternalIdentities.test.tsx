import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode, useEffect, useState } from "react";
import { afterEach, expect, test } from "vitest";
import { BrowserSessionClient, type ExternalIdentity, type ExternalIdentityNotice } from "../lib/browser-session";
import { useExternalIdentities } from "../lib/use-external-identities";
import { ExternalIdentitiesSection, ExternalIdentityBanner } from "./ExternalIdentities";

const clients: BrowserSessionClient[] = [];
afterEach(() => { cleanup(); for (const client of clients.splice(0)) client.dispose(); });
const session = { principal: { user_id: "user-1", organization_id: "org-1", membership_id: "member-1", organization_slug: "engineering", organization_name: "Engineering", system_role: "user", organization_role: "member", active: true }, expires_at: "2026-10-12T00:00:00Z", idle_expires_at: "2026-10-11T12:30:00Z", activity_interval_ms: 1666 };
const base = "/api/session/external-identities";
const binding: ExternalIdentity = { id: "binding-1", provider_id: "provider-1", provider_name: "workforce", provider_display_name: "Workforce", organization_id: "org-2", organization_slug: "research", organization_name: "Research", membership_id: "member-2", subject: "  <img src=x onerror=alert(1)> é 😀  ", method: "scim", provider_enabled: false, created_at: "2026-10-10T00:00:00Z", bound_at: "2026-10-11T01:00:00Z", revoked_at: null };
const notice: ExternalIdentityNotice = { id: "notice-1", binding_id: "historical-binding", provider_id: "old-provider", provider_name: "old", provider_display_name: "Old provider", organization_id: "old-org", organization_slug: "historical", organization_name: "Historical organization", membership_id: "old-member", subject: "historical subject", method: "auto", created_at: "2026-10-10T00:00:00Z" };
const inventory = { bindings: [binding], notices: [notice] };
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
async function clientFor(fetcher: (path: string, init: RequestInit) => Response | Promise<Response>) {
  const client = new BrowserSessionClient({ csrf: () => "csrf", fetch: async (input, init) => String(input) === "/api/session" ? Response.json(session) : fetcher(String(input), init!) });
  clients.push(client); await client.read(); return client;
}
function Harness({ client, enabled = true, initialOpen = false }: { client: BrowserSessionClient; enabled?: boolean; initialOpen?: boolean }) {
  const model = useExternalIdentities(client, enabled);
  const [open, setOpen] = useState(initialOpen), [active, setActive] = useState(true);
  useEffect(() => client.subscribe(event => { if (["ended", "validation_required", "transition"].includes(event.type)) setActive(false); }), [client]);
  if (!active) return <p>Session ended</p>;
  return <><ExternalIdentityBanner model={model} onReview={() => setOpen(true)} /><button onClick={() => setOpen(true)}>Open account</button>
    {open ? <div role="dialog" aria-label="Account"><ExternalIdentitiesSection model={model} /><button onClick={() => setOpen(false)}>Close account</button></div> : null}</>;
}

test("background notices work without an Agent or local password and render historical plaintext snapshots", async () => {
  const paths: string[] = [];
  const client = await clientFor(path => { paths.push(path); return Response.json(inventory); });
  render(<Harness client={client} />);
  fireEvent.click(await screen.findByRole("button", { name: "Review external login notices" }));
  const dialog = within(screen.getByRole("dialog"));
  expect(dialog.getByText("Research", { exact: true })).toBeTruthy();
  expect(dialog.getByText("Historical organization")).toBeTruthy();
  expect(dialog.getByText((_, node) => node?.tagName === "CODE" && node.textContent === binding.subject)).toBeTruthy();
  expect(screen.getByRole("dialog").querySelector("img")).toBeNull();
  expect(dialog.getByText("Provider disabled")).toBeTruthy();
  expect(dialog.getByText(`Linked by scim · ${new Date(binding.bound_at).toLocaleString()}`)).toBeTruthy();
  expect(dialog.getByText(`Linked by auto · ${new Date(notice.created_at).toLocaleString()}`)).toBeTruthy();
  expect(paths).toEqual([base + "?limit=50"]);
});

test("binding and notice paging preserve the other stream's rows and cursor", async () => {
  const paths: string[] = [];
  const client = await clientFor(path => {
    paths.push(path);
    if (path.includes("notice_after_id=")) return Response.json({ bindings: [], notices: [{ ...notice, id: "notice-2", subject: "second notice" }] });
    if (path.includes("after_id=")) return Response.json({ bindings: [{ ...binding, id: "binding-2", subject: "second binding" }], notices: [] });
    return Response.json({ ...inventory, next_after_id: "binding-1", next_notice_after_id: "notice-1" });
  });
  render(<Harness client={client} initialOpen />);
  fireEvent.click(await screen.findByRole("button", { name: "Load more bindings" }));
  await screen.findByText("second binding");
  expect(screen.getByText("historical subject")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Load more notices" }));
  await screen.findByText("second notice");
  expect(screen.getByText("second binding")).toBeTruthy();
  expect(paths).toEqual([base + "?limit=50", base + "?limit=50&after_id=binding-1", base + "?limit=50&notice_after_id=notice-1"]);
});

test("503 and duplicate clicks preserve notices without replay; an old ACK cannot clear a new notice", async () => {
  const sent: unknown[] = [], response = deferred<Response>();
  let reads = 0;
  const client = await clientFor((_path, init) => {
    if (init.method === "POST") { sent.push(JSON.parse(String(init.body))); return sent.length === 1 ? response.promise : Response.json({ acknowledged_count: 0 }); }
    return Response.json({ bindings: [binding], notices: [++reads > 1 ? { ...notice, id: "notice-2", subject: "new notice" } : notice] });
  });
  render(<Harness client={client} initialOpen />);
  const ack = await screen.findByRole("button", { name: "Acknowledge Old provider in Historical organization" });
  fireEvent.click(ack); fireEvent.click(ack);
  await act(async () => { response.resolve(Response.json({ code: "unavailable", message: "Acknowledgment unavailable" }, { status: 503 })); });
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Acknowledgment unavailable");
  expect(sent).toHaveLength(1); expect(screen.getByText("historical subject")).toBeTruthy();
  fireEvent.click(ack);
  await waitFor(() => expect(screen.queryByText("historical subject")).toBeNull());
  expect(sent).toEqual([{ notice_ids: ["notice-1"] }, { notice_ids: ["notice-1"] }]);
  expect(reads).toBe(1);
  fireEvent.click(screen.getByRole("button", { name: "Refresh external logins" }));
  expect(await screen.findByRole("button", { name: "Acknowledge Old provider in Historical organization" })).toBeTruthy();
});

test("last-method unbind needs a second explicit action and current revocation sends no refresh", async () => {
  const sent: unknown[] = [];
  let reads = 0;
  const client = await clientFor((_path, init) => {
    if (init.method === "DELETE") { const input = JSON.parse(String(init.body)); sent.push(input); return input.allow_lockout ? Response.json({ revoked_count: 2, current_revoked: true }) : Response.json({ code: "external_identity_last_method", message: "Last login method" }, { status: 409 }); }
    reads++; return Response.json(inventory);
  });
  render(<Harness client={client} initialOpen />);
  fireEvent.click(await screen.findByRole("button", { name: "Unbind Workforce" }));
  expect(sent).toEqual([]);
  fireEvent.click(screen.getByRole("button", { name: "Confirm unbind" }));
  const allow = await screen.findByRole("button", { name: "Unbind and accept lockout" });
  expect(sent).toEqual([{ allow_lockout: false }]);
  fireEvent.click(allow);
  await screen.findByText("Session ended");
  expect(sent).toEqual([{ allow_lockout: false }, { allow_lockout: true }]);
  expect(reads).toBe(1); expect(screen.queryByText("Research")).toBeNull();
});

test("closing the account retires its destructive confirmation before reopening", async () => {
  const client = await clientFor(() => Response.json(inventory));
  render(<Harness client={client} initialOpen />);
  fireEvent.click(await screen.findByRole("button", { name: "Unbind Workforce" }));
  expect(screen.getByRole("button", { name: "Confirm unbind" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Close account" }));
  fireEvent.click(screen.getByRole("button", { name: "Open account" }));
  expect(screen.queryByRole("button", { name: "Confirm unbind" })).toBeNull();
});

test("a failed inventory refresh retains the displayed bindings and notice", async () => {
  let reads = 0;
  const client = await clientFor(() => ++reads === 1 ? Response.json(inventory) : Response.json({ code: "unavailable", message: "Inventory unavailable" }, { status: 503 }));
  render(<Harness client={client} initialOpen />);
  await screen.findByText("historical subject");
  fireEvent.click(screen.getByRole("button", { name: "Refresh external logins" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Inventory unavailable");
  expect(screen.getByText("historical subject")).toBeTruthy(); expect(screen.getByText("Research")).toBeTruthy();
  expect(reads).toBe(2);
});

test("StrictMode and a replaced client cannot install old private inventory", async () => {
  const pending: Array<{ response: ReturnType<typeof deferred<Response>>; signal: AbortSignal }> = [];
  const client = await clientFor((_path, init) => { const response = deferred<Response>(); pending.push({ response, signal: init.signal! }); return response.promise; });
  const view = render(<StrictMode><Harness client={client} initialOpen /></StrictMode>);
  await waitFor(() => expect(pending).toHaveLength(2));
  expect(pending[0]!.signal.aborted).toBe(true);
  const replacement = await clientFor(() => Response.json({ bindings: [], notices: [] }));
  view.rerender(<Harness key="replacement" client={replacement} initialOpen />);
  await screen.findByText("No external logins to display.");
  await act(async () => { for (const old of pending) old.response.resolve(Response.json(inventory)); });
  expect(pending.every(old => old.signal.aborted)).toBe(true);
  expect(screen.queryByText("Research")).toBeNull(); expect(screen.queryByText("historical subject")).toBeNull();
});

test("disabled SSR does not request external inventory", async () => {
  let reads = 0;
  const client = await clientFor(() => { reads++; return Response.json(inventory); });
  render(<Harness client={client} enabled={false} />);
  await act(async () => {}); expect(reads).toBe(0);
  expect(screen.queryByRole("button", { name: "Review external login notices" })).toBeNull();
});

test("credential replacement before the mounting effect requests validation without throwing or reading private inventory", async () => {
  let hint = "validated", reads = 0;
  const events: string[] = [];
  const client = new BrowserSessionClient({ csrf: () => hint, fetch: async input => {
    if (String(input) === "/api/session") return Response.json(session);
    reads++; return Response.json(inventory);
  } });
  clients.push(client); await client.read();
  const unsubscribe = client.subscribe(event => events.push(event.type));
  hint = "replacement";
  expect(() => render(<Harness client={client} />)).not.toThrow();
  await act(async () => {});
  expect(events).toEqual(["validation_required"]);
  expect(reads).toBe(0);
  expect(screen.queryByText("Research")).toBeNull();
  unsubscribe();
});

test("a noncurrent unbind refreshes once, clears confirmation and renders a read-only tombstone", async () => {
  let reads = 0, writes = 0;
  const client = await clientFor((_path, init) => {
    if (init.method === "DELETE") { writes++; return Response.json({ revoked_count: 1, current_revoked: false }); }
    reads++; return Response.json({ ...inventory, bindings: [{ ...binding, revoked_at: writes ? "2026-10-11T02:00:00Z" : null }] });
  });
  render(<Harness client={client} initialOpen />);
  fireEvent.click(await screen.findByRole("button", { name: "Unbind Workforce" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm unbind" }));
  expect(await screen.findByText("External login unbound. 1 session revoked.")).toBeTruthy();
  await waitFor(() => expect(screen.queryByRole("button", { name: "Confirm unbind" })).toBeNull());
  expect(screen.queryByRole("button", { name: "Unbind Workforce" })).toBeNull();
  expect(screen.getByText(`Revoked · ${new Date("2026-10-11T02:00:00Z").toLocaleString()}`)).toBeTruthy();
  expect(reads).toBe(2); expect(writes).toBe(1);
});

test("acknowledging the visible page keeps the banner while another notice page remains", async () => {
  const client = await clientFor((path, init) => {
    if (init.method === "POST") return Response.json({ acknowledged_count: 1 });
    if (path.includes("notice_after_id=")) return Response.json({ bindings: [], notices: [{ ...notice, id: "notice-2", subject: "next unread notice" }] });
    return Response.json({ ...inventory, next_notice_after_id: "notice-1" });
  });
  render(<Harness client={client} initialOpen />);
  fireEvent.click(await screen.findByRole("button", { name: "Acknowledge Old provider in Historical organization" }));
  await waitFor(() => expect(screen.queryByText("historical subject")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Close account" }));
  fireEvent.click(screen.getByRole("button", { name: "Review external login notices" }));
  fireEvent.click(screen.getByRole("button", { name: "Load more notices" }));
  expect(await screen.findByText("next unread notice")).toBeTruthy();
});
