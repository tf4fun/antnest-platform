import assert from "node:assert/strict";
import test from "node:test";
import { BrowserSessionClient, BrowserSessionError, BrowserSessionChanged } from "./browser-session.ts";

const session = () => ({
  principal: { user_id: "user-1", organization_id: "org-1", membership_id: "member-1",
    organization_slug: "engineering", organization_name: "Engineering", system_role: "user",
    organization_role: "member", active: true },
  expires_at: "2026-10-12T00:00:00Z", idle_expires_at: "2026-10-11T12:30:00Z", activity_interval_ms: 1666,
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test("a delivery hint is not authentication; separate clients require their own fresh session read", async () => {
  let hints = 0;
  const first = new BrowserSessionClient({ csrf: () => { hints++; return "csrf-1"; },
    fetch: async () => Response.json(session()) });
  const second = new BrowserSessionClient({ csrf: () => "csrf-1", fetch: async () => Response.json(session()) });
  assert.equal(hints, 0, "construction must not read browser state during SSR");
  assert.throws(() => first.capture(), BrowserSessionChanged);
  const current = await first.read();
  assert.equal(first.responseCurrent(current), true);
  assert.equal(first.capture().hint, "csrf-1");
  assert.throws(() => second.capture(), BrowserSessionChanged);
  first.dispose(); second.dispose();
});

for (const invalid of [
  { activity_interval_ms: 0 }, { activity_interval_ms: 30_001 }, { expires_at: "invalid" },
  { idle_expires_at: "2027-01-01T00:00:00Z" }, { principal: { ...session().principal, active: false } },
  { principal: { ...session().principal, membership_id: "" } },
]) test(`invalid session metadata does not authorize private requests: ${JSON.stringify(invalid)}`, async () => {
  const client = new BrowserSessionClient({ csrf: () => "csrf", fetch: async () => Response.json({ ...session(), ...invalid }) });
  await assert.rejects(client.read(), (cause: unknown) => cause instanceof BrowserSessionError && cause.code === "invalid_response");
  assert.throws(() => client.capture(), BrowserSessionChanged);
  client.dispose();
});

test("a missing hint fails after non-touch authentication and never fabricates CSRF", async () => {
  const calls: RequestInit[] = [];
  const client = new BrowserSessionClient({ csrf: () => undefined, fetch: async (_url, init) => {
    calls.push(init!); return Response.json(session());
  } });
  await assert.rejects(client.read(), (cause: unknown) => cause instanceof BrowserSessionError && cause.status === 401);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, "GET");
  assert.equal(new Headers(calls[0]!.headers).has("X-Antnest-CSRF-Token"), false);
  assert.throws(() => client.capture(), BrowserSessionChanged);
  client.dispose();
});

for (const status of [200, 204, 401, 503]) test(`changed delivery discards stale account response ${status}`, async () => {
  let hint = "first";
  const response = deferred<Response>();
  const changes: string[] = [];
  const client = new BrowserSessionClient({ csrf: () => hint, fetch: async path =>
    String(path) === "/api/session" ? Response.json(session()) : response.promise });
  client.subscribe(event => changes.push(event.type));
  await client.read();
  const pending = client.account();
  hint = "replacement";
  response.resolve(status === 204 ? new Response(null, { status }) : Response.json({ code: "old" }, { status }));
  await assert.rejects(pending, BrowserSessionChanged);
  assert.deepEqual(changes, ["ready", "validation_required"]);
  client.dispose();
});

test("stalled body and ignored abort settle at deadline without validating late results", async () => {
  const body = deferred<unknown>();
  const response = Response.json(session());
  response.json = () => body.promise;
  const client = new BrowserSessionClient({ csrf: () => "csrf", timeoutMs: 5, fetch: async () => response });
  await assert.rejects(client.read(), (cause: unknown) => cause instanceof BrowserSessionError && cause.code === "session_request_timeout");
  body.resolve(session());
  await Promise.resolve();
  assert.throws(() => client.capture(), BrowserSessionChanged);
  client.dispose();
});

test("validation cancellation aborts old requests and invalidates handoff proof", async () => {
  let hint = "first";
  const signals: AbortSignal[] = [];
  const events: string[] = [];
  const client = new BrowserSessionClient({ csrf: () => hint, fetch: async (path, init) => {
    if (String(path) === "/api/session") return Response.json(session());
    signals.push(init!.signal!); return new Promise<Response>(() => {});
  } });
  client.subscribe(event => events.push(event.type));
  const first = await client.read();
  const pending = client.account();
  hint = "replacement";
  assert.equal(client.responseCurrent(first), false);
  await assert.rejects(pending, BrowserSessionChanged);
  assert.equal(signals[0]!.aborted, true);
  const next = await client.read();
  assert.equal(client.responseCurrent(first), false);
  assert.equal(client.responseCurrent(next), true);
  assert.deepEqual(events, ["ready", "validation_required", "ready"]);
  client.dispose();
});

test("password rotation reads the current browser session and preserves the absolute deadline", async () => {
  let hint = "old";
  const calls: string[] = [];
  const client = new BrowserSessionClient({ csrf: () => hint, fetch: async (path, init) => {
    calls.push(String(path));
    if (String(path) === "/api/session/password") {
      assert.equal(new Headers(init?.headers).get("X-Antnest-CSRF-Token"), "old");
      assert.deepEqual(JSON.parse(String(init?.body)), { current_password: "before", new_password: "long replacement" });
      hint = "new";
      return Response.json({ ...session(), principal: { ...session().principal, user_id: "ignored writer body" } });
    }
    return Response.json(session());
  } });
  const previous = await client.read();
  const next = await client.password("before", "long replacement");
  assert.equal(next.principal.user_id, "user-1");
  assert.equal(next.expires_at, previous.expires_at);
  assert.equal(client.responseCurrent(previous), false);
  assert.equal(client.responseCurrent(next), true);
  assert.deepEqual(calls, ["/api/session", "/api/session/password", "/api/session"]);
  client.dispose();
});

for (const status of [400, 503]) test(`password failure ${status} preserves validation with no retry or fresh session read`, async () => {
  const calls: string[] = [];
  const client = new BrowserSessionClient({ csrf: () => "csrf", fetch: async path => {
    calls.push(String(path));
    return String(path) === "/api/session" ? Response.json(session()) : Response.json({ code: status === 400 ? "invalid_current_password" : "unavailable" }, { status });
  } });
  const before = await client.read();
  await assert.rejects(client.password("wrong", "long replacement"), (cause: unknown) => cause instanceof BrowserSessionError && cause.status === status);
  assert.equal(client.responseCurrent(before), true);
  assert.equal(calls.length, 2);
  client.dispose();
});

test("writer 204 cannot establish a session and requires fresh validation", async () => {
  let hint = "old";
  const events: string[] = [];
  const client = new BrowserSessionClient({ csrf: () => hint, fetch: async path => {
    if (String(path) === "/api/session") return Response.json(session());
    hint = "new"; return new Response(null, { status: 204 });
  } });
  client.subscribe(event => events.push(event.type));
  await client.read();
  await assert.rejects(client.password("before", "long replacement"), (cause: unknown) => cause instanceof BrowserSessionError && cause.code === "invalid_response");
  assert.deepEqual(events, ["ready", "validation_required"]);
  client.dispose();
});

for (const status of [204, 401]) test(`logout ${status} accepts cleared delivery but cannot end a replacement`, async () => {
  for (const next of [undefined, "other tab"]) {
    let hint: string | undefined = "old";
    const events: string[] = [];
    const client = new BrowserSessionClient({ csrf: () => hint, fetch: async (_path, init) => {
      if (init?.method !== "DELETE") return Response.json(session());
      hint = next;
      return status === 204 ? new Response(null, { status }) : Response.json({ code: "unauthorized" }, { status });
    } });
    client.subscribe(event => events.push(event.type));
    await client.read();
    if (next) {
      await assert.rejects(client.logout(), BrowserSessionChanged);
      assert.deepEqual(events, ["ready", "validation_required"]);
    } else {
      await client.logout();
      assert.deepEqual(events, ["ready", "ended"]);
    }
    client.dispose();
  }
});

test("current activity 401 ends only its own instance; ordinary 503 preserves it", async () => {
  let status = 503;
  const events: string[] = [];
  const client = new BrowserSessionClient({ csrf: () => "csrf", fetch: async path =>
    String(path) === "/api/session" ? Response.json(session()) : Response.json({ code: "failure" }, { status }) });
  client.subscribe(event => events.push(event.type));
  const before = await client.read();
  await assert.rejects(client.activity(new AbortController().signal), BrowserSessionError);
  assert.equal(client.responseCurrent(before), true);
  status = 401;
  await assert.rejects(client.activity(new AbortController().signal), BrowserSessionError);
  assert.deepEqual(events, ["ready", "ended"]);
  assert.equal(client.responseCurrent(before), false);
  client.dispose();
});

test("session inventory and revoke carry only public cursor, mode and fresh intent", async () => {
  const calls: { path: string; init: RequestInit }[] = [];
  const client = new BrowserSessionClient({ csrf: () => "csrf", fetch: async (path, init) => {
    calls.push({ path: String(path), init: init! });
    if (String(path) === "/api/session") return Response.json(session());
    if (String(path).endsWith("/revoke")) return Response.json({ revoked_count: 2, current_revoked: false });
    return Response.json({ sessions: [], next_after_id: "next" });
  } });
  await client.read();
  await client.sessions("public /id");
  await client.revoke("others");
  await client.revoke("others");
  assert.equal(calls[1]!.path, "/api/session/sessions?limit=50&after_id=public%20%2Fid");
  assert.deepEqual(JSON.parse(String(calls[2]!.init.body)), { mode: "others" });
  const firstHeaders = new Headers(calls[2]!.init.headers);
  assert.equal(firstHeaders.get("X-Antnest-CSRF-Token"), "csrf");
  assert.ok(firstHeaders.get("Idempotency-Key"));
  assert.notEqual(firstHeaders.get("Idempotency-Key"), new Headers(calls[3]!.init.headers).get("Idempotency-Key"));
  client.dispose();
});

for (const action of ["activity", "revoke"] as const) test(`${action} cancellation at body-to-result handoff cannot publish or end the session`, async () => {
  const body = deferred<unknown>();
  const entered = deferred<void>();
  const events: string[] = [];
  const client = new BrowserSessionClient({ csrf: () => "csrf", fetch: async path => {
    if (String(path) === "/api/session") return Response.json(session());
    const response = Response.json({});
    response.json = () => { entered.resolve(); return body.promise; };
    return response;
  } });
  client.subscribe(event => events.push(event.type));
  const before = await client.read();
  const caller = new AbortController();
  const pending = action === "activity" ? client.activity(caller.signal) : client.revoke("all", caller.signal);
  await entered.promise;
  body.resolve(action === "activity" ? session() : { revoked_count: 1, current_revoked: true });
  queueMicrotask(() => caller.abort(new DOMException("Caller is gone", "AbortError")));
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(client.responseCurrent(before), true);
  assert.deepEqual(events, ["ready"]);
  client.dispose();
});

test("logout cancels an ignored 401 body before completing", async () => {
  let cancellations = 0;
  const client = new BrowserSessionClient({ csrf: () => "csrf", fetch: async (_path, init) => {
    if (init?.method !== "DELETE") return Response.json(session());
    return new Response(new ReadableStream({ cancel() { cancellations++; } }), { status: 401 });
  } });
  await client.read();
  await client.logout();
  assert.equal(cancellations, 1);
  client.dispose();
});

test("password replacement owns fresh validation after the old panel closes and reports an unavailable replacement", async () => {
  for (const unavailable of [false, true]) {
    let hint = "old";
    let reads = 0;
    const events: string[] = [];
    const caller = new AbortController();
    const client = new BrowserSessionClient({ csrf: () => hint, fetch: async path => {
      if (String(path) === "/api/session/password") { hint = "new"; return Response.json(session()); }
      reads++;
      if (unavailable && reads > 1) return Response.json({ code: "unavailable", message: "Validation unavailable" }, { status: 503 });
      return Response.json(session());
    } });
    await client.read();
    client.subscribe(event => {
      events.push(event.type);
      if (event.type === "transition") caller.abort(new DOMException("Old panel closed", "AbortError"));
    });
    const pending = client.password("old password", "new password", caller.signal);
    if (unavailable) {
      await assert.rejects(pending, (cause: unknown) => cause instanceof BrowserSessionError && cause.status === 503);
      assert.deepEqual(events, ["transition", "transition_failed"]);
    } else {
      await assert.rejects(pending, { name: "AbortError" });
      assert.deepEqual(events, ["transition", "ready"]);
      assert.equal(client.capture().hint, "new");
    }
    assert.equal(reads, 2);
    client.dispose();
  }
});
