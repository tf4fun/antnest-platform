import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, resetSessionRequests } from "./api";

const principal = { organization_id: "org-1", user_id: "user-1", membership_id: "membership-1" };
let cookie: string;
beforeEach(() => {
  cookie = "__Host-antnest_csrf=directory-session";
  vi.spyOn(document, "cookie", "get").mockImplementation(() => cookie);
  resetSessionRequests(principal);
});

afterEach(() => {
  resetSessionRequests();
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

function stubFetch(handler: (url: URL, signal?: AbortSignal) => Response | Promise<Response>) {
  const requests: URL[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input.toString(), "http://localhost");
    requests.push(url);
    return handler(url, init?.signal ?? undefined);
  }));
  return requests;
}

it("api.directoryMembers requests the canonical first page", async () => {
  const requests = stubFetch(() => Response.json({ items: [member("1")], next_cursor: null }));
  const page = await api.directoryMembers();
  expect(requests).toHaveLength(1);
  expect(requests[0].pathname).toBe("/api/admin/directory/members");
  expect(requests[0].searchParams.get("limit")).toBe("50");
  expect(page.items).toHaveLength(1);
  expect(page.items[0].membership.email).toBe("member1@example.com");
  expect(page.next_cursor).toBeNull();
});

it("api.directoryMembers URI-encodes canonical query fields only", async () => {
  const requests = stubFetch(() => Response.json({ items: [], next_cursor: null }));
  await api.directoryMembers({
    q: " Alice ", role: "admin", active: false, source: "scim",
    cursor: "opa+que=", limit: 10,
  });
  const url = requests[0];
  expect(url.searchParams.get("limit")).toBe("10");
  expect(url.searchParams.get("q")).toBe("alice");
  expect(url.searchParams.get("role")).toBe("admin");
  expect(url.searchParams.get("active")).toBe("false");
  expect(url.searchParams.get("source")).toBe("scim");
  expect(url.searchParams.get("cursor")).toBe("opa+que=");
  expect(url.searchParams.get("after")).toBeNull();
  expect(url.searchParams.get("after_id")).toBeNull();
  expect(url.searchParams.get("email_prefix")).toBeNull();
});

it("api.directoryMembers forwards the abort signal", async () => {
  const controller = new AbortController();
  let received: AbortSignal | undefined;
  stubFetch((_url, signal) => {
    received = signal;
    return Response.json({ items: [], next_cursor: null });
  });
  await api.directoryMembers({}, controller.signal);
  expect(received?.aborted).toBe(false);
  controller.abort();
  expect(received?.aborted).toBe(true);
});

it("api.directoryMembers rejects malformed pages", async () => {
  for (const payload of [
    { items: null, next_cursor: null },
    { items: "not-an-array", next_cursor: null },
    { items: [], next_cursor: undefined },
    { items: [], next_cursor: 5 },
    { items: new Array(201).fill(member("1")), next_cursor: null },
    { items: [{ user: { id: "u" }, membership: { id: "m" } }], next_cursor: null },
    {
      items: [{
        user: { ...member("1").user, credential_ref: "secret" },
        membership: { ...member("1").membership, organization_id: "org-1" },
      }],
      next_cursor: null,
    },
  ]) {
    stubFetch(() => Response.json(payload));
    await expect(api.directoryMembers()).rejects.toThrow();
    vi.unstubAllGlobals();
  }
});

it("api.directoryMembers validates a populated page end to end", async () => {
  stubFetch(() => Response.json({
    items: [member("a"), member("b")],
    next_cursor: "next-page",
  }));
  const page = await api.directoryMembers({ limit: 2 });
  expect(page.items.map((item) => item.membership.id)).toEqual(["membership-a", "membership-b"]);
  expect(page.next_cursor).toBe("next-page");
});

it("api.directoryGroups requests its own first page without role", async () => {
  const requests = stubFetch(() => Response.json({ items: [group("Operators")], next_cursor: null }));
  const page = await api.directoryGroups({ q: "Op" });
  expect(requests[0].pathname).toBe("/api/admin/directory/groups");
  expect(requests[0].searchParams.get("q")).toBe("op");
  expect(requests[0].searchParams.get("limit")).toBe("50");
  expect(requests[0].searchParams.get("role")).toBeNull();
  expect(page.items[0].display_name).toBe("Operators");
});

it("api.directoryGroups rejects malformed pages", async () => {
  stubFetch(() => Response.json({ items: [{ display_name: 5 }], next_cursor: null }));
  await expect(api.directoryGroups()).rejects.toThrow();
});
