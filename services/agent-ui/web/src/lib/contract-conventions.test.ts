import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { BrowserSessionClient } from "./browser-session.ts";

const session = () => ({
  principal: { user_id: "user-1", organization_id: "org-1", membership_id: "member-1",
    organization_slug: "engineering", organization_name: "Engineering", system_role: "user",
    organization_role: "member", active: true },
  expires_at: "2026-10-12T00:00:00Z", idle_expires_at: "2026-10-11T12:30:00Z", activity_interval_ms: 1666,
});

function conventionClient(t: TestContext, page: unknown) {
  const paths: string[] = [];
  const client = new BrowserSessionClient({
    csrf: () => "csrf",
    fetch: async (input) => {
      const path = String(input);
      paths.push(path);
      return path === "/api/session" ? Response.json(session()) : Response.json(page);
    },
  });
  t.after(() => client.dispose());
  return { client, paths };
}

test("contract conventions: session lists send the canonical cursor and read canonical pages", async (t) => {
  const { client, paths } = conventionClient(t, { items: [], next_cursor: null });
  await client.read();
  const page = await client.sessions("opaque /2");
  const upstream = paths.find((path) => path.startsWith("/api/session/sessions"));
  assert.equal(upstream, "/api/session/sessions?limit=50&cursor=opaque%20%2F2");
  assert.ok(!upstream?.includes("after_id"));
  assert.deepEqual(page.items, []);
  assert.equal(page.next_cursor, null);
  assert.equal(client.responseCurrent(page), true);
});

test("contract conventions: external identities keep the notice cursor independent", async (t) => {
  const { client, paths } = conventionClient(t, {
    items: [], notices: [], next_cursor: null, next_notice_after_id: "notice-next",
  });
  await client.read();
  const page = await client.externalIdentities({ afterID: "binding /2", noticeAfterID: "notice +2" });
  const upstream = paths.find((path) => path.startsWith("/api/session/external-identities"));
  assert.equal(upstream,
    "/api/session/external-identities?limit=50&cursor=binding%20%2F2&notice_after_id=notice%20%2B2");
  assert.ok(!upstream?.includes("&after_id="));
  assert.deepEqual(page.items, []);
  assert.deepEqual(page.notices, []);
  assert.equal(page.next_cursor, null);
  assert.equal(page.next_notice_after_id, "notice-next");
});

test("contract conventions: canonical continuation strings carry through", async (t) => {
  const { client } = conventionClient(t, { items: [], next_cursor: "binding-2" });
  await client.read();
  const page = await client.sessions("binding-1");
  assert.equal(page.next_cursor, "binding-2");
});
