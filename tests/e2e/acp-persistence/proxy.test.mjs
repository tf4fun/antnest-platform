import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { startProxy } from "./proxy.mjs";
const { Client } = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
)("pg");
const url = process.env.TEST_POSTGRES_URL;
async function fixture(t, { holdMs = 3000 } = {}) {
  const address = new URL(url),
    admin = new Client({ connectionString: url });
  await admin.connect();
  await admin.query("DROP TABLE IF EXISTS runs, acp_sessions");
  await admin.query(
    "CREATE TABLE runs(id text PRIMARY KEY,request_id text,session_id text,state text,execution_snapshot jsonb); CREATE TABLE acp_sessions(id text,state text)",
  );
  await admin.query(
    "INSERT INTO acp_sessions VALUES ('session','active'),('foreign','active')",
  );
  const proxy = await startProxy({
    upstreamHost: address.hostname,
    upstreamPort: Number(address.port),
    host: "127.0.0.1",
    dbPort: 0,
    httpPort: 0,
    holdMs,
  });
  const proxied = new URL(url);
  proxied.port = String(proxy.tcp.address().port);
  const client = new Client({ connectionString: proxied.href });
  client.on("error", () => {});
  t.after(async () => {
    await client.end();
    await proxy.close();
    await admin.end();
  });
  await client.connect();
  const api = async (path = "/status", body, status = 200) => {
    const r = await fetch(
      `http://127.0.0.1:${proxy.http.address().port}` + path,
      {
        method: body ? "POST" : "GET",
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(3000),
      },
    );
    assert.equal(r.status, status);
    return r.json();
  };
  const held = async () => {
    for (let n = 0; n < 100; n++) {
      const value = (await api()).held;
      if (value) return value;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw Error("no held commit");
  };
  const intent = async (session = "session") => {
    await client.query("BEGIN");
    await client.query(
      "SELECT state FROM acp_sessions WHERE id=$1 FOR UPDATE",
      [session],
    );
    await client.query(
      "INSERT INTO runs(id,request_id,session_id,state) VALUES ($1,$2,$3,'admitting') RETURNING id",
      ["run", "request", session],
    );
  };
  return { admin, client, proxy, api, held, intent };
}
for (const phase of ["intent", "accept", "finish"])
  test(
    `real PostgreSQL ${phase} success is withheld after durable write, then lost`,
    { skip: !url },
    async (t) => {
      const f = await fixture(t);
      await f.api("/arm", {
        phase,
        session_id: "session",
        ...(phase === "finish" ? { run_id: "run" } : {}),
      });
      if (phase === "intent") await f.intent();
      else {
        await f.admin.query(
          "INSERT INTO runs VALUES ('run','request','session','admitting',null)",
        );
        if (phase === "accept") {
          await f.client.query("BEGIN");
          await f.client.query(
            "SELECT state FROM acp_sessions WHERE id=$1 FOR UPDATE",
            ["session"],
          );
          await f.client.query(
            "UPDATE runs SET state = 'running', execution_snapshot = $2::jsonb WHERE id=$1",
            ["run", JSON.stringify({ secret: "PRIVATE_SNAPSHOT" })],
          );
        }
      }
      let done = false;
      const pending = (
        phase === "finish"
          ? f.client.query(
              "WITH finished AS (UPDATE runs SET state=$2 WHERE id=$1 RETURNING id) SELECT id FROM finished",
              ["run", "completed"],
            )
          : f.client.query("COMMIT")
      ).then(
        () => {
          done = true;
          return "success";
        },
        () => {
          done = true;
          return "lost";
        },
      );
      const held = await f.held();
      assert.equal(done, false);
      assert.equal(held.phase, phase);
      assert.equal(held.run_id, "run");
      assert.equal(
        held.command_tag,
        phase === "finish" ? "SELECT 1" : "COMMIT",
      );
      assert.equal(held.delivery, "held");
      assert.equal(
        (await f.admin.query("SELECT state FROM runs WHERE id=$1", ["run"]))
          .rows[0].state,
        { intent: "admitting", accept: "running", finish: "completed" }[phase],
      );
      assert(!JSON.stringify(await f.api()).includes("PRIVATE_SNAPSHOT"));
      await f.api("/drop", { receipt_id: "wrong" }, 409);
      await f.api("/drop", { receipt_id: held.receipt_id });
      assert.equal(await pending, "lost");
      assert.equal((await f.api()).records[0].delivery, "dropped");
    },
  );
test(
  "rollback and foreign transactions cannot produce a committed-loss receipt",
  { skip: !url },
  async (t) => {
    const f = await fixture(t);
    await f.api("/arm", { phase: "intent", session_id: "session" });
    await f.intent("foreign");
    await f.client.query("COMMIT");
    assert.deepEqual((await f.api()).records, []);
    await f.admin.query("DELETE FROM runs");
    await f.intent();
    await assert.rejects(f.client.query("SELECT 1/0"));
    assert.equal((await f.client.query("COMMIT")).command, "ROLLBACK");
    assert.deepEqual((await f.api()).records, []);
    assert.equal((await f.admin.query("SELECT * FROM runs")).rowCount, 0);
  },
);
test(
  "hold expiry is distinct from an explicitly requested loss",
  { skip: !url },
  async (t) => {
    const f = await fixture(t, { holdMs: 100 });
    await f.api("/arm", { phase: "intent", session_id: "session" });
    await f.intent();
    const pending = f.client.query("COMMIT").then(
      () => false,
      () => true,
    );
    const held = await f.held();
    assert.equal(await pending, true);
    assert.equal((await f.api()).records[0].delivery, "expired");
    await f.api("/drop", { receipt_id: held.receipt_id }, 409);
  },
);
