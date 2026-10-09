import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { once } from "node:events";
import { chmodSync, chownSync } from "node:fs";
import { pathToFileURL } from "node:url";

const json = (res, status, value) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
};
async function bytes(stream, limit) {
  let size = 0;
  const parts = [];
  for await (const part of stream) {
    size += part.length;
    assert(size <= limit);
    parts.push(part);
  }
  return Buffer.concat(parts);
}
const id = (x) => typeof x === "string" && /^[a-zA-Z0-9_-]{1,256}$/.test(x);

// Disposable test transport. Every delivered response comes from the real daemon.
export async function startCrashProxy({
  upstream = "/var/run/docker.sock",
  socket = "/fault/docker.sock",
  port = 8080,
  holdMs = 60000,
  socketGid = process.env.ANTNEST_DOCKER_SOCKET_GID ?? String(process.getgid()),
} = {}) {
  assert(
    /^(?:0|[1-9][0-9]*)$/u.test(socketGid) && Number(socketGid) <= 4294967294,
    "ANTNEST_DOCKER_SOCKET_GID is invalid",
  );
  let selection,
    armed = false,
    held,
    target;
  const records = [],
    effects = [];
  const record = (list, value) => {
    assert(list.length < 64);
    list.push(value);
    return value;
  };
  const hold = (res, phase) => {
    armed = false;
    held = record(records, {
      phase,
      delivery: "held",
      target_id: target ?? null,
    });
    const entry = held;
    const timer = setTimeout(() => {
      entry.delivery = "expired";
      res.destroy();
    }, holdMs);
    res.once("close", () => {
      clearTimeout(timer);
      if (entry.delivery === "held") entry.delivery = "caller_disconnected";
      if (held === entry) held = undefined;
    });
  };
  const control = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/status")
        return json(res, 200, {
          armed,
          selection,
          held: held ?? null,
          records,
          effects,
        });
      if (req.method !== "POST" || req.url !== "/arm")
        return json(res, 404, {});
      if (armed || held) return json(res, 409, {});
      const body = JSON.parse(await bytes(req, 4096));
      if (
        !id(body.agent_id) ||
        !id(body.source_id) ||
        !/^antnest-lifecycle-[a-f0-9]{8}$/.test(body.scope) ||
        !["before-create", "after-start"].includes(body.phase)
      )
        return json(res, 400, {});
      selection = body;
      armed = true;
      target = undefined;
      records.length = 0;
      effects.length = 0;
      json(res, 200, { armed });
    } catch {
      json(res, 400, {});
    }
  });
  const transport = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://docker");
      const path = url.pathname.replace(/^\/v\d+\.\d+(?=\/)/, "");
      const create = req.method === "POST" && path === "/containers/create";
      const body = create ? await bytes(req, 2 * 1024 * 1024) : undefined;
      const spec = create ? JSON.parse(body) : undefined;
      const selected =
        selection &&
        create &&
        url.searchParams.get("name") ===
          `antnest-runtime-${selection.agent_id}` &&
        spec.Labels?.["io.antnest.agent-id"] === selection.agent_id &&
        spec.Labels?.["io.antnest.runtime-controller-scope"] ===
          selection.scope;
      if (
        selected &&
        armed &&
        selection.phase === "before-create" &&
        !res.destroyed
      )
        return hold(res, "before-create");
      const start =
        selection &&
        target &&
        req.method === "POST" &&
        path === `/containers/${target}/start`;
      const remove =
        selection &&
        req.method === "DELETE" &&
        path === `/containers/${selection.source_id}`;
      const outgoing = request(
        {
          socketPath: upstream,
          path: req.url,
          method: req.method,
          headers: req.headers,
        },
        async (response) => {
          try {
            if (selected) {
              const raw = await bytes(response, 1024 * 1024);
              if (response.statusCode === 201) {
                target = JSON.parse(raw).Id;
                assert(id(target));
                record(effects, {
                  kind: "create",
                  target_id: target,
                  status: 201,
                });
              }
              res.writeHead(response.statusCode, response.headers);
              res.end(raw);
              return;
            }
            if (start && response.statusCode === 204) {
              await bytes(response, 4096);
              record(effects, {
                kind: "start",
                target_id: target,
                status: 204,
              });
              if (armed && selection.phase === "after-start" && !res.destroyed)
                return hold(res, "after-start");
              res.writeHead(response.statusCode, response.headers);
              res.end();
              return;
            }
            if (remove && response.statusCode === 204)
              record(effects, {
                kind: "remove",
                target_id: selection.source_id,
                status: 204,
              });
            res.writeHead(response.statusCode, response.headers);
            response.pipe(res);
          } catch {
            res.destroy();
          }
        },
      );
      outgoing.on("error", () => {
        if (!res.headersSent && !res.destroyed)
          json(res, 502, { code: "fixture_proxy_failure" });
        else res.destroy();
      });
      res.once("close", () => {
        if (!res.writableEnded) outgoing.destroy();
      });
      if (body) outgoing.end(body);
      else req.pipe(outgoing);
    } catch {
      if (!res.headersSent && !res.destroyed)
        json(res, 502, { code: "fixture_proxy_failure" });
      else res.destroy();
    }
  });
  transport.listen(socket);
  await once(transport, "listening");
  chownSync(socket, -1, Number(socketGid));
  chmodSync(socket, 0o660);
  control.listen(port, "127.0.0.1");
  await once(control, "listening");
  return {
    control,
    transport,
    async close() {
      for (const server of [transport, control]) {
        server.closeAllConnections();
        await new Promise((r) => server.close(r));
      }
    },
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const proxy = await startCrashProxy();
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, async () => {
      await proxy.close();
      process.exit(0);
    });
}
