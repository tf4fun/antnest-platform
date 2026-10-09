import assert from "node:assert/strict";
import test from "node:test";
import { createServer, request } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCrashProxy } from "./crash-proxy.mjs";

for (const phase of ["before-create", "after-start"])
  for (const ending of ["disconnect", "expiry"])
    test(`Docker crash gate ${phase}/${ending}: exact scope, real effect and one-shot retry`, async (t) => {
      const dir = await mkdtemp(join(tmpdir(), "acrash-"));
      const calls = [];
      const upstream = createServer(async (req, res) => {
        let body = "";
        for await (const b of req) body += b;
        calls.push({ path: req.url, body, header: req.headers["x-test"] });
        if (req.url.includes("/create")) {
          res.writeHead(201, { "content-type": "application/json" });
          res.end(JSON.stringify({ Id: "target", Warnings: [] }));
        } else {
          res.writeHead(204);
          res.end();
        }
      }).listen(join(dir, "up.sock"));
      await once(upstream, "listening");
      const proxy = await startCrashProxy({
        upstream: join(dir, "up.sock"),
        socket: join(dir, "proxy.sock"),
        port: 0,
        holdMs: ending === "expiry" ? 500 : 2000,
      });
      const socket = await stat(join(dir, "proxy.sock"));
      assert.equal(socket.gid, process.getgid());
      assert.equal(socket.mode & 0o777, 0o660);
      t.after(async () => {
        await proxy.close();
        upstream.closeAllConnections();
        await new Promise((r) => upstream.close(r));
        await rm(dir, { recursive: true, force: true });
      });
      const base = `http://127.0.0.1:${proxy.control.address().port}`;
      const control = async (path, body) =>
        fetch(base + path, {
          method: body ? "POST" : "GET",
          body: body && JSON.stringify(body),
          signal: AbortSignal.timeout(3000),
        });
      const state = async () => (await control("/status")).json();
      const send = (path, body, callback) => {
        const req = request(
          {
            socketPath: join(dir, "proxy.sock"),
            path,
            method: "POST",
            headers: { "x-test": "unchanged" },
          },
          callback,
        );
        req.end(body && JSON.stringify(body));
        return req;
      };
      const post = (path, body) =>
        new Promise((resolve, reject) => {
          send(path, body, (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode));
          }).on("error", reject);
        });
      const selection = {
        agent_id: "agent",
        scope: "antnest-lifecycle-1234abcd",
        source_id: "source",
        phase,
      };
      assert.equal(
        (await control("/arm", { ...selection, scope: "retained" })).status,
        400,
      );
      assert.equal((await control("/arm", selection)).status, 200);
      const body = {
        Labels: {
          "io.antnest.agent-id": "agent",
          "io.antnest.runtime-controller-scope": selection.scope,
        },
        Env: ["SECRET=never-record-this"],
      };
      const create = "/v1.47/containers/create?name=antnest-runtime-agent";
      await post(create, {
        ...body,
        Labels: {
          ...body.Labels,
          "io.antnest.runtime-controller-scope": "foreign",
        },
      });
      assert.equal((await state()).held, null);
      if (phase === "after-start") assert.equal(await post(create, body), 201);
      let delivered = false;
      const pending = send(
        phase === "before-create" ? create : "/v1.47/containers/target/start",
        phase === "before-create" ? body : undefined,
        () => {
          delivered = true;
        },
      );
      const ended = new Promise((r) => pending.on("error", r));
      for (let i = 0; i < 100 && !(await state()).held; i++)
        await new Promise((r) => setTimeout(r, 5));
      assert.equal((await state()).held.phase, phase);
      assert.equal(delivered, false);
      assert.equal((await control("/arm", selection)).status, 409);
      assert(!JSON.stringify(await state()).includes("never-record-this"));
      assert.equal(calls.length, phase === "before-create" ? 1 : 3);
      if (ending === "disconnect") pending.destroy();
      await ended;
      for (let i = 0; i < 100 && (await state()).held; i++)
        await new Promise((r) => setTimeout(r, 5));
      assert.equal(
        (await state()).records.at(-1).delivery,
        ending === "disconnect" ? "caller_disconnected" : "expired",
      );
      assert.equal(await post(create, body), 201);
      assert.equal((await state()).held, null);
      assert(calls.every((c) => c.header === "unchanged"));
      assert.equal(calls.at(-1).body, JSON.stringify(body));
    });
