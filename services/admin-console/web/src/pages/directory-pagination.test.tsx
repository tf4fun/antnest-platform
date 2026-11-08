import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetSessionRequests } from "../lib/api";
import { DirectoryPage } from "./directory";

const principal = { organization_id: "org-1", user_id: "user-1", membership_id: "membership-1" };
let cookie: string;
beforeEach(() => {
  cookie = "__Host-antnest_csrf=directory-session";
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
const group = (name: string) => ({
  display_name: name, source: "local", active: true, ...timestamps,
});

type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response>;

function stubFetch(handlers: Record<string, Handler>, fallback?: Handler) {
  const requests: URL[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input.toString(), "http://localhost");
    requests.push(url);
    const handler = handlers[url.pathname] ?? fallback;
    if (!handler) throw new Error(`Unexpected request: ${url}`);
    return handler(url, init);
  }));
  return requests;
}

function renderDirectory() {
  return render(
    <DirectoryPage
      currentUserID="user-admin"
      organizationName="Engineering"
      systemAdministrator={true}
    />,
  );
}

describe("DirectoryPage people list", () => {
  it("loads only the members URL on first render", async () => {
    const requests = stubFetch({
      "/api/admin/directory/members": () => Response.json({ items: [member("1")], next_cursor: null }),
    });
    renderDirectory();
    await screen.findAllByText("member1@example.com");
    expect(requests.map((u) => u.pathname)).toEqual(["/api/admin/directory/members"]);
    expect(requests[0].searchParams.get("limit")).toBe("50");
  });

  it("appends a second page on load more and stops at null cursor", async () => {
    const requests = stubFetch({
      "/api/admin/directory/members": (url) =>
        url.searchParams.get("cursor") === "page-2"
          ? Response.json({ items: [member("2")], next_cursor: null })
          : Response.json({ items: [member("1")], next_cursor: "page-2" }),
    });
    renderDirectory();
    await screen.findAllByText("member1@example.com");
    fireEvent.click(screen.getByRole("button", { name: /load more/i }));
    await screen.findAllByText("member2@example.com");
    const memberRequests = requests.filter((u) => u.pathname === "/api/admin/directory/members");
    expect(memberRequests).toHaveLength(2);
    expect(memberRequests[1].searchParams.get("cursor")).toBe("page-2");
    expect(screen.queryByRole("button", { name: /load more/i })).toBeNull();
  });

  it("keeps rows and cursor when a next page fails and retries the identical cursor", async () => {
    let failed = true;
    const requests = stubFetch({
      "/api/admin/directory/members": (url) => {
        if (url.searchParams.get("cursor") === "page-2") {
          if (failed) {
            failed = false;
            return new Response(null, { status: 500 });
          }
          return Response.json({ items: [member("2")], next_cursor: null });
        }
        return Response.json({ items: [member("1")], next_cursor: "page-2" });
      },
    });
    renderDirectory();
    await screen.findAllByText("member1@example.com");
    fireEvent.click(screen.getByRole("button", { name: /load more/i }));
    const retry = await screen.findByRole("button", { name: /retry/i });
    expect(screen.queryByText("member2@example.com")).toBeNull();
    expect(screen.getAllByText("member1@example.com").length).toBeGreaterThanOrEqual(1);
    fireEvent.click(retry);
    await screen.findAllByText("member2@example.com");
    const cursorRequests = requests.filter(
      (u) => u.pathname === "/api/admin/directory/members" && u.searchParams.get("cursor") === "page-2",
    );
    expect(cursorRequests).toHaveLength(2);
  });

  it("sends trimmed lowercase q in the URL and fences stale responses", async () => {
    let resolveFirst: ((r: Response) => void) | undefined;
    const requests = stubFetch({
      "/api/admin/directory/members": (url) => {
        if (url.searchParams.get("q") === "alice") {
          return Response.json({ items: [member("found")], next_cursor: null });
        }
        return new Promise<Response>((resolve) => { resolveFirst = resolve; });
      },
    });
    renderDirectory();
    const search = await screen.findByRole("searchbox");
    fireEvent.change(search, { target: { value: "  ALICE  " } });
    fireEvent.submit(search.closest("form") ?? search);
    await screen.findAllByText("memberfound@example.com");
    const queried = requests.filter((u) => u.searchParams.get("q") === "alice");
    expect(queried).toHaveLength(1);
    resolveFirst?.(Response.json({ items: [member("stale")], next_cursor: null }));
    await waitFor(() => expect(screen.queryByText("memberstale@example.com")).toBeNull());
    expect(screen.getAllByText("memberfound@example.com").length).toBeGreaterThanOrEqual(1);
  });
});

describe("DirectoryPage groups list", () => {
  it("loads groups lazily on its tab and preserves same-name groups", async () => {
    const requests = stubFetch({
      "/api/admin/directory/members": () => Response.json({ items: [member("1")], next_cursor: null }),
      "/api/admin/directory/groups": (url) =>
        url.searchParams.get("cursor") === "groups-2"
          ? Response.json({ items: [group("Operators")], next_cursor: null })
          : Response.json({ items: [group("Operators"), group("Team A")], next_cursor: "groups-2" }),
    });
    renderDirectory();
    await screen.findAllByText("member1@example.com");
    fireEvent.click(screen.getByRole("tab", { name: /groups/i }));
    const operators = await screen.findAllByText("Operators");
    expect(operators.length).toBeGreaterThanOrEqual(1);
    fireEvent.click(screen.getByRole("button", { name: /load more/i }));
    await waitFor(() => expect(screen.getAllByText("Operators").length).toBeGreaterThanOrEqual(2));
    const groupRequests = requests.filter((u) => u.pathname === "/api/admin/directory/groups");
    expect(groupRequests).toHaveLength(2);
    expect(groupRequests[1].searchParams.get("cursor")).toBe("groups-2");
    expect(groupRequests[0].searchParams.get("role")).toBeNull();
  });

  it("does not drain pages eagerly", async () => {
    const requests = stubFetch({
      "/api/admin/directory/members": () => Response.json({ items: [member("1")], next_cursor: "more" }),
    });
    renderDirectory();
    await screen.findAllByText("member1@example.com");
    expect(requests.filter((u) => u.pathname === "/api/admin/directory/members")).toHaveLength(1);
  });

  it("reissues the first page with the new q when group filters change", async () => {
    const requests = stubFetch({
      "/api/admin/directory/members": () => Response.json({ items: [member("1")], next_cursor: null }),
      "/api/admin/directory/groups": (url) =>
        url.searchParams.get("q") === "ops"
          ? Response.json({ items: [group("Operators")], next_cursor: null })
          : Response.json({ items: [group("Everyone")], next_cursor: null }),
    });
    renderDirectory();
    await screen.findAllByText("member1@example.com");
    fireEvent.click(screen.getByRole("tab", { name: /groups/i }));
    await screen.findAllByText("Everyone");
    const search = screen.getByRole("searchbox");
    fireEvent.change(search, { target: { value: "OPS" } });
    fireEvent.submit(search.closest("form") ?? search);
    await screen.findAllByText("Operators");
    const groupRequests = requests.filter((u) => u.pathname === "/api/admin/directory/groups");
    expect(groupRequests).toHaveLength(2);
    expect(groupRequests[0].searchParams.get("q")).toBeNull();
    expect(groupRequests[1].searchParams.get("q")).toBe("ops");
    expect(groupRequests[1].searchParams.get("cursor")).toBeNull();
  });

  it("does not auto-retry a failed group first page but retries on demand", async () => {
    let fail = true;
    const requests = stubFetch({
      "/api/admin/directory/members": () => Response.json({ items: [member("1")], next_cursor: null }),
      "/api/admin/directory/groups": () => {
        if (fail) {
          fail = false;
          return new Response(null, { status: 500 });
        }
        return Response.json({ items: [group("Operators")], next_cursor: null });
      },
    });
    renderDirectory();
    await screen.findAllByText("member1@example.com");
    fireEvent.click(screen.getByRole("tab", { name: /groups/i }));
    const retry = await screen.findByRole("button", { name: /retry/i });
    expect(requests.filter((u) => u.pathname === "/api/admin/directory/groups")).toHaveLength(1);
    fireEvent.click(retry);
    await screen.findAllByText("Operators");
    expect(requests.filter((u) => u.pathname === "/api/admin/directory/groups")).toHaveLength(2);
  });

  it("keeps one outstanding read when load-more fires twice", async () => {
    let resolvePage: ((r: Response) => void) | undefined;
    const requests = stubFetch({
      "/api/admin/directory/members": (url) => {
        if (!url.searchParams.get("cursor")) {
          return Response.json({ items: [member("1")], next_cursor: "page-2" });
        }
        return new Promise<Response>((resolve) => { resolvePage = resolve; });
      },
    });
    renderDirectory();
    await screen.findAllByText("member1@example.com");
    const button = screen.getByRole("button", { name: /load more/i });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(
      requests.filter((u) => u.searchParams.get("cursor") === "page-2"),
    ).toHaveLength(1));
    resolvePage?.(Response.json({ items: [member("2")], next_cursor: null }));
    await screen.findAllByText("member2@example.com");
  });
});
