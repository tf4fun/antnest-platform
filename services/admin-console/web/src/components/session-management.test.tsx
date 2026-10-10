import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SessionManagement } from "./session-management";

afterEach(cleanup);
const row = {
  id: "public-session-2", organization_id: "org-2", organization_slug: "other", organization_name: "Other organization",
  created_at: "2026-10-11T00:00:00Z", last_active_at: "2026-10-11T00:10:00Z", idle_expires_at: "2026-10-11T00:40:00Z", expires_at: "2026-10-11T12:00:00Z",
  user_agent_hint: "<img src=x onerror=alert(1)>", current: false,
};

it("follows an empty filtered page's cursor and displays cross-organization browser hints as text", async () => {
  const request = vi.fn(async (path: string) => path.endsWith("after_id=public-session-1")
    ? Response.json({ sessions: [row] })
    : Response.json({ sessions: [], next_after_id: "public-session-1" }));
  vi.stubGlobal("fetch", request);
  render(<SessionManagement open onOpenChange={() => undefined} />);
  fireEvent.click(await screen.findByRole("button", { name: "Load more sessions" }));
  expect(await screen.findByText("Other organization")).toBeTruthy();
  expect(screen.getByText(row.user_agent_hint)).toBeTruthy();
  expect(screen.queryByRole("img")).toBeNull();
  expect(request.mock.calls.map(([path]) => path)).toEqual(["/api/session/sessions?limit=50", "/api/session/sessions?limit=50&after_id=public-session-1"]);
});

it("keeps sessions visible after revoke 503 and retries only after a new confirmation click", async () => {
  const expired = vi.fn();
  const write = vi.fn(async () => Response.json({ code: "identity_unavailable", message: "Identity unavailable" }, { status: 503 }));
  const request = vi.fn(async (path: string, init: RequestInit) => {
    if (path.endsWith("/revoke")) {
      expect(JSON.parse(String(init.body))).toEqual({ mode: "others" });
      return write();
    }
    return Response.json({ sessions: [row] });
  });
  vi.stubGlobal("fetch", request);
  window.addEventListener("antnest:session-expired", expired);
  try {
    render(<SessionManagement open onOpenChange={() => undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign out other sessions" }));
    expect(write).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm revocation" }));
    await screen.findByText("Identity unavailable");
    expect(screen.getByText("Other organization")).toBeTruthy();
    expect(write).toHaveBeenCalledTimes(1);
    expect(expired).not.toHaveBeenCalled();
    write.mockResolvedValueOnce(Response.json({ revoked_count: 1, current_revoked: false }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm revocation" }));
    await screen.findByText("1 sessions revoked.");
    expect(write).toHaveBeenCalledTimes(2);
  } finally { window.removeEventListener("antnest:session-expired", expired); }
});

it("clears the active UI only when Identity reports the current session was revoked", async () => {
  const expired = vi.fn();
  const closed = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (path: string) => path.endsWith("/revoke")
    ? Response.json({ revoked_count: 2, current_revoked: true })
    : Response.json({ sessions: [{ ...row, current: true }] })));
  window.addEventListener("antnest:session-expired", expired);
  try {
    render(<SessionManagement open onOpenChange={closed} />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign out all sessions" }));
    expect(screen.getByText(/This includes the current browser/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm revocation" }));
    await waitFor(() => expect(expired).toHaveBeenCalledTimes(1));
    expect(closed).toHaveBeenCalledWith(false);
  } finally { window.removeEventListener("antnest:session-expired", expired); }
});

it("aborts a closed dialog's read and ignores its response after reopening", async () => {
  let complete!: (value: Response) => void;
  const pending = new Promise<Response>(resolve => { complete = resolve; });
  const request = vi.fn((_path: string, _init: RequestInit) => pending)
    .mockImplementationOnce(() => pending)
    .mockResolvedValueOnce(Response.json({ sessions: [] }));
  vi.stubGlobal("fetch", request);
  const view = render(<SessionManagement open onOpenChange={() => undefined} />);
  view.rerender(<SessionManagement open={false} onOpenChange={() => undefined} />);
  expect(request.mock.calls[0]![1].signal?.aborted).toBe(true);
  view.rerender(<SessionManagement open onOpenChange={() => undefined} />);
  await screen.findByText("No active sessions in this page.");
  await act(async () => { complete(Response.json({ sessions: [row] })); });
  expect(screen.queryByText("Other organization")).toBeNull();
});
