import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { OIDCProvider, SCIMToken } from "../lib/types";
import { ProvisioningPage } from "./provisioning";

afterEach(() => { cleanup(); sessionStorage.clear(); });

const provider: OIDCProvider = {
  name: "workforce", display_name: "Workforce", issuer: "https://idp.example.com", client_id: "antnest-client", scopes: ["openid", "email"],
  enabled: true, revision: 1, authorization_endpoint: "https://idp.example.com/authorize", token_endpoint: "https://idp.example.com/token",
  token_endpoint_auth_method: "client_secret_basic", id_token_signing_algs: ["RS256"], jwks_uri: "https://idp.example.com/jwks",
  created_at: "2026-09-07T00:00:00Z", updated_at: "2026-09-07T00:00:00Z",
};
const token: SCIMToken = { id: "token-1", name: "HR sync", scopes: ["scim:read", "scim:write"], created_at: provider.created_at };
const providerPath = "/api/admin/provisioning/oidc-providers";
const tokenPath = "/api/admin/provisioning/scim-tokens";

function mockProvisioning(options: {
  write: (path: string, body: string) => Response | Promise<Response>;
  providers?: () => Response | Promise<Response>;
  tokens?: () => Response | Promise<Response>;
}) {
  const requests: Array<{ method: string; path: string }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit) => {
    const path = new URL(input, "http://localhost").pathname;
    requests.push({ method: init.method ?? "GET", path });
    if (init.method === "POST") return options.write(path, String(init.body));
    if (path === providerPath) return options.providers ? options.providers() : Response.json({ providers: [provider] });
    if (path === tokenPath) return options.tokens ? options.tokens() : Response.json({ tokens: [token] });
    throw new Error(`Unexpected request: ${path}`);
  }));
  return requests;
}

it("prevents Provider editing during a pending toggle and preserves success when refreshing fails", async () => {
  let resolveCommand!: (response: Response) => void;
  const command = new Promise<Response>((resolve) => { resolveCommand = resolve; });
  let reads = 0;
  let writes = 0;
  const disabledProvider = { ...provider, enabled: false, revision: 2 };
  mockProvisioning({
    write: (path, body) => { expect(path).toBe(`${providerPath}/workforce/enabled`); expect(JSON.parse(body)).toEqual({ enabled: false }); writes++; return command; },
    providers: () => ++reads === 2 ? Response.json({ message: "Login inventory unavailable" }, { status: 503 })
      : Response.json({ providers: [reads > 2 ? disabledProvider : provider] }),
  });
  render(<ProvisioningPage systemAdministrator />);
  fireEvent.click(await screen.findByRole("button", { name: "Disable Workforce" }));
  await waitFor(() => expect(writes).toBe(1));
  for (const edit of [screen.getByRole("button", { name: "Edit Workforce" }), screen.getByRole("button", { name: "Edit" })]) {
    expect((edit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(edit);
  }
  expect(screen.queryByRole("dialog")).toBeNull();
  await act(async () => { resolveCommand(Response.json({ provider: disabledProvider })); });
  expect(await screen.findByText("Workforce disabled.")).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toContain("Login inventory unavailable");
  fireEvent.click(screen.getByRole("button", { name: "Retry login providers" }));
  expect(await screen.findByRole("button", { name: "Enable Workforce" })).toBeTruthy();
  expect(writes).toBe(1);
  fireEvent.click(screen.getByRole("button", { name: "Dismiss success message" }));
  expect(screen.queryByText("Workforce disabled.")).toBeNull();
});

it.each([true, false])("retains rejected OIDC form fields without persisting the secret (creation=%s)", async (creating) => {
  mockProvisioning({ write: () => Response.json({ message: "Provider change rejected" }, { status: 403 }) });
  render(<ProvisioningPage systemAdministrator />);
  await screen.findByRole("button", { name: "Edit Workforce" });
  fireEvent.click(screen.getByRole("button", { name: creating ? "Add login provider" : "Edit Workforce" }));
  const dialog = within(await screen.findByRole("dialog"));
  if (creating) {
    fireEvent.change(dialog.getByLabelText("Provider key"), { target: { value: "workforce" } });
    fireEvent.change(dialog.getByLabelText("Issuer URL"), { target: { value: provider.issuer } });
  }
  fireEvent.change(dialog.getByLabelText("Client ID"), { target: { value: "updated-client" } });
  fireEvent.change(dialog.getByLabelText("Client secret"), { target: { value: "test-oidc-secret" } });
  fireEvent.click(dialog.getByRole("button", { name: creating ? "Add provider" : "Save provider" }));
  expect((await dialog.findByRole("alert")).textContent).toContain("Provider change rejected");
  expect((dialog.getByLabelText("Client ID") as HTMLInputElement).value).toBe("updated-client");
  expect((dialog.getByLabelText("Client secret") as HTMLInputElement).value).toBe("test-oidc-secret");
  expect(JSON.stringify({ ...sessionStorage })).not.toContain("test-oidc-secret");
  expect(screen.queryByRole("status")).toBeNull();
});

it.each([true, false])("acknowledges OIDC save even when the following inventory read is forbidden (creation=%s)", async (creating) => {
  let reads = 0;
  let writes = 0;
  mockProvisioning({
    write: (path, body) => {
      expect(path).toBe(providerPath);
      expect(JSON.parse(body).client_id).toBe("updated-client");
      writes++;
      return Response.json({ provider: { ...provider, name: creating ? "new-workforce" : provider.name, client_id: "updated-client", revision: creating ? 1 : 2 } });
    },
    providers: () => ++reads === 1 ? Response.json({ providers: [provider] })
      : Response.json({ message: "Login inventory forbidden" }, { status: 403 }),
  });
  render(<ProvisioningPage systemAdministrator />);
  await screen.findByRole("button", { name: "Edit Workforce" });
  fireEvent.click(screen.getByRole("button", { name: creating ? "Add login provider" : "Edit Workforce" }));
  const dialog = within(await screen.findByRole("dialog"));
  if (creating) {
    fireEvent.change(dialog.getByLabelText("Provider key"), { target: { value: "new-workforce" } });
    fireEvent.change(dialog.getByLabelText("Issuer URL"), { target: { value: provider.issuer } });
    fireEvent.change(dialog.getByLabelText("Client secret"), { target: { value: "test-oidc-secret" } });
  }
  fireEvent.change(dialog.getByLabelText("Client ID"), { target: { value: "updated-client" } });
  fireEvent.click(dialog.getByRole("button", { name: creating ? "Add provider" : "Save provider" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  const acknowledgement = creating ? "new-workforce added." : "Workforce updated.";
  expect(screen.getByText(acknowledgement)).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toContain("Login inventory forbidden");
  expect(screen.queryByRole("button", { name: "Retry login providers" })).toBeNull();
  expect(JSON.stringify({ ...sessionStorage })).not.toContain("test-oidc-secret");
  expect(writes).toBe(1);
  fireEvent.click(screen.getByRole("button", { name: "Dismiss success message" }));
  expect(screen.queryByText(acknowledgement)).toBeNull();
});

it("preserves an issued SCIM credential across refresh and clipboard failures, then clears it on close", async () => {
  const credential = "one-time-test-credential";
  const writeText = vi.fn().mockRejectedValueOnce(new Error("Clipboard unavailable")).mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { ...navigator, userAgent: navigator.userAgent, clipboard: { writeText } });
  let reads = 0;
  let writes = 0;
  mockProvisioning({
    write: (path, body) => { expect(path).toBe(tokenPath); expect(JSON.parse(body)).toEqual({ name: token.name, scopes: token.scopes }); writes++; return Response.json({ token, credential }); },
    tokens: () => ++reads === 2 ? Response.json({ message: "Token inventory unavailable" }, { status: 503 }) : Response.json({ tokens: reads > 2 ? [token] : [] }),
  });
  render(<ProvisioningPage systemAdministrator={false} />);
  await waitFor(() => expect((screen.getByRole("button", { name: "Issue SCIM token" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Issue SCIM token" }));
  fireEvent.change(screen.getByLabelText("Credential name"), { target: { value: token.name } });
  fireEvent.click(screen.getByRole("button", { name: "Issue credential" }));
  const issued = within(await screen.findByRole("dialog", { name: "SCIM credential issued" }));
  expect(issued.getByText(credential)).toBeTruthy();
  fireEvent.click(issued.getByRole("button", { name: "Copy credential" }));
  expect((await issued.findByRole("alert")).textContent).toContain("Clipboard unavailable");
  expect(issued.getByText(credential)).toBeTruthy();
  fireEvent.click(issued.getByRole("button", { name: "Copy credential" }));
  await issued.findByRole("button", { name: "Copied" });
  expect(writeText).toHaveBeenLastCalledWith(credential);
  expect(JSON.stringify({ ...sessionStorage })).not.toContain(credential);
  fireEvent.click(issued.getByRole("button", { name: "Done" }));
  expect(screen.queryByText(credential)).toBeNull();
  expect(screen.getByRole("alert").textContent).toContain("Token inventory unavailable");
  fireEvent.click(screen.getByRole("button", { name: "Retry SCIM credentials" }));
  await screen.findByRole("list", { name: "SCIM credentials" });
  expect(reads).toBe(3);
  expect(writes).toBe(1);
  expect(screen.queryByText(credential)).toBeNull();
});

it("keeps rejected SCIM issuance in its form without displaying a credential", async () => {
  mockProvisioning({ write: () => Response.json({ message: "Token issuance rejected" }, { status: 403 }) });
  render(<ProvisioningPage systemAdministrator={false} />);
  await screen.findByRole("list", { name: "SCIM credentials" });
  fireEvent.click(screen.getByRole("button", { name: "Issue SCIM token" }));
  fireEvent.change(screen.getByLabelText("Credential name"), { target: { value: "New connector" } });
  fireEvent.click(screen.getByRole("button", { name: "Issue credential" }));
  const dialog = within(await screen.findByRole("dialog", { name: "Issue SCIM token" }));
  expect((await dialog.findByRole("alert")).textContent).toContain("Token issuance rejected");
  expect((dialog.getByLabelText("Credential name") as HTMLInputElement).value).toBe("New connector");
  expect(screen.queryByRole("dialog", { name: "SCIM credential issued" })).toBeNull();
});

it("acknowledges SCIM revocation separately from a failed list refresh", async () => {
  let reads = 0;
  let writes = 0;
  mockProvisioning({
    write: (path) => { expect(path).toBe(`${tokenPath}/token-1/revoke`); writes++; return Response.json({ status: "revoked" }); },
    tokens: () => ++reads === 2 ? Response.json({ message: "Token inventory unavailable" }, { status: 503 })
      : Response.json({ tokens: [{ ...token, revoked_at: reads > 2 ? token.created_at : undefined }] }),
  });
  render(<ProvisioningPage systemAdministrator={false} />);
  const list = within(await screen.findByRole("list", { name: "SCIM credentials" }));
  fireEvent.click(list.getByRole("button", { name: "Revoke" }));
  const dialog = within(await screen.findByRole("dialog", { name: "Revoke SCIM token" }));
  fireEvent.click(dialog.getByRole("button", { name: "Revoke" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.getByText("HR sync revoked.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry SCIM credentials" }));
  await screen.findByRole("list", { name: "SCIM credentials" });
  expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();
  expect(writes).toBe(1);
});

it("does not expose or query system OIDC administration for an organization administrator", async () => {
  const requests = mockProvisioning({ write: () => { throw new Error("No mutation expected"); } });
  render(<ProvisioningPage systemAdministrator={false} />);
  await screen.findByRole("list", { name: "SCIM credentials" });
  expect(screen.queryByRole("tab", { name: "Login providers" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Add login provider" })).toBeNull();
  expect(requests).toEqual([{ method: "GET", path: tokenPath }]);
});
