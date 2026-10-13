import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPasswordRejection,
  assertWaitChain,
  assertIdentityPeers,
  assertFifthCommit,
} from "./password-verification-evidence.mjs";

function rejected(code = "credential_busy") {
  return {
    status: code === "credential_busy" ? 503 : 429,
    body: {
      code,
      message:
        code === "credential_busy"
          ? "Password verification is busy"
          : "Too many password attempts",
      retryable: true,
    },
    headers: new Headers({ "cache-control": "no-store", "retry-after": "1" }),
  };
}

test("real password rejection admits the closed public error and one retry hint", () => {
  for (const code of ["credential_busy", "credential_rate_limited"])
    assertPasswordRejection(rejected(code), code);
});

test("a fifth commit changes only its two pre-existing buckets", () => {
  const before = [
    {
      scope: "organization",
      key: "a",
      failures: 4,
      window_start: "window",
      locked_until: null,
    },
    {
      scope: "password_change_user",
      key: "b",
      failures: 4,
      window_start: "window",
      locked_until: null,
    },
    {
      scope: "organization",
      key: "c",
      failures: 0,
      window_start: "other",
      locked_until: null,
    },
  ];
  const after = structuredClone(before);
  after[0].failures = after[1].failures = 5;
  after[1].locked_until = new Date("2026-10-13T00:00:01Z");
  assertFifthCommit(before, after, before.slice(0, 2));
  for (const change of [
    (rows) => {
      rows[2].failures++;
    },
    (rows) => {
      rows.push({ ...rows[2], key: "new" });
    },
    (rows) => {
      rows[0].window_start = "reset";
    },
    (rows) => {
      rows[1].locked_until = null;
    },
    (rows) => {
      rows[1].failures = 6;
    },
  ]) {
    const rows = structuredClone(after);
    change(rows);
    assert.throws(() => assertFifthCommit(before, rows, before.slice(0, 2)));
  }
});

for (const [name, change] of [
  [
    "edge prefilter",
    (r) => {
      r.body.code = "login_rate_limited";
    },
  ],
  [
    "duplicate retry hint",
    (r) => {
      r.headers.append("retry-after", "1");
    },
  ],
  [
    "Cookie mutation",
    (r) => {
      r.headers.append("set-cookie", "session=changed");
    },
  ],
  [
    "credential in error",
    (r) => {
      r.body.access_token = "secret";
    },
  ],
  [
    "cacheable failure",
    (r) => {
      r.headers.set("cache-control", "public");
    },
  ],
  [
    "wrong status",
    (r) => {
      r.status = 200;
    },
  ],
])
  test(`password admission rejects ${name} evidence`, () => {
    const r = rejected();
    change(r);
    assert.throws(() => assertPasswordRejection(r, "credential_busy"));
  });

const chain = () => ({
  blocker: 10,
  first: {
    pid: 11,
    application_name: "issue60-a",
    wait_event_type: "Lock",
    state: "active",
    query: "SELECT active FROM users WHERE id=$1 FOR SHARE",
    blockers: [10],
  },
  second: {
    pid: 12,
    application_name: "issue60-b",
    wait_event_type: "Lock",
    state: "active",
    query: "INSERT INTO credential_attempts (scope, key_hash) VALUES ($1,$2)",
    blockers: [11],
  },
});
const order = {
  firstApp: "issue60-a",
  secondApp: "issue60-b",
  firstMarker: "FROM users",
  secondMarker: "INSERT INTO credential_attempts",
};

test("fifth/sixth ordering requires PostgreSQL's actual two-edge blocking graph", () => {
  assertWaitChain(chain(), order);
  for (const change of [
    (c) => {
      c.second.blockers = [10];
    },
    (c) => {
      c.first.blockers = [];
    },
    (c) => {
      c.second.application_name = "issue60-a";
    },
    (c) => {
      c.second.wait_event_type = "Client";
    },
    (c) => {
      c.second.query = "SELECT 1";
    },
  ]) {
    const c = chain();
    change(c);
    assert.throws(() => assertWaitChain(c, order));
  }
});

const peer = (n) => ({
  id: String(n).repeat(64),
  pid: n,
  started_at: "2026-10-13T00:00:00.000Z",
  image: "sha256:" + "a".repeat(64),
  database: "b".repeat(64),
  running: true,
  restarts: 0,
});
test("dual Identity evidence requires different live processes with the same image and database", () => {
  assertIdentityPeers(peer(1), peer(2));
  assert.throws(() => assertIdentityPeers(peer(1), peer(1)));
  for (const change of [
    (p) => {
      p.image = "sha256:" + "c".repeat(64);
    },
    (p) => {
      p.database = "d".repeat(64);
    },
    (p) => {
      p.running = false;
    },
    (p) => {
      p.restarts = 1;
    },
  ]) {
    const p = peer(2);
    change(p);
    assert.throws(() => assertIdentityPeers(peer(1), p));
  }
});
