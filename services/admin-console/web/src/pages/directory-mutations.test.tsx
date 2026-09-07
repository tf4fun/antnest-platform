import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DirectoryMember } from "../lib/types";
import { DirectoryPage } from "./directory";

afterEach(() => { cleanup(); sessionStorage.clear(); });

const dates = { created_at: "2026-09-07T00:00:00Z", updated_at: "2026-09-07T00:00:00Z" };
const member: DirectoryMember = {
  user: { ...dates, id: "user-alex", system_role: "member", active: true },
  membership: { ...dates, id: "membership-alex", user_id: "user-alex", email: "alex@example.com", display_name: "Alex", role: "member", source: "local", active: true },
};
const workflows = [
  { name: "creation", open: "Add local user", dialog: "Add local user", submit: "Create user", path: "/api/admin/directory/users", success: "Alex Updated added to the directory." },
  { name: "membership", open: "Edit Alex", dialog: "Edit local membership", submit: "Save membership", path: "/api/admin/directory/memberships/membership-alex", success: "Alex Updated updated." },
  { name: "global access", open: "Disable Alex globally", dialog: "Disable user globally", submit: "Disable user", path: "/api/admin/directory/users/user-alex/active", success: "Alex can no longer access Antnest." },
];
type Workflow = typeof workflows[number];

function directoryMock(command: (body: string) => Response | Promise<Response>, read: () => Response | Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit) => {
    const url = new URL(input, "http://localhost");
    if (init.method === "POST") return command(String(init.body));
    if (url.pathname === "/api/admin/directory") return read();
    throw new Error(`Unexpected request: ${url}`);
  }));
}

async function openWorkflow(workflow: Workflow) {
  render(<DirectoryPage currentUserID="administrator" organizationName="Example" systemAdministrator />);
  fireEvent.click(await screen.findByRole("button", { name: workflow.open }));
  const dialog = within(await screen.findByRole("dialog", { name: workflow.dialog }));
  if (workflow.name !== "global access") {
    fireEvent.change(dialog.getByLabelText("Display name"), { target: { value: "Alex Updated" } });
    fireEvent.change(dialog.getByLabelText("Email"), { target: { value: "alex@example.com" } });
  }
  if (workflow.name === "creation") fireEvent.change(dialog.getByLabelText("Initial password"), { target: { value: "test-password-12345" } });
  return dialog;
}

function expectRowActionsDisabled(disabled: boolean) {
  const buttons = [
    ...within(screen.getByRole("list", { name: "Directory people" })).getAllByRole("button"),
    ...within(screen.getByRole("table")).getAllByRole("button"),
  ];
  for (const button of buttons) {
    expect((button as HTMLButtonElement).disabled).toBe(disabled);
  }
}

describe.each(workflows)("Directory $name", (workflow) => {
  it.each([403, 503])("acknowledges the command but requires fresh records after a %i refresh failure", async (status) => {
    let resolveCommand!: (response: Response) => void;
    let resolveRead!: (response: Response) => void;
    let reads = 0;
    let writes = 0;
    const command = new Promise<Response>((resolve) => { resolveCommand = resolve; });
    const refresh = new Promise<Response>((resolve) => { resolveRead = resolve; });
    const updated: DirectoryMember = {
      user: { ...member.user, active: workflow.name !== "global access" },
      membership: { ...member.membership, display_name: workflow.name === "global access" ? "Alex" : "Alex Updated" },
    };
    const created = { user: { ...updated.user, id: "user-new" }, membership: { ...updated.membership, id: "membership-new", user_id: "user-new" } };
    const result = workflow.name === "creation" ? created
      : workflow.name === "membership" ? { membership: updated.membership } : { status: "updated" };
    const refreshedUsers = workflow.name === "creation" ? [member, created] : [updated];
    directoryMock(() => { writes++; return command; }, () => {
      reads++;
      return reads === 2 ? refresh : Response.json({ users: reads === 1 ? [member] : refreshedUsers, groups: [] });
    });
    const dialog = await openWorkflow(workflow);
    fireEvent.click(dialog.getByRole("button", { name: workflow.submit }));
    await waitFor(() => expect(writes).toBe(1));
    expect((dialog.getByRole("button", { name: "Close dialog" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(dialog.getByRole("button", { name: workflow.submit }));
    expect(writes).toBe(1);
    await act(async () => { resolveCommand(Response.json(result)); });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText(workflow.success)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Add local user" }) as HTMLButtonElement).disabled).toBe(true);
    expectRowActionsDisabled(true);

    await act(async () => { resolveRead(Response.json({ message: "Directory refresh unavailable" }, { status })); });
    expect(screen.getByText(workflow.success)).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Directory refresh unavailable");
    expectRowActionsDisabled(true);
    expect(Boolean(screen.queryByRole("button", { name: "Refresh directory" }))).toBe(status === 503);
    if (status === 503) {
      fireEvent.click(screen.getByRole("button", { name: "Refresh directory" }));
      await waitFor(() => expectRowActionsDisabled(false));
      expect(screen.getByRole("button", { name: workflow.name === "global access" ? "Activate Alex globally" : "Edit Alex Updated" })).toBeTruthy();
      expect(reads).toBe(3);
      expect(writes).toBe(1);
    }
    fireEvent.click(screen.getByRole("button", { name: "Dismiss success message" }));
    expect(screen.queryByText(workflow.success)).toBeNull();
  });

  it("keeps a rejected mutation in its dialog without discarding input or claiming success", async () => {
    directoryMock(() => Response.json({ message: "Change was rejected" }, { status: 403 }),
      () => Response.json({ users: [member], groups: [] }));
    const dialog = await openWorkflow(workflow);
    fireEvent.click(dialog.getByRole("button", { name: workflow.submit }));
    expect((await dialog.findByRole("alert")).textContent).toContain("Change was rejected");
    expect(screen.queryByText(workflow.success)).toBeNull();
    expect((dialog.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(false);
    if (workflow.name !== "global access") expect((dialog.getByLabelText("Display name") as HTMLInputElement).value).toBe("Alex Updated");
    if (workflow.name === "creation") {
      expect((dialog.getByLabelText("Initial password") as HTMLInputElement).value).toBe("test-password-12345");
      expect(JSON.stringify({ ...sessionStorage })).not.toContain("test-password-12345");
    }
  });
});

it("does not reopen stale row actions or duplicate a pending Directory retry", async () => {
  let reads = 0;
  let resolveRetry!: (response: Response) => void;
  const retry = new Promise<Response>((resolve) => { resolveRetry = resolve; });
  directoryMock(() => Response.json({ status: "updated" }), () => {
    if (++reads === 2) return Response.json({ message: "Directory refresh unavailable" }, { status: 503 });
    return reads > 2 ? retry : Response.json({ users: [member], groups: [] });
  });
  const dialog = await openWorkflow(workflows[1]!);
  fireEvent.click(dialog.getByRole("button", { name: "Save membership" }));
  fireEvent.click(await screen.findByRole("button", { name: "Refresh directory" }));
  expectRowActionsDisabled(true);
  const refresh = screen.getByRole("button", { name: "Refresh directory" }) as HTMLButtonElement;
  expect(refresh.disabled).toBe(true);
  expect(refresh.getAttribute("aria-busy")).toBe("true");
  fireEvent.click(refresh);
  expect(reads).toBe(3);
  await act(async () => { resolveRetry(Response.json({ users: [member], groups: [] })); });
  await waitFor(() => expectRowActionsDisabled(false));
});
