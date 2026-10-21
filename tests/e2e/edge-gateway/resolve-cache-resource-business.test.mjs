import assert from "node:assert/strict";
import test from "node:test";
import { outageResourcesFixture } from "./resolve-cache-resource-fixtures.mjs";

const url = new URL("./resolve-cache-resource-business.mjs", import.meta.url);
const { inspectOutageBusinessResources: inspect } = await import(url).catch(
  (error) => {
    if (error.code !== "ERR_MODULE_NOT_FOUND" || error.url !== url.href)
      throw error;
    return {};
  },
);
const api = () => assert.equal(typeof inspect, "function");

test("raw outage resource admission preserves evidence without any Trace collection", () => {
  api();
  const e = outageResourcesFixture(),
    original = structuredClone(e);
  assert.deepEqual(inspect(e), {
    status: "passed",
    public_streams: 5,
    consumer_processes: 2,
    ui_stopped: true,
  });
  assert.deepEqual(e, original);
});

for (const [name, mutate] of [
  [
    "UI restart replaced container",
    (e) => (e.consumer_restarts[1].after.id = "other"),
  ],
  [
    "UI drain replaced process",
    (e) => (e.ui_drain.before.started_at = "2026-10-14T00:00:01Z"),
  ],
  ["wrong drain project", (e) => (e.ui_drain.after.project = "other")],
  ["nonzero UI exit", (e) => (e.ui_drain.after.exit_code = 1)],
  ["UI OOM", (e) => (e.ui_drain.after.oom_killed = true)],
  ["unchecked UI stop log", (e) => delete e.ui_drain.log_checked],
  ["forced UI drain with exit zero", (e) => (e.ui_drain.forced_drain = true)],
  ["missing UI stop log digest", (e) => delete e.ui_drain.log_sha256],
  ["malformed UI stop log digest", (e) => (e.ui_drain.log_sha256 = "bad")],
  [
    "unproved consumer restart",
    (e) =>
      (e.consumer_restarts[0].after.started_at =
        e.consumer_restarts[0].before.started_at),
  ],
  [
    "drain before observer join",
    (e) => (e.recovery.cases[3].stream.joined.at = e.ui_drain.started_at + 1),
  ],
  ["missing stream join", (e) => delete e.stream.joined],
  ["local warm stream close", (e) => (e.stream.closure.kind = "local-close")],
  [
    "warm close after deadline",
    (e) => (e.stream.closure.at = e.recovery.cases[1].trigger.at + 30001),
  ],
  [
    "warm close before password",
    (e) => (e.stream.closure.at = e.recovery.cases[1].trigger.at - 1),
  ],
  [
    "password changed other member",
    (e) => (e.recovery.cases[1].login.body.principal.user_id = "foreign"),
  ],
  ["foreign warm credential", (e) => (e.stream.credential_scope = "other")],
  ["missing original HTTP", (e) => e.http.splice(e.http.indexOf(e.prompt), 1)],
  ["duplicate original HTTP", (e) => e.http.push(structuredClone(e.audit))],
  [
    "altered original HTTP",
    (e) =>
      (e.http[e.http.indexOf(e.cancel)] = {
        ...e.cancel,
        body: { changed: true },
      }),
  ],
  [
    "missing preparation view",
    (e) => (e.http = e.http.filter((r) => r.label !== "prep-view")),
  ],
  [
    "warm console uses other credential",
    (e) =>
      (e.http.find((r) => r.label === "warm-console-audit").credential_scope =
        "warm"),
  ],
  [
    "wrong 401 body",
    (e) => (e.recovery.cases[0].old_session.body.code = "internal_error"),
  ],
  [
    "restore uses other administrator",
    (e) => (e.recovery.cases[3].restore.credential_scope = "other"),
  ],
  [
    "restore changes user",
    (e) => (e.recovery.cases[3].restore.body.membership.user_id = "other"),
  ],
  [
    "restore has wrong role",
    (e) => (e.recovery.cases[3].restore.body.membership.role = "member"),
  ],
  [
    "recovery has foreign Agent",
    (e) => (e.recovery.cases[0].agent_id = "other"),
  ],
  [
    "recovery has foreign owner",
    (e) => (e.recovery.cases[0].owner_id = "other"),
  ],
  ["Runtime generation missing", (e) => delete e.runtime.container.generation],
  [
    "Runtime generation changed",
    (e) => (e.runtime.quiescent.status.generation = 2),
  ],
  [
    "Runtime status foreign Agent",
    (e) => (e.runtime.started.status.agent_id = "other"),
  ],
  [
    "Identity healthy from foreign container",
    (e) => (e.identity.healthy.id = "other"),
  ],
  [
    "Identity healthy from old process",
    (e) => (e.identity.healthy.started_at = e.identity.before.started_at),
  ],
  ["Identity healthy before restart", (e) => (e.identity.healthy.at = 6000)],
  ["original business failed", (e) => (e.failure = { message: "failed" })],
  ["final cleanup failed", (e) => (e.finalization_errors = ["failed"])],
  [
    "recovery cleanup failed",
    (e) => (e.recovery.cases[0].cleanup_errors = ["failed"]),
  ],
  [
    "view foreign Agent",
    (e) =>
      (e.http.find((r) => r.label === "prep-view").body.agentId = "foreign"),
  ],
  [
    "view foreign Session",
    (e) =>
      (e.http.find((r) => r.label === "warm-workspace-view").body.sessionId =
        "foreign"),
  ],
  [
    "view missing epoch",
    (e) => delete e.http.find((r) => r.label === "prep-view").body.bridgeEpoch,
  ],
  [
    "view epoch survives restart",
    (e) =>
      (e.http.find((r) => r.label === "prep-view").body.bridgeEpoch =
        "after-restart"),
  ],
  [
    "view epoch changes within process",
    (e) =>
      (e.http.find((r) => r.label === "warm-workspace-view").body.bridgeEpoch =
        "another-process"),
  ],
])
  test(`raw outage resource admission rejects ${name}`, () => {
    api();
    const e = outageResourcesFixture();
    inspect(e);
    mutate(e);
    assert.throws(() => inspect(e));
  });
