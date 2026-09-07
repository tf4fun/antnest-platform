import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccountSecurity } from "./account-security";

declare const jsdom: { window: Window };

// Use browser storage, not Node's optional file-backed localStorage global.
beforeEach(() => { vi.stubGlobal("localStorage", jsdom.window.localStorage); });
afterEach(() => { cleanup(); window.sessionStorage.clear(); window.localStorage.clear(); });

const currentPassword = "synthetic current password";
const newPassword = "synthetic replacement password";
const fieldNames = ["Current password", "New password", "Confirm new password"];

function mount(write: () => Promise<Response>) {
  const request = vi.fn(async (path: string, init: RequestInit) => {
    expect(path).toBe("/api/admin/account/password");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      current_password: currentPassword, new_password: newPassword,
    });
    return write();
  });
  vi.stubGlobal("fetch", request);
  function Host() {
    const [open, setOpen] = useState(true);
    return <>
      <button onClick={() => setOpen(true)}>Open account security</button>
      <AccountSecurity open={open} onOpenChange={setOpen} />
    </>;
  }
  render(<Host />);
  return request;
}

function fill(confirmation = newPassword) {
  for (const [index, value] of [currentPassword, newPassword, confirmation].entries()) {
    fireEvent.change(screen.getByLabelText(fieldNames[index]!), { target: { value } });
  }
}

function expectCredentialsNotStored() {
  for (const storage of [window.localStorage, window.sessionStorage]) {
    const values = Array.from({ length: storage.length }, (_, index) => storage.getItem(storage.key(index)!));
    expect(values.join(" ")).not.toContain(currentPassword);
    expect(values.join(" ")).not.toContain(newPassword);
  }
}

it.each(["mismatch", "short"])("rejects %s input before making a password request", async (kind) => {
  const request = mount(async () => Response.json({ status: "changed" }));
  fill(kind === "mismatch" ? "a different password" : newPassword);
  if (kind === "short") {
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "short" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "short" } });
  }
  fireEvent.click(screen.getByRole("button", { name: "Update password" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    kind === "mismatch" ? "New passwords do not match." : "Use at least 12 bytes",
  );
  expect(request).not.toHaveBeenCalled();
  expectCredentialsNotStored();
});

it("prevents duplicate submission and dismissal until confirmed success", async () => {
  let respond!: (value: Response) => void;
  const response = new Promise<Response>((resolve) => { respond = resolve; });
  const request = mount(() => response);
  fill();
  fireEvent.click(screen.getByRole("button", { name: "Update password" }));
  const pending = screen.getByRole("button", { name: "Updating" }) as HTMLButtonElement;
  expect(pending.disabled).toBe(true);
  expect(pending.getAttribute("aria-busy")).toBe("true");
  fireEvent.click(pending);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  for (const name of fieldNames) expect((screen.getByLabelText(name) as HTMLInputElement).disabled).toBe(true);
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(screen.queryByText("Your password has been updated.")).toBeNull();
  expect(request).toHaveBeenCalledTimes(1);
  expectCredentialsNotStored();

  respond(Response.json({ status: "changed" }));
  expect((await screen.findByRole("status")).textContent).toContain("Your password has been updated.");
  for (const name of fieldNames) expect(screen.queryByLabelText(name)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  fireEvent.click(screen.getByRole("button", { name: "Open account security" }));
  for (const name of fieldNames) expect((screen.getByLabelText(name) as HTMLInputElement).value).toBe("");
  expect(screen.queryByRole("status")).toBeNull();
  expectCredentialsNotStored();
});

it.each([401, 503, "network"] as const)("retains rejected input after %s without ending the session or retrying automatically", async (failure) => {
  const expired = vi.fn();
  window.addEventListener("antnest:session-expired", expired);
  try {
    const write = vi.fn(async () => {
      if (failure === "network") throw new TypeError("Network unavailable");
      return Response.json({ code: failure === 401 ? "invalid_current_password" : "dependency_unavailable", message: "Password change rejected" }, { status: failure });
    });
    const request = mount(write);
    fill();
    fireEvent.click(screen.getByRole("button", { name: "Update password" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      failure === "network" ? "Network unavailable" : "Password change rejected",
    );
    expect(request).toHaveBeenCalledTimes(1);
    expect(expired).not.toHaveBeenCalled();
    expect((screen.getByLabelText("Current password") as HTMLInputElement).value).toBe(currentPassword);
    expect((screen.getByLabelText("New password") as HTMLInputElement).value).toBe(newPassword);
    expect((screen.getByLabelText("Confirm new password") as HTMLInputElement).value).toBe(newPassword);
    expectCredentialsNotStored();
    write.mockResolvedValueOnce(Response.json({ status: "changed" }));
    fireEvent.click(screen.getByRole("button", { name: "Update password" }));
    await screen.findByText("Your password has been updated.");
    expect(request).toHaveBeenCalledTimes(2);
  } finally {
    window.removeEventListener("antnest:session-expired", expired);
  }
});

it("clears rejected credentials and errors when the dialog is dismissed", async () => {
  mount(async () => Response.json({ code: "invalid_current_password", message: "Password rejected" }, { status: 401 }));
  fill();
  fireEvent.click(screen.getByRole("button", { name: "Update password" }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Open account security" }));
  for (const name of fieldNames) expect((screen.getByLabelText(name) as HTMLInputElement).value).toBe("");
  expect(screen.queryByRole("alert")).toBeNull();
  expectCredentialsNotStored();
});

it.each([
  { code: "unauthenticated", message: "Sign in again." },
  { code: "unknown", message: "Rejected" },
  {},
  null,
  "not JSON",
  "unreadable body",
])("notifies the session owner for a non-credential 401: %j", async (body) => {
  const expired = vi.fn();
  window.addEventListener("antnest:session-expired", expired);
  try {
    const request = mount(async () => {
      const response = typeof body === "string"
        ? new Response(body, { status: 401 })
        : Response.json(body, { status: 401 });
      if (body === "unreadable body") vi.spyOn(response, "text").mockRejectedValue(new TypeError("Body interrupted"));
      return response;
    });
    fill();
    fireEvent.click(screen.getByRole("button", { name: "Update password" }));
    await screen.findByRole("alert");
    expect(expired).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
    expectCredentialsNotStored();
  } finally {
    window.removeEventListener("antnest:session-expired", expired);
  }
});
