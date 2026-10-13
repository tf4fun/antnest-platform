import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPasswordRejection,
  assertWaitChain,
  assertIdentityPeers,
  assertFifthCommit,
  passwordResponseObservation,
  assertPasswordHolderWindow,
  assertHolderFailureCommit,
} from "./password-verification-evidence.mjs";
import { recoveryHTTPFixture } from "./resolve-cache-recovery-http-fixtures.mjs";
import { setTag } from "../observability/gateway-resolution-fixtures.mjs";

function holderAttempts() {
  const before = [
    {
      scope: "organization",
      key: "holder-org",
      failures: 0,
      window_start: new Date("2026-10-13T01:29:32.218Z"),
      locked_until: null,
    },
    {
      scope: "login_account",
      key: "holder-account",
      failures: 0,
      window_start: new Date("2026-10-13T01:29:32.218Z"),
      locked_until: null,
    },
    {
      scope: "organization",
      key: "protected",
      failures: 3,
      window_start: new Date("2026-10-13T01:28:00Z"),
      locked_until: null,
    },
  ];
  const after = structuredClone(before);
  for (const row of after.slice(0, 2)) {
    row.failures = 1;
    row.window_start = new Date("2026-10-13T01:29:42.160Z");
  }
  return {
    before,
    after,
    keys: new Set(before.slice(0, 2).map((r) => r.scope + ":" + r.key)),
    bounds: {
      started_at: new Date("2026-10-13T01:29:35Z"),
      completed_at: new Date("2026-10-13T01:29:43Z"),
    },
  };
}

test("one holder failure starts both windows inside database time bounds and preserves all other buckets", () => {
  const f = holderAttempts();
  const raw = JSON.stringify(f);
  const receipt = assertHolderFailureCommit(
    f.before,
    f.after,
    f.keys,
    f.bounds,
  );
  assert.equal(receipt.holder_buckets, 2);
  assert.equal(receipt.protected_buckets, 1);
  assert.equal(receipt.window_start, "2026-10-13T01:29:42.160Z");
  assert.equal(JSON.stringify(f), raw);
});

for (const [name, mutate] of [
  [
    "missing holder",
    (f) =>
      (f.keys = new Set([
        "organization:absent",
        "login_account:holder-account",
      ])),
  ],
  [
    "duplicate prior bucket",
    (f) => (f.before[2] = structuredClone(f.before[0])),
  ],
  [
    "duplicate resulting bucket",
    (f) => (f.after[2] = structuredClone(f.after[0])),
  ],
  ["additional bucket", (f) => f.after.push({ ...f.after[2], key: "new" })],
  ["changed protected bucket", (f) => f.after[2].failures++],
  ["wrong failure count", (f) => (f.after[0].failures = 2)],
  ["nonzero initial holder", (f) => (f.before[0].failures = 1)],
  [
    "unexpected lock",
    (f) => (f.after[0].locked_until = new Date(f.bounds.completed_at)),
  ],
  [
    "preserved old window",
    (f) => (f.after[0].window_start = f.before[0].window_start),
  ],
  [
    "window after completion",
    (f) => (f.after[0].window_start = new Date("2026-10-13T01:29:44Z")),
  ],
  [
    "different holder windows",
    (f) => (f.after[1].window_start = new Date("2026-10-13T01:29:42.161Z")),
  ],
  ["invalid database time", (f) => (f.bounds.started_at = new Date("invalid"))],
  [
    "reversed database interval",
    (f) => (f.bounds.started_at = new Date("2026-10-13T01:29:44Z")),
  ],
  [
    "prior window after admission",
    (f) => (f.before[0].window_start = f.bounds.completed_at),
  ],
])
  test(`holder failure evidence rejects ${name}`, () => {
    const f = holderAttempts();
    mutate(f);
    assert.throws(() =>
      assertHolderFailureCommit(f.before, f.after, f.keys, f.bounds),
    );
  });

function heldWindow() {
  const part = recoveryHTTPFixture().parts.find((p) => p.rejection === "login");
  const holder = part.trace;
  holder.spans = holder.spans.filter((s) => s.processID === "identity");
  part.server.references = [];
  holder.processes.identity.tags = [
    { key: "service.instance.id", value: "same-instance" },
  ];
  const start = part.database.startTime + part.database.duration + 1;
  const busy = (method, id) => {
    const span = structuredClone(part.server);
    span.traceID = id;
    span.startTime = start;
    span.duration = 10;
    span.logs = [];
    setTag(span, "http.route", `/rpc/identity/${method}`);
    setTag(span, "http.response.status_code", 503);
    setTag(span, "antnest.error.code", "credential_busy");
    return {
      traceID: id,
      processes: structuredClone(holder.processes),
      spans: [span],
    };
  };
  return {
    holder,
    probe: busy("local-login", "d".repeat(32)),
    targets: ["local-login", "change-local-password", "create-local-user"].map(
      (method, n) => ({
        method,
        trace: busy(method, String(n + 1).repeat(32)),
      }),
    ),
    part,
  };
}

test("full-budget holder remains inside Verify until every same-process target response finishes", () => {
  const f = heldWindow();
  const raw = JSON.stringify(f);
  const result = assertPasswordHolderWindow(f);
  assert.equal(result.targets.length, 3);
  assert.equal(result.same_process, true);
  assert.equal(JSON.stringify(f), raw);
});

for (const [name, mutate] of [
  [
    "holder released before a target ended",
    (f) => {
      f.targets[2].trace.spans[0].duration = 1000;
    },
  ],
  [
    "target before credential read",
    (f) => {
      f.targets[0].trace.spans[0].startTime = f.part.database.startTime;
    },
  ],
  [
    "different Identity instance",
    (f) => {
      f.targets[0].trace.processes.identity.tags[0].value = "other";
    },
  ],
  [
    "successful target",
    (f) =>
      setTag(f.targets[1].trace.spans[0], "http.response.status_code", 200),
  ],
  [
    "missing holder COMMIT",
    (f) => {
      f.holder.spans = f.holder.spans.filter((s) => s !== f.part.commit);
    },
  ],
  [
    "probe after Verify",
    (f) => {
      f.probe.spans[0].duration = 1000;
    },
  ],
]) {
  test(`holder evidence rejects ${name}`, () => {
    const f = heldWindow();
    mutate(f);
    assert.throws(() => assertPasswordHolderWindow(f));
  });
}

test("public password diagnostics retain actual status before admission assertions", () => {
  const response = rejected();
  response.status = 200;
  response.headers.set("x-antnest-trace-id", "a".repeat(32));
  const row = passwordResponseObservation("/api/session/password", response);
  assert.deepEqual(row, {
    route: "/api/session/password",
    status: 200,
    trace_id: "a".repeat(32),
    code: "credential_busy",
    retry_after: "1",
    cookie_writes: 0,
    rejection_valid: false,
    cookies_preserved: false,
    database_preserved: false,
    old_session_live: false,
  });
});

test("password response diagnostics never copy unknown body or header values", () => {
  const secret = "private-response-canary";
  const row = passwordResponseObservation("/api/admin/directory/users", {
    status: 503,
    body: {
      code: secret,
      message: secret,
      access_token: secret,
      extra: secret,
    },
    headers: new Headers({
      "x-antnest-trace-id": secret,
      "retry-after": secret,
      "set-cookie": `session=${secret}`,
    }),
  });
  assert.equal(row.code, "unrecognized");
  assert.equal(row.trace_id, null);
  assert.equal(row.retry_after, null);
  assert.equal(row.cookie_writes, 1);
  assert(!JSON.stringify(row).includes(secret));
  assert.throws(() => passwordResponseObservation(secret, rejected()));
});

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
