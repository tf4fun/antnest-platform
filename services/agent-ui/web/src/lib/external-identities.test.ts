import assert from "node:assert/strict";
import test from "node:test";
import { BrowserSessionClient, BrowserSessionChanged, BrowserSessionError } from "./browser-session.ts";

const session = () => ({
  principal: { user_id: "user-1", organization_id: "org-1", membership_id: "member-1", organization_slug: "engineering", organization_name: "Engineering", system_role: "user", organization_role: "member", active: true },
  expires_at: "2026-10-12T00:00:00Z", idle_expires_at: "2026-10-11T12:30:00Z", activity_interval_ms: 1666,
});
const page = {
  bindings: [{ id: "binding-1", provider_id: "provider-1", provider_name: "workforce", provider_display_name: "Workforce", organization_id: "other-org", organization_slug: "other", organization_name: "Other organization", membership_id: "other-member", subject: "  <opaque> é 😀  ", method: "scim", provider_enabled: false, created_at: "2026-10-11T00:00:00Z", bound_at: "2026-10-11T01:00:00Z", revoked_at: null }],
  notices: [{ id: "notice-1", binding_id: "historical-binding", provider_id: "old-provider", provider_name: "old", provider_display_name: "Old provider", organization_id: "historical-org", organization_slug: "historical", organization_name: "Historical organization", membership_id: "old-member", subject: "historical subject", method: "auto", created_at: "2026-10-10T00:00:00Z" }],
  next_after_id: "binding-1", next_notice_after_id: "notice-1",
};
const base = "/api/session/external-identities";
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };

test("external inventories retain cross-organization snapshots and use independent escaped cursors", async () => {
  const calls: Array<{ path: string; init: RequestInit }> = [];
  const client = new BrowserSessionClient({ csrf: () => "csrf", fetch: async (path, init) => {
    calls.push({ path: String(path), init: init! });
    return Response.json(String(path) === "/api/session" ? session() : page);
  } });
  await client.read();
  const result = await client.externalIdentities({ afterID: "binding /2", noticeAfterID: "notice +2" });
  assert.deepEqual(result, page);
  assert.equal(client.responseCurrent(result), true);
  assert.equal(calls[1]!.path, base + "?limit=50&after_id=binding%20%2F2&notice_after_id=notice%20%2B2");
  assert.equal(calls[1]!.init.method, "GET");
  assert.equal(calls[1]!.init.credentials, "same-origin");
  assert.equal(calls[1]!.init.cache, "no-store");
  assert.equal(calls[1]!.init.body, undefined);
  client.dispose();
});

test("unbind and ACK send only frozen public intent with fresh keys and existing CSRF delivery", async () => {
  const calls: Array<{ path: string; init: RequestInit }> = [];
  const client = new BrowserSessionClient({ csrf: () => "csrf", fetch: async (path, init) => {
    calls.push({ path: String(path), init: init! });
    return Response.json(String(path) === "/api/session" ? session() : init!.method === "DELETE" ? { revoked_count: 0, current_revoked: false } : { acknowledged_count: 0 });
  } });
  await client.read();
  await client.unbindExternalIdentity("binding /1");
  await client.unbindExternalIdentity("binding /1", true);
  const ids = ["notice-1", "notice-2"];
  const acknowledgment = client.acknowledgeExternalIdentityNotices(ids);
  ids.push("new-notice");
  const result = await acknowledgment;
  assert.equal(client.responseCurrent(result), true);
  assert.equal(calls[1]!.path, base + "/binding%20%2F1");
  assert.equal(calls[1]!.init.method, "DELETE");
  assert.deepEqual(JSON.parse(String(calls[1]!.init.body)), { allow_lockout: false });
  assert.deepEqual(JSON.parse(String(calls[2]!.init.body)), { allow_lockout: true });
  assert.equal(calls[3]!.path, base + "/notices/acknowledge");
  assert.equal(calls[3]!.init.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[3]!.init.body)), { notice_ids: ["notice-1", "notice-2"] });
  const keys = new Set<string>();
  for (const call of calls.slice(1)) {
    const headers = new Headers(call.init.headers);
    assert.equal(headers.get("X-Antnest-CSRF-Token"), "csrf");
    assert.equal(headers.get("Authorization"), null);
    assert.ok(headers.get("Idempotency-Key")); keys.add(headers.get("Idempotency-Key")!);
  }
  assert.equal(keys.size, 3);
  client.dispose();
});

const actions = {
  inventory: (client: BrowserSessionClient, signal?: AbortSignal) => client.externalIdentities({}, signal),
  unbind: (client: BrowserSessionClient, signal?: AbortSignal) => client.unbindExternalIdentity("binding-1", false, signal),
  acknowledge: (client: BrowserSessionClient, signal?: AbortSignal) => client.acknowledgeExternalIdentityNotices(["notice-1"], signal),
};
for (const [name, run] of Object.entries(actions)) {
  for (const status of [401, 503]) test(`${name} ${status} has one attempt and only current 401 retires the session`, async () => {
    let calls = 0;
    const events: string[] = [];
    const client = new BrowserSessionClient({ csrf: () => "csrf", fetch: async path => {
      calls++; return String(path) === "/api/session" ? Response.json(session()) : Response.json({ code: "unavailable" }, { status });
    } });
    client.subscribe(event => events.push(event.type));
    const before = await client.read();
    await assert.rejects(run(client), (cause: unknown) => cause instanceof BrowserSessionError && cause.status === status);
    assert.equal(client.responseCurrent(before), status !== 401);
    assert.deepEqual(events, status === 401 ? ["ready", "ended"] : ["ready"]);
    assert.equal(calls, 2);
    client.dispose();
  });
  for (const status of [200, 401, 503]) test(`stale ${name} ${status} cannot mutate a replacement session`, async () => {
    const entered = deferred<void>(), body = deferred<unknown>();
    const events: string[] = [];
    const client = new BrowserSessionClient({ csrf: () => "csrf", fetch: async path => {
      if (String(path) === "/api/session") return Response.json(session());
      const response = Response.json({}, { status });
      response.json = () => { entered.resolve(); return body.promise; };
      return response;
    } });
    client.subscribe(event => events.push(event.type));
    await client.read();
    const pending = run(client);
    const rejected = assert.rejects(pending, BrowserSessionChanged);
    await entered.promise;
    const current = await client.read();
    body.resolve(name === "inventory" ? page : name === "unbind" ? { revoked_count: 1, current_revoked: true } : { acknowledged_count: 1 });
    await rejected;
    assert.equal(client.responseCurrent(current), true);
    assert.deepEqual(events, ["ready", "ready"]);
    client.dispose();
  });
  test(`${name} refuses a replaced delivery before sending its request`, async () => {
    let hint = "before", calls = 0;
    const client = new BrowserSessionClient({ csrf: () => hint, fetch: async () => { calls++; return Response.json(session()); } });
    await client.read(); hint = "after";
    await assert.rejects(async () => run(client), BrowserSessionChanged);
    assert.equal(calls, 1);
    client.dispose();
  });
}

test("committed current unbind ends once with no inventory refresh or logout request", async () => {
  const calls: string[] = [], events: string[] = [];
  const client = new BrowserSessionClient({ csrf: () => "csrf", fetch: async path => {
    calls.push(String(path)); return Response.json(String(path) === "/api/session" ? session() : { revoked_count: 2, current_revoked: true });
  } });
  client.subscribe(event => events.push(event.type));
  const before = await client.read();
  const result = await client.unbindExternalIdentity("binding-1", true);
  assert.equal(result.current_revoked, true);
  assert.equal(client.responseCurrent(before), false);
  assert.deepEqual(events, ["ready", "ended"]);
  assert.deepEqual(calls, ["/api/session", base + "/binding-1"]);
  client.dispose();
});

for (const name of ["unbind", "acknowledge"] as const) test(`${name} cancellation at body-to-result handoff cannot publish or end`, async () => {
  const body = deferred<unknown>(), entered = deferred<void>();
  const events: string[] = [];
  const client = new BrowserSessionClient({ csrf: () => "csrf", fetch: async path => {
    if (String(path) === "/api/session") return Response.json(session());
    const response = Response.json({}); response.json = () => { entered.resolve(); return body.promise; }; return response;
  } });
  client.subscribe(event => events.push(event.type));
  const before = await client.read(), controller = new AbortController();
  const pending = actions[name](client, controller.signal);
  await entered.promise;
  body.resolve(name === "unbind" ? { revoked_count: 1, current_revoked: true } : { acknowledged_count: 1 });
  queueMicrotask(() => controller.abort(new DOMException("Caller gone", "AbortError")));
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(client.responseCurrent(before), true);
  assert.deepEqual(events, ["ready"]);
  client.dispose();
});

for (const invalid of [null, {}, { revoked_count: -1, current_revoked: false }, { revoked_count: 0, current_revoked: true }, { revoked_count: 1.5, current_revoked: false }, { revoked_count: 1, current_revoked: null }, { acknowledged_count: -1 }, { acknowledged_count: 2 }, { acknowledged_count: 0.5 }]) {
  test(`malformed mutation metadata cannot confirm external identity work: ${JSON.stringify(invalid)}`, async () => {
    const client = new BrowserSessionClient({ csrf: () => "csrf", fetch: async path => Response.json(String(path) === "/api/session" ? session() : invalid) });
    const before = await client.read();
    const run = invalid && "acknowledged_count" in invalid ? actions.acknowledge : actions.unbind;
    await assert.rejects(run(client), (cause: unknown) => cause instanceof BrowserSessionError && cause.code === "invalid_response");
    assert.equal(client.responseCurrent(before), true);
    client.dispose();
  });
}
