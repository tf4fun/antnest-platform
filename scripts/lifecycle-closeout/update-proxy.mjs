import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
const digest = (b) => createHash("sha256").update(b).digest("hex");
const json = (res, status, value) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
};
const id = (x) => typeof x === "string" && /^[a-zA-Z0-9_-]{1,256}$/.test(x);
async function bytes(stream, limit) {
  let n = 0;
  const parts = [];
  for await (const b of stream) {
    n += b.length;
    assert(n <= limit);
    parts.push(b);
  }
  return Buffer.concat(parts);
}
// Test-only transparent transport: no service implementation or journal mutation.
export function startUpdateProxy(
  upstream,
  port = 8080,
  host = "0.0.0.0",
  { holdMs = 60000 } = {},
) {
  const origin = new URL(upstream);
  let selection,
    armed = false,
    held;
  const records = [];
  return createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/status")
        return json(res, 200, { status: "ok" });
      if (req.method === "GET" && req.url === "/__test/status")
        return json(res, 200, {
          selection,
          armed,
          held: held ?? null,
          records,
        });
      if (req.url === "/__test/arm" && req.method === "POST") {
        if (armed || held) return json(res, 409, { code: "fault_pending" });
        const input = JSON.parse(await bytes(req, 4096));
        if (!id(input.agent_id))
          return json(res, 400, { code: "invalid_selection" });
        selection = input.agent_id;
        armed = true;
        records.length = 0;
        return json(res, 200, { armed: true });
      }
      if (req.url.startsWith("/__test/"))
        return json(res, 404, { code: "not_found" });
      const selected =
        req.method === "POST" &&
        req.url === `/internal/runtimes/${selection}/update`;
      const body =
        req.method === "POST" ? await bytes(req, 16 * 1024 * 1024) : undefined;
      const outgoing = request(
        new URL(req.url, origin),
        { method: req.method, headers: { ...req.headers, host: origin.host } },
        async (response) => {
          try {
            if (!selected) {
              res.writeHead(response.statusCode, response.headers);
              response.pipe(res);
              return;
            }
            const raw = await bytes(response, 1024 * 1024);
            let output;
            try {
              output = JSON.parse(raw);
            } catch {
              /* Invalid response is forwarded unchanged. */
            }
            let record;
            if (
              response.statusCode === 200 &&
              output?.kind === "update_runtime" &&
              output.state === "completed" &&
              output.effect === "completed" &&
              output.agent_id === selection &&
              id(output.target_revision) &&
              id(output.request_id) &&
              output.request_id === req.headers["idempotency-key"]
            ) {
              assert(records.length < 32);
              record = {
                agent_id: selection,
                request_id: output.request_id,
                target_revision: output.target_revision,
                status: 200,
                request_hash: digest(body),
                response_hash: digest(raw),
                traceparent: req.headers.traceparent,
                delivery: "pending",
              };
              records.push(record);
            }
            if (record && armed && !res.destroyed) {
              armed = false;
              record.delivery = "held";
              held = record;
              const timer = setTimeout(() => {
                record.delivery = "expired";
                res.destroy();
              }, holdMs);
              res.once("close", () => {
                clearTimeout(timer);
                if (record.delivery === "held")
                  record.delivery = "caller_disconnected";
                if (held === record) held = undefined;
              });
              return;
            }
            res.writeHead(response.statusCode, response.headers);
            res.end(raw, () => {
              if (record) record.delivery = "delivered";
            });
          } catch {
            res.destroy();
          }
        },
      );
      outgoing.on("error", () => {
        if (!res.destroyed && !res.headersSent)
          json(res, 502, { code: "fixture_proxy_failure" });
        else res.destroy();
      });
      res.once("close", () => {
        if (!res.writableEnded) outgoing.destroy();
      });
      if (body) outgoing.end(body);
      else req.pipe(outgoing);
    } catch {
      if (!res.destroyed && !res.headersSent)
        json(res, 502, { code: "fixture_proxy_failure" });
      else res.destroy();
    }
  }).listen(port, host);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  startUpdateProxy("http://runtime-controller:8080");
