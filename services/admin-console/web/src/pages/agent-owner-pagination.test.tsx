import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetSessionRequests } from "../lib/api";
import { AgentsPage } from "./agents";

const principal = { organization_id: "org-1", user_id: "user-1", membership_id: "membership-1" };
let cookie: string;
beforeEach(() => {
  cookie = "__Host-antnest_csrf=owner-session";
  vi.spyOn(document, "cookie", "get").mockImplementation(() => cookie);
  resetSessionRequests(principal);
});

afterEach(() => {
  resetSessionRequests();
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const timestamps = { created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z" };
const member = (suffix: string) => ({
  user: { id: `user-${suffix}`, system_role: "user", active: true, ...timestamps },
  membership: {
    id: `membership-${suffix}`, user_id: `user-${suffix}`, email: `member${suffix}@example.com`,
    display_name: `Member ${suffix}`, role: "member", source: "local", active: true, ...timestamps,
  },
});
const template = {
  template_id: "template-1", name: "Support template", revision: 3,
  model_profile_id: "model-2", system_prompt: "", max_model_requests: 32,
  context_policy_version: "context-v1", enabled: true, skill_refs: [],
  runtime: { image_ref: `sha256:${"a".repeat(64)}`, resources: { memory_bytes: 1024, pids_limit: 128, tmpfs_bytes: 1024 } },
  ...timestamps,
};

type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response>;

function stubFetch(handlers: Record<string, Handler>) {
  const requests: URL[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input.toString(), "http://localhost");
    requests.push(url);
    const handler = handlers[url.pathname];
    if (!handler) throw new Error(`Unexpected request: ${url}`);
    return handler(url, init);
  }));
  return requests;
}

const baseHandlers = (members: Handler): Record<string, Handler> => ({
  "/api/admin/agents": () => Response.json({ items: [] }),
  "/api/admin/templates": () => Response.json({ items: [template] }),
  "/api/admin/directory/members": members,
  "/api/admin/directory/groups": () => Response.json({ items: [], next_cursor: null }),
});

async function openCreateForm() {
  const page = render(<AgentsPage />);
  const [trigger] = await screen.findAllByRole("button", { name: /^create agent$/i });
  if (!trigger) throw new Error("Create Agent trigger is missing");
  await waitFor(() => expect((trigger as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(trigger);
  return page;
}

describe("Agent inventory owner pagination", () => {
  it("carries the normalized owner q to load-more and keeps the chosen option", async () => {
    const requests = stubFetch(baseHandlers((url) =>
      url.searchParams.get("q") === "alice"
        ? url.searchParams.get("cursor") === "page-2"
          ? Response.json({ items: [member("60")], next_cursor: null })
          : Response.json({ items: [member("52")], next_cursor: "page-2" })
        : Response.json({ items: [member("1")], next_cursor: null })));
    await openCreateForm();
    const select = await screen.findByRole("combobox", { name: /owner/i });
    const search = screen.getByPlaceholderText("Search owner email");
    fireEvent.change(search, { target: { value: " Alice " } });
    fireEvent.click(screen.getByRole("button", { name: /^search$/i }));
    const option = await screen.findByRole("option", { name: /member52@example.com/i });
    fireEvent.change(select, { target: { value: "user-52" } });
    fireEvent.click(screen.getByRole("button", { name: /load more/i }));
    await screen.findByRole("option", { name: /member60@example.com/i });
    const queried = requests.filter(
      (u) => u.pathname === "/api/admin/directory/members" && u.searchParams.get("q") === "alice",
    );
    expect(queried).toHaveLength(2);
    expect(queried[1]!.searchParams.get("cursor")).toBe("page-2");
    expect(queried[0]!.searchParams.get("cursor")).toBeNull();
    expect(queried[1]!.searchParams.get("active")).toBe("true");
    expect((select as HTMLSelectElement).value).toBe("user-52");
    expect(option).toBeTruthy();
  });

  it("ignores a stale owner search response after a newer request", async () => {
    let resolveOld: ((r: Response) => void) | undefined;
    const requests = stubFetch(baseHandlers((url) => {
      const q = url.searchParams.get("q");
      if (q === "old") return new Promise<Response>((resolve) => { resolveOld = resolve; });
      if (q === "new") return Response.json({ items: [member("9")], next_cursor: null });
      return Response.json({ items: [member("1")], next_cursor: null });
    }));
    await openCreateForm();
    const search = await screen.findByPlaceholderText("Search owner email");
    fireEvent.change(search, { target: { value: "old" } });
    fireEvent.click(screen.getByRole("button", { name: /^search$/i }));
    fireEvent.change(search, { target: { value: "new" } });
    fireEvent.click(screen.getByRole("button", { name: /^search$/i }));
    await screen.findByRole("option", { name: /member9@example.com/i });
    resolveOld?.(Response.json({ items: [member("stale")], next_cursor: null }));
    await waitFor(() => expect(
      screen.queryByRole("option", { name: /memberstale@example.com/i }),
    ).toBeNull());
    const memberRequests = requests.filter((u) => u.pathname === "/api/admin/directory/members");
    expect(memberRequests.length).toBeGreaterThanOrEqual(3);
  });

  it("discards an owner page still in flight on inventory unmount", async () => {
    let resolveLate: ((r: Response) => void) | undefined;
    stubFetch(baseHandlers((url) => {
      if (!url.searchParams.get("cursor")) {
        return Response.json({ items: [member("1")], next_cursor: "more" });
      }
      return new Promise<Response>((resolve) => { resolveLate = resolve; });
    }));
    const page = await openCreateForm();
    fireEvent.click(await screen.findByRole("button", { name: /load more/i }));
    page.unmount();
    resolveLate?.(Response.json({ items: [member("late")], next_cursor: null }));
    await waitFor(() => expect(screen.queryByRole("option", { name: /memberlate@example.com/i })).toBeNull());
  });
});
