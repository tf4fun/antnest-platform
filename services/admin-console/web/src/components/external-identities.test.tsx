import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { SelfExternalIdentities, OrganizationExternalIdentities } from "./external-identities";
import type { ExternalIdentity, ExternalIdentityNotice } from "../lib/types";
import { dateTime } from "../lib/format";

afterEach(() => { cleanup(); sessionStorage.clear(); });
const selfPath = "/api/session/external-identities";
const orgPath = "/api/admin/directory/memberships/member-2/external-identities";
const providerPath = "/api/admin/directory/identity-providers";
const binding: ExternalIdentity = {
  id: "binding-1", provider_id: "provider-1", provider_name: "workforce", provider_display_name: "Workforce",
  organization_id: "org-2", organization_slug: "other", organization_name: "Other organization", membership_id: "member-2",
  subject: "  <subject> é 😀  ", method: "scim", provider_enabled: false,
  created_at: "2026-10-11T00:00:00Z", bound_at: "2026-10-11T00:01:00Z", revoked_at: null,
};
const notice: ExternalIdentityNotice = {
  id: "notice-1", binding_id: "historical-binding", provider_id: "old-provider", provider_name: "old", provider_display_name: "Previous provider",
  organization_id: "org-3", organization_slug: "historical", organization_name: "Historical organization", membership_id: "old-membership",
  subject: "historical subject", method: "auto", created_at: "2026-10-10T00:00:00Z",
};
const provider = { id: "provider-1", name: "workforce", display_name: "Workforce", enabled: false, link_policy: "none", link_domains: [], authoritative: false, link_policy_review_required: true };
function SelfHarness() {
  const [open, setOpen] = useState(false);
  return <><button onClick={() => setOpen(true)}>Open external logins</button><SelfExternalIdentities open={open} onOpenChange={setOpen} /></>;
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

it("loads historical notices while closed and shows cross-organization bindings without an Agent lookup", async () => {
  const fetcher = vi.fn(async (_path: string, _init?: RequestInit) => Response.json({ bindings: [binding], notices: [notice] })); vi.stubGlobal("fetch", fetcher);
  render(<SelfHarness />);
  fireEvent.click(await screen.findByRole("button", { name: "Review external login notices" }));
  const dialog = within(await screen.findByRole("dialog", { name: "Your external logins" }));
  expect(dialog.getByText("Other organization")).toBeTruthy();
  expect(dialog.getByText("Historical organization")).toBeTruthy();
  expect(dialog.getByText((_, element) => element?.tagName === "CODE" && element.textContent === binding.subject)).toBeTruthy();
  expect(dialog.getByText("Provider disabled")).toBeTruthy();
  expect(within(dialog.getByRole("list", { name: "External login bindings" })).getByText(`Linked by scim · ${dateTime(binding.bound_at)}`)).toBeTruthy();
  expect(dialog.getByText(`Linked by auto · ${dateTime(notice.created_at)}`)).toBeTruthy();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]?.[0]).toBe(`${selfPath}?limit=50`);
});

it("advances bindings and notices independently without replacing the other stream", async () => {
  const fetcher = vi.fn(async (path: string) => {
    if (path.includes("after_id=binding-1")) return Response.json({ bindings: [{ ...binding, id: "binding-2", subject: "next binding" }], notices: [{ ...notice, id: "ignored-notice", subject: "must not appear" }], next_notice_after_id: "ignored" });
    if (path.includes("notice_after_id=notice-1")) return Response.json({ bindings: [{ ...binding, id: "ignored-binding", subject: "must not appear" }], next_after_id: "ignored", notices: [{ ...notice, id: "notice-2", subject: "next notice" }] });
    return Response.json({ bindings: [binding], notices: [notice], next_after_id: "binding-1", next_notice_after_id: "notice-1" });
  }); vi.stubGlobal("fetch", fetcher);
  render(<SelfExternalIdentities open onOpenChange={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Load more bindings" }));
  await screen.findByText("next binding");
  expect(screen.queryByText("must not appear")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Load more notices" }));
  await screen.findByText("next notice");
  expect(screen.getByText("next binding")).toBeTruthy();
  expect(screen.queryByText("must not appear")).toBeNull();
  expect(screen.queryByRole("button", { name: "Load more bindings" })).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it("acknowledges exact immutable notice IDs and retains a new notice for the same binding", async () => {
  const ack = deferred<Response>();
  const newer = { ...notice, id: "notice-2", subject: "restored subject" };
  let read = 0;
  const fetcher = vi.fn(async (path: string, init: RequestInit) => {
    if (init.method === "POST") { expect(path).toBe(`${selfPath}/notices/acknowledge`); expect(JSON.parse(String(init.body))).toEqual({ notice_ids: ["notice-1"] }); return ack.promise; }
    return Response.json({ bindings: [], notices: ++read === 1 ? [notice] : [newer] });
  }); vi.stubGlobal("fetch", fetcher);
  render(<SelfExternalIdentities open onOpenChange={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Acknowledge notice notice-1" }));
  expect(screen.getByText("historical subject")).toBeTruthy();
  await act(async () => { ack.resolve(Response.json({ acknowledged_count: 0 })); });
  await waitFor(() => expect(screen.queryByText("historical subject")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Refresh external logins" }));
  expect(await screen.findByText("restored subject")).toBeTruthy();
  expect(fetcher.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(1);
});

it.each([404, 503])("retains notice and binding data after ACK failure %s without replay", async status => {
  const fetcher = vi.fn(async (_path: string, init: RequestInit) => init.method === "POST" ? Response.json({ message: "Acknowledgment unavailable" }, { status }) : Response.json({ bindings: [binding], notices: [notice] }));
  vi.stubGlobal("fetch", fetcher); render(<SelfExternalIdentities open onOpenChange={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Acknowledge notice notice-1" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Acknowledgment unavailable");
  expect(screen.getByText("historical subject")).toBeTruthy();
  expect(screen.getByText("Other organization")).toBeTruthy();
  expect(fetcher.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(1);
});

it("requires a second explicit lockout action and stops after current-session revocation", async () => {
  const writes: unknown[] = []; const closed = vi.fn();
  const fetcher = vi.fn(async (_path: string, init: RequestInit) => {
    if (init.method === "DELETE") {
      writes.push(JSON.parse(String(init.body)));
      return writes.length === 1 ? Response.json({ code: "external_identity_last_method", message: "Last login method" }, { status: 409 }) : Response.json({ revoked_count: 2, current_revoked: true });
    }
    return Response.json({ bindings: [binding], notices: [] });
  }); vi.stubGlobal("fetch", fetcher); render(<SelfExternalIdentities open onOpenChange={closed} />);
  fireEvent.click(await screen.findByRole("button", { name: "Unbind Workforce" }));
  expect(writes).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Confirm unbind" }));
  const override = await screen.findByRole("button", { name: "Unbind and accept lockout" });
  expect(writes).toEqual([{ allow_lockout: false }]);
  fireEvent.click(override);
  await waitFor(() => expect(closed).toHaveBeenCalledWith(false));
  expect(writes).toEqual([{ allow_lockout: false }, { allow_lockout: true }]);
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it("does not install a stale page after the session component is replaced", async () => {
  const stale = deferred<Response>(); let read = 0;
  const fetcher = vi.fn(async (_path: string, _init: RequestInit) => ++read === 1 ? stale.promise : Response.json({ bindings: [], notices: [] })); vi.stubGlobal("fetch", fetcher);
  const view = render(<SelfExternalIdentities key="old" open onOpenChange={vi.fn()} />);
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  view.rerender(<SelfExternalIdentities key="new" open onOpenChange={vi.fn()} />);
  await screen.findByText("No external logins to display.");
  await act(async () => { stale.resolve(Response.json({ bindings: [binding], notices: [notice] })); });
  expect(screen.queryByText("Historical organization")).toBeNull();
  expect(fetcher.mock.calls[0]?.[1].signal?.aborted).toBe(true);
});

it("binds an opaque subject using disabled organization providers and explicit restoration", async () => {
  const writes: unknown[] = [];
  const fetcher = vi.fn(async (path: string, init: RequestInit) => {
    if (path.startsWith(providerPath)) return Response.json({ providers: [provider] });
    if (init.method === "POST") { expect(path).toBe(orgPath); writes.push(JSON.parse(String(init.body))); return writes.length === 1 ? Response.json({ code: "external_identity_restore_required", message: "Explicit restore required" }, { status: 409 }) : Response.json({ binding }); }
    expect(path).toBe(`${orgPath}?limit=50`); return Response.json({ bindings: [] });
  }); vi.stubGlobal("fetch", fetcher);
  render(<OrganizationExternalIdentities membership={{ id: "member-2", name: "Directory member" }} onClose={vi.fn()} />);
  await screen.findByRole("option", { name: /Workforce.*disabled/i });
  fireEvent.change(screen.getByLabelText("Login provider"), { target: { value: "provider-1" } });
  fireEvent.change(screen.getByLabelText("Provider subject"), { target: { value: binding.subject } });
  fireEvent.click(screen.getByRole("button", { name: "Bind external login" }));
  const restore = await screen.findByRole("button", { name: "Restore revoked binding" });
  expect(writes).toEqual([{ provider_id: "provider-1", subject: binding.subject, restore_revoked: false }]);
  fireEvent.click(restore);
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(writes[1]).toEqual({ provider_id: "provider-1", subject: binding.subject, restore_revoked: true });
  expect(await screen.findByText("External login bound.")).toBeTruthy();
  expect(fetcher.mock.calls.some(([path]) => path.includes("/provisioning/oidc-providers"))).toBe(false);
});

it.each(["restore", "lockout"])("retires old Membership data and %s confirmation when the target changes", async mode => {
  const next = deferred<Response>();
  vi.stubGlobal("fetch", vi.fn(async (path: string, init: RequestInit) => {
    if (path.startsWith(providerPath)) return Response.json({ providers: [provider] });
    if (path.includes("/member-3/")) return next.promise;
    if (init.method === "POST") return Response.json({ code: "external_identity_restore_required" }, { status: 409 });
    if (init.method === "DELETE") return Response.json({ code: "external_identity_last_method" }, { status: 409 });
    return Response.json({ bindings: [binding] });
  }));
  const view = render(<OrganizationExternalIdentities membership={{ id: "member-2", name: "First member" }} onClose={vi.fn()} />);
  if (mode === "restore") {
    await screen.findByRole("option", { name: /Workforce.*disabled/ });
    fireEvent.change(screen.getByLabelText("Login provider"), { target: { value: "provider-1" } });
    fireEvent.change(screen.getByLabelText("Provider subject"), { target: { value: "old subject" } });
    fireEvent.click(screen.getByRole("button", { name: "Bind external login" }));
    await screen.findByRole("button", { name: "Restore revoked binding" });
  } else {
    fireEvent.click(await screen.findByRole("button", { name: "Unbind Workforce" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm unbind" }));
    await screen.findByRole("button", { name: "Unbind and accept lockout" });
  }
  view.rerender(<OrganizationExternalIdentities membership={{ id: "member-3", name: "Second member" }} onClose={vi.fn()} />);
  expect(screen.queryByRole("button", { name: "Restore revoked binding" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Unbind and accept lockout" })).toBeNull();
  expect(screen.queryByText("Other organization")).toBeNull();
  expect((screen.getByLabelText("Provider subject") as HTMLTextAreaElement).value).toBe("");
  await act(async () => { next.resolve(Response.json({ bindings: [] })); });
});
