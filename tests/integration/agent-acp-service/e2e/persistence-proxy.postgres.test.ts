import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Client } from "pg";
import { afterEach, beforeEach, describe, it } from "vitest";
import {
  startProxy,
  type FaultReceipt,
  type ProxyStatus,
} from "../support/persistence/proxy.mjs";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;

describe.skipIf(databaseUrl === undefined)(
  "real PostgreSQL fault proxy",
  () => {
    let admin: Client;
    let client: Client | undefined;
    let proxy: Awaited<ReturnType<typeof startProxy>> | undefined;
    let schema: string;
    let created: boolean;
    let requests: Promise<unknown>[];

    beforeEach(async () => {
      client = undefined;
      proxy = undefined;
      created = false;
      requests = [];
      schema = "persistence_proxy_" + randomUUID().replaceAll("-", "");
      admin = new Client({ connectionString: databaseUrl });
      await admin.connect();
      await admin.query(`CREATE SCHEMA "${schema}"`);
      created = true;
      await admin.query(`SET search_path TO "${schema}"`);
      await admin.query(
        "CREATE TABLE runs(id text PRIMARY KEY,request_id text,session_id text,state text,execution_snapshot jsonb); CREATE TABLE acp_sessions(id text,state text)",
      );
      await admin.query(
        "INSERT INTO acp_sessions VALUES ('session','active'),('foreign','active')",
      );
    });

    afterEach(async () => {
      const failures: unknown[] = [];
      for (const close of [
        () => proxy?.close(),
        () => client?.end(),
        () => Promise.allSettled(requests),
        () => created && admin.query(`DROP SCHEMA "${schema}" CASCADE`),
        () => admin.end(),
      ]) {
        try {
          await close();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length)
        throw new AggregateError(failures, "PostgreSQL proxy cleanup failed");
    });

    async function start(holdMs = 3000) {
      const upstream = new URL(databaseUrl!);
      proxy = await startProxy({
        upstreamHost: upstream.hostname,
        upstreamPort: Number(upstream.port),
        host: "127.0.0.1",
        dbPort: 0,
        httpPort: 0,
        holdMs,
      });
      const proxied = new URL(databaseUrl!);
      proxied.hostname = "127.0.0.1";
      proxied.port = String((proxy.tcp.address() as AddressInfo).port);
      client = new Client({ connectionString: proxied.href });
      // An explicitly dropped or expired proxy socket is the injected fault.
      client.on("error", () => {});
      await client.connect();
      await client.query(`SET search_path TO "${schema}"`);
    }

    async function api(
      path = "/status",
      body?: Record<string, unknown>,
      status = 200,
    ): Promise<ProxyStatus> {
      const address = proxy!.http.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
        method: body ? "POST" : "GET",
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(3000),
      });
      assert.equal(response.status, status);
      return response.json() as Promise<ProxyStatus>;
    }

    async function held(): Promise<FaultReceipt> {
      for (let n = 0; n < 100; n++) {
        const value = (await api()).held;
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw Error("no held commit");
    }

    async function intent(session = "session") {
      await client!.query("BEGIN");
      await client!.query(
        "SELECT state FROM acp_sessions WHERE id=$1 FOR UPDATE",
        [session],
      );
      await client!.query(
        "INSERT INTO runs(id,request_id,session_id,state) VALUES ($1,$2,$3,'admitting') RETURNING id",
        ["run", "request", session],
      );
    }

    it.each(["intent", "accept", "finish"] as const)(
      "%s success is withheld after durable write, then lost",
      async (phase) => {
        await start();
        await api("/arm", {
          phase,
          session_id: "session",
          ...(phase === "finish" ? { run_id: "run" } : {}),
        });
        if (phase === "intent") await intent();
        else {
          await admin.query(
            "INSERT INTO runs VALUES ('run','request','session','admitting',null)",
          );
          if (phase === "accept") {
            await client!.query("BEGIN");
            await client!.query(
              "SELECT state FROM acp_sessions WHERE id=$1 FOR UPDATE",
              ["session"],
            );
            await client!.query(
              "UPDATE runs SET state = 'running', execution_snapshot = $2::jsonb WHERE id=$1",
              ["run", JSON.stringify({ secret: "PRIVATE_SNAPSHOT" })],
            );
          }
        }
        let done = false;
        const pending = (
          phase === "finish"
            ? client!.query(
                "WITH finished AS (UPDATE runs SET state=$2 WHERE id=$1 RETURNING id) SELECT id FROM finished",
                ["run", "completed"],
              )
            : client!.query("COMMIT")
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
        requests.push(pending);
        const receipt = await held();
        assert.equal(done, false);
        assert.equal(receipt.phase, phase);
        assert.equal(receipt.run_id, "run");
        assert.equal(
          receipt.command_tag,
          phase === "finish" ? "SELECT 1" : "COMMIT",
        );
        assert.equal(receipt.delivery, "held");
        assert.equal(
          (
            await admin.query<{ state: string }>(
              "SELECT state FROM runs WHERE id=$1",
              ["run"],
            )
          ).rows[0]!.state,
          { intent: "admitting", accept: "running", finish: "completed" }[
            phase
          ],
        );
        assert(!JSON.stringify(await api()).includes("PRIVATE_SNAPSHOT"));
        await api("/drop", { receipt_id: "wrong" }, 409);
        await api("/drop", { receipt_id: receipt.receipt_id });
        assert.equal(await pending, "lost");
        assert.equal((await api()).records[0]!.delivery, "dropped");
      },
    );

    it("rollback and foreign transactions cannot produce a committed-loss receipt", async () => {
      await start();
      await api("/arm", { phase: "intent", session_id: "session" });
      await intent("foreign");
      await client!.query("COMMIT");
      assert.deepEqual((await api()).records, []);
      await admin.query("DELETE FROM runs");
      await intent();
      await assert.rejects(client!.query("SELECT 1/0"));
      assert.equal((await client!.query("COMMIT")).command, "ROLLBACK");
      assert.deepEqual((await api()).records, []);
      assert.equal((await admin.query("SELECT * FROM runs")).rowCount, 0);
    });

    it("hold expiry is distinct from an explicitly requested loss", async () => {
      await start(100);
      await api("/arm", { phase: "intent", session_id: "session" });
      await intent();
      const pending = client!.query("COMMIT").then(
        () => false,
        () => true,
      );
      requests.push(pending);
      const receipt = await held();
      assert.equal(await pending, true);
      assert.equal((await api()).records[0]!.delivery, "expired");
      await api("/drop", { receipt_id: receipt.receipt_id }, 409);
    });
  },
);
