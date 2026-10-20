import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { shortenIdleSession } from "./resolve-cache-expiry-fixture.mjs";

function harness(change = () => {}) {
  const calls = [],
    snapshots = [];
  const before = {
    idle_expires_at: "2026-10-12T10:30:00Z",
    expires_at: "2026-10-12T22:00:00Z",
    last_used_at: "2026-10-12T10:00:00Z",
    issued_at: "2026-10-12T10:00:00Z",
  };
  const after = { ...before, idle_expires_at: "2026-10-12T10:00:02Z" };
  const state = {
    project: "antnest-lifecycle-fixture1",
    service: "postgres",
    running: true,
    result: { matches: 1, updated: 1, only_idle_changed: true, before, after },
    read: { ...after, expired: false, remaining_ms: 1500 },
    probe: { matches: 0, updated: 0 },
    probeMutation: false,
    protectedMutation: false,
  };
  change(state);
  const options = {
    project: "antnest-lifecycle-fixture1",
    compose: (args) => ["compose", ...args],
    token: "private-cookie-token",
    principal: {
      user_id: "user-1",
      organization_id: "org-1",
      membership_id: "membership-1",
    },
    idleMS: 2000,
    protectedTokens: ["private-warm-member-token", "private-warm-admin-token"],
    otherMembership: "membership-2",
    secrets: [],
    docker: async (args) => {
      calls.push(args);
      if (args[0] === "compose") return "a".repeat(64);
      if (args[0] === "inspect")
        return JSON.stringify([
          {
            Id: "a".repeat(64),
            Config: {
              Labels: {
                "com.docker.compose.project": state.project,
                "com.docker.compose.service": state.service,
              },
            },
            State: { Running: state.running },
          },
        ]);
      snapshots.push(args.at(-1));
      const sql = args.at(-1);
      if (sql.includes("'protected'")) {
        const count = snapshots.filter((s) => s.includes("'protected'")).length;
        return JSON.stringify({
          target: {
            ...(count >= 3 ? after : before),
            public_session_id: "private-session-id",
            ...(count === 2 && state.probeMutation ? { changed: true } : {}),
          },
          protected: [
            {
              id: "warm-member",
              changed: count >= 3 && state.protectedMutation,
            },
            { id: "warm-admin" },
          ],
        });
      }
      if (sql.includes("membership_id='membership-2'"))
        return JSON.stringify(state.probe);
      return JSON.stringify(
        sql.includes("UPDATE api_tokens") ? state.result : state.read,
      );
    },
  };
  return { options, calls, snapshots, state };
}

test("isolated expiry fixture shortens one exact browser session and observes unchanged reads", async () => {
  const h = harness();
  const fixture = await shortenIdleSession(h.options);
  assert.equal(fixture.containerID, "a".repeat(64));
  const row = await fixture.read();
  assert.equal(row.expired, false);
  assert.equal(row.remaining_ms, 1500);
  assert.equal(fixture.evidence.idle_ms, 2000);
  assert.equal(fixture.evidence.only_idle_changed, true);
  assert(!JSON.stringify(fixture.evidence).includes(h.options.token));
  assert.equal(h.options.secrets.length, 3);
  assert.deepEqual(fixture.evidence.no_match_probe, {
    matches: 0,
    updated: 0,
    unchanged: true,
  });
  assert.equal(fixture.evidence.protected_unchanged, 2);
  for (const query of h.snapshots) {
    assert(query.includes("token_hash="));
    assert(query.includes("user_id='user-1'"));
    assert(query.includes("organization_id='org-1'"));
    assert(
      query.includes("membership_id='membership-1'") ||
        query.includes("membership_id='membership-2'"),
    );
    assert(query.includes("kind='browser'"));
    assert(query.includes("revoked_at IS NULL"));
    assert(!query.includes(h.options.token));
  }
});
for (const [label, change] of [
  ["wrong membership matched", (s) => (s.probe.matches = 1)],
  ["negative probe mutated row", (s) => (s.probe.updated = 1)],
  ["negative probe changed target", (s) => (s.probeMutation = true)],
  ["fixture changed warm session", (s) => (s.protectedMutation = true)],
])
  test(`expiry isolation rejects ${label} without disclosing rows`, async () => {
    const h = harness(change);
    await assert.rejects(shortenIdleSession(h.options), (error) => {
      assert(!error.message.includes("private-session-id"));
      assert(!error.stack.includes("private-session-id"));
      return true;
    });
  });
for (const [label, change] of [
  ["foreign project", (s) => (s.project = "unowned")],
  ["foreign service", (s) => (s.service = "identity-service")],
  ["stopped database", (s) => (s.running = false)],
])
  test(`expiry fixture refuses ${label} before any SQL`, async () => {
    const h = harness(change);
    await assert.rejects(shortenIdleSession(h.options));
    assert.equal(h.snapshots.length, 0);
  });
for (const [label, change] of [
  ["wrong binding", (s) => (s.result.matches = 0)],
  ["duplicate row", (s) => (s.result.matches = 2)],
  ["no actual mutation", (s) => (s.result.updated = 0)],
  ["another field changed", (s) => (s.result.only_idle_changed = false)],
  [
    "absolute expiry changed",
    (s) => (s.result.after.expires_at = "2026-10-12T21:00:00Z"),
  ],
  [
    "last-used renewed",
    (s) => (s.result.after.last_used_at = "2026-10-12T10:00:01Z"),
  ],
  [
    "idle extended",
    (s) => (s.result.after.idle_expires_at = "2026-10-12T11:00:00Z"),
  ],
])
  test(`expiry fixture rejects ${label}`, async () => {
    const h = harness(change);
    await assert.rejects(shortenIdleSession(h.options));
  });
test("ordinary session reads may not renew either deadline or last-used", async () => {
  const h = harness();
  const fixture = await shortenIdleSession(h.options);
  h.state.read.last_used_at = "2026-10-12T10:00:01Z";
  await assert.rejects(fixture.read());
});
test("database failure redacts query and credential material", async () => {
  const h = harness();
  const original = h.options.docker;
  h.options.docker = async (args) => {
    if (args[0] === "exec") throw new Error(args.at(-1));
    return original(args);
  };
  await assert.rejects(shortenIdleSession(h.options), (error) => {
    assert(!error.message.includes("token_hash"));
    assert(!error.message.includes("user-1"));
    assert(!error.cause);
    return true;
  });
});

test("expired-session sampling obeys the outage deadline and does not publish a late row", async () => {
  const h = harness();
  const original = h.options.docker;
  const abort = new AbortController();
  let sampling = false;
  let active = 0;
  h.options.docker = async (args, long, options) => {
    if (sampling && args[0] === "exec") {
      active++;
      try {
        abort.abort(new Error("expiry window timed out"));
        await delay(30, undefined, { signal: options?.signal });
      } finally {
        active--;
      }
    }
    return original(args);
  };
  const fixture = await shortenIdleSession(h.options);
  sampling = true;
  await assert.rejects(
    fixture.read("expired", { signal: abort.signal, timeoutMS: 500 }),
    /timed out|aborted/u,
  );
  assert.equal(active, 0);
  assert.deepEqual(fixture.evidence.observations, []);
});

test("expiry read bounds the actual PostgreSQL statement as well as its Docker attachment", async () => {
  const h = harness();
  const fixture = await shortenIdleSession(h.options);
  const before = h.calls.length;
  await fixture.read("expired", { timeoutMS: 500 });
  const sql = h.calls.slice(before).find((args) => args[0] === "exec");
  const setting = sql.find((value) => value.startsWith("PGOPTIONS="));
  assert.match(setting ?? "", /^PGOPTIONS=-c statement_timeout=\d+$/u);
  const milliseconds = Number(setting.split("=").at(-1));
  assert(milliseconds > 0 && milliseconds <= 500);
});
