import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ProvisioningPage } from "./provisioning";

const path = "/api/admin/provisioning/scim-tokens";
const now = Date.parse("2026-10-14T00:00:00Z");
const day = 24 * 60 * 60 * 1000;
const token = {
  id: "original-token", name: "Directory", scopes: ["scim:read"],
  created_at: "2026-10-01T00:00:00Z", expires_at: new Date(now + 90 * day).toISOString(),
  issued_by: "issuer-1", issuer_review_required: false, oidc_provider_id: "provider-no-longer-in-chooser",
};

afterEach(() => { cleanup(); vi.useRealTimers(); sessionStorage.clear(); localStorage.clear(); });

function fixture(options: {
  tokens?: Array<Record<string, unknown>>;
  write?: (body: Record<string, unknown>) => Response | Promise<Response>;
  refreshFails?: boolean;
} = {}) {
  vi.spyOn(Date, "now").mockReturnValue(now);
  let reads = 0;
  const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit) => {
    const url = new URL(input, "http://localhost");
    if (init.method === "POST") {
      const body = JSON.parse(String(init.body));
      writes.push({ path: url.pathname, body });
      expect(url.pathname).toBe(path);
      return options.write ? options.write(body) : Response.json({
        token: { ...token, ...body, id: "new-token", issued_by: "current-admin" }, credential: "one-time-rotation-secret",
      });
    }
    if (url.pathname === path) {
      reads++;
      if (options.refreshFails && reads > 1) return Response.json({ message: "Inventory unavailable" }, { status: 503 });
      return Response.json({ tokens: options.tokens ?? [token] });
    }
    if (url.pathname === "/api/admin/directory/identity-providers") return Response.json({ providers: [] });
    throw new Error(`Unexpected request: ${url.pathname}`);
  }));
  render(<ProvisioningPage systemAdministrator={false} />);
  return writes;
}

it.each([
  { remaining: -1, status: "revoked", revoked: true },
  { remaining: -1, status: "expired" },
  { remaining: 0, status: "expired" },
  { remaining: 1, status: "expiring soon" },
  { remaining: 14 * day, status: "expiring soon" },
  { remaining: 14 * day + 1, status: "active" },
])("shows $status at remaining=$remaining in both layouts, with independent issuer review", async ({ remaining, status, revoked }) => {
  fixture({ tokens: [{ ...token, expires_at: new Date(now + remaining).toISOString(),
    issuer_review_required: true, ...(revoked ? { revoked_at: token.created_at } : {}) }] });
  await screen.findByRole("list", { name: "SCIM credentials" });
  for (const layout of [screen.getByRole("list", { name: "SCIM credentials" }), screen.getByRole("table")]) {
    const view = within(layout);
    expect(view.getByText(status)).toBeTruthy();
    expect(view.getByText("Issuer review required")).toBeTruthy();
    expect(view.getByText("Issued by issuer-1")).toBeTruthy();
    expect(view.getByText(/Expires/)).toBeTruthy();
  }
});

it("shows an unknown legacy issuer instead of inferring an administrator", async () => {
  fixture({ tokens: [{ ...token, issued_by: null, issuer_review_required: true }] });
  const list = within(await screen.findByRole("list", { name: "SCIM credentials" }));
  expect(list.getByText("Issuer unknown")).toBeTruthy();
  expect(list.getByText("Issuer review required")).toBeTruthy();
});

it("updates the status at expiry without refetching the token inventory", async () => {
  vi.useFakeTimers();
  await act(async () => { fixture({ tokens: [{ ...token, expires_at: new Date(now + 1000).toISOString() }] }); });
  const list = within(screen.getByRole("list", { name: "SCIM credentials" }));
  expect(list.getByText("expiring soon")).toBeTruthy();
  const requests = vi.mocked(fetch).mock.calls.length;
  vi.mocked(Date.now).mockReturnValue(now + 1000);
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(list.getByText("expired")).toBeTruthy();
  expect(vi.mocked(fetch).mock.calls).toHaveLength(requests);
});

it.each([1, 90, 365])("issues one credential with a %i-day lifetime", async expires_in_days => {
  const writes = fixture({ tokens: [] });
  await waitFor(() => expect((screen.getByRole("button", { name: "Issue SCIM token" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Issue SCIM token" }));
  const dialog = within(await screen.findByRole("dialog", { name: "Issue SCIM token" }));
  fireEvent.change(dialog.getByLabelText("Credential name"), { target: { value: "New directory" } });
  expect((dialog.getByLabelText("Lifetime (days)") as HTMLInputElement).value).toBe("90");
  fireEvent.change(dialog.getByLabelText("Lifetime (days)"), { target: { value: String(expires_in_days) } });
  fireEvent.click(dialog.getByRole("button", { name: "Issue credential" }));
  await screen.findByRole("dialog", { name: "SCIM credential issued" });
  expect(writes).toEqual([{ path, body: { name: "New directory", scopes: ["scim:read", "scim:write"], expires_in_days } }]);
});

it.each(["", "0", "366", "1.5"])("rejects invalid lifetime %s before issuance", async value => {
  const writes = fixture();
  await screen.findByRole("list", { name: "SCIM credentials" });
  fireEvent.click(screen.getByRole("button", { name: "Issue SCIM token" }));
  const element = await screen.findByRole("dialog", { name: "Issue SCIM token" });
  const dialog = within(element);
  fireEvent.change(dialog.getByLabelText("Credential name"), { target: { value: "New directory" } });
  fireEvent.change(dialog.getByLabelText("Lifetime (days)"), { target: { value } });
  fireEvent.submit(element.querySelector("form")!);
  expect(await dialog.findByRole("alert")).toBeTruthy();
  expect(writes).toEqual([]);
});

it("rotates the exact original configuration once, retains the new secret on failures, and never revokes automatically", async () => {
  const writeText = vi.fn().mockRejectedValue(new Error("Clipboard unavailable"));
  vi.stubGlobal("navigator", { ...navigator, userAgent: navigator.userAgent, clipboard: { writeText } });
  const writes = fixture({ refreshFails: true });
  const list = within(await screen.findByRole("list", { name: "SCIM credentials" }));
  fireEvent.click(list.getByRole("button", { name: "Rotate" }));
  const dialog = within(await screen.findByRole("dialog", { name: "Rotate SCIM token" }));
  expect(dialog.getByText(token.name)).toBeTruthy();
  expect(dialog.getByText(token.oidc_provider_id)).toBeTruthy();
  expect(dialog.queryByRole("combobox")).toBeNull();
  expect(dialog.queryByLabelText("Credential name")).toBeNull();
  fireEvent.change(dialog.getByLabelText("Lifetime (days)"), { target: { value: "30" } });
  fireEvent.click(dialog.getByRole("button", { name: "Issue replacement" }));
  const issued = within(await screen.findByRole("dialog", { name: "SCIM credential issued" }));
  expect(issued.getByText("one-time-rotation-secret")).toBeTruthy();
  expect(issued.getByText(/original credential remains unchanged/i)).toBeTruthy();
  fireEvent.click(issued.getByRole("button", { name: "Copy credential" }));
  expect((await issued.findByRole("alert")).textContent).toContain("Clipboard unavailable");
  expect(issued.getByText("one-time-rotation-secret")).toBeTruthy();
  expect(writes).toEqual([{ path, body: { name: token.name, scopes: token.scopes,
    oidc_provider_id: token.oidc_provider_id, expires_in_days: 30 } }]);
  expect(JSON.stringify({ ...sessionStorage, ...localStorage })).not.toContain("one-time-rotation-secret");
  fireEvent.click(issued.getByRole("button", { name: "Done" }));
  expect(screen.queryByText("one-time-rotation-secret")).toBeNull();
  expect(screen.getByRole("alert").textContent).toContain("Inventory unavailable");
  expect(writes).toHaveLength(1);
});

it("keeps a failed unpaired rotation open without replay or revocation", async () => {
  const writes = fixture({ tokens: [{ ...token, oidc_provider_id: null }],
    write: () => Response.json({ message: "Issuance unavailable" }, { status: 503 }) });
  const list = within(await screen.findByRole("list", { name: "SCIM credentials" }));
  fireEvent.click(list.getByRole("button", { name: "Rotate" }));
  const dialog = within(await screen.findByRole("dialog", { name: "Rotate SCIM token" }));
  fireEvent.change(dialog.getByLabelText("Lifetime (days)"), { target: { value: "1" } });
  fireEvent.click(dialog.getByRole("button", { name: "Issue replacement" }));
  expect((await dialog.findByRole("alert")).textContent).toContain("Issuance unavailable");
  expect((dialog.getByLabelText("Lifetime (days)") as HTMLInputElement).value).toBe("1");
  expect(screen.queryByRole("dialog", { name: "SCIM credential issued" })).toBeNull();
  expect(writes).toEqual([{ path, body: { name: token.name, scopes: token.scopes, expires_in_days: 1 } }]);
});
