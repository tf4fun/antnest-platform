import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { Frames, Tracker, successfulResult } from "./wire.mjs";
const id = (x) => typeof x === "string" && x.length > 0 && x.length <= 128;
export async function startProxy({
  upstreamHost = "postgres",
  upstreamPort = 5432,
  host = "0.0.0.0",
  dbPort = 5432,
  httpPort = 8080,
  holdMs = 30000,
} = {}) {
  let selection,
    armed = false,
    held;
  const records = [],
    sockets = new Set(),
    errors = [];
  const tcp = net.createServer((down) => {
    const up = net.createConnection({ host: upstreamHost, port: upstreamPort });
    sockets.add(down);
    sockets.add(up);
    const front = new Frames({ startup: true }),
      back = new Frames(),
      tracker = new Tracker(() => selection);
    let pending,
      buffered = [],
      size = 0,
      blocked = false;
    const clear = () => {
      if (held?.down === down) {
        clearTimeout(held.timer);
        if (held.record.delivery === "held")
          held.record.delivery = "lost_before_drop";
        held = undefined;
      }
      down.destroy();
      up.destroy();
      sockets.delete(down);
      sockets.delete(up);
    };
    down.on("error", clear);
    up.on("error", clear);
    down.on("close", clear);
    up.on("close", clear);
    const forward = (source, destination, data) => {
      if (!destination.write(data)) {
        source.pause();
        destination.once("drain", () => {
          if (!blocked) source.resume();
        });
      }
    };
    down.on("data", (chunk) => {
      try {
        for (const frame of front.push(chunk)) {
          const candidate = tracker.observe(frame);
          if (candidate) {
            assert(!pending && !blocked);
            pending = candidate;
            buffered = [];
            size = 0;
          }
          forward(down, up, frame.data);
        }
      } catch {
        if (errors.length < 32) errors.push("invalid_frontend_protocol");
        clear();
      }
    });
    up.on("data", (chunk) => {
      try {
        for (const frame of back.push(chunk)) {
          if (blocked) throw Error("unexpected traffic after held result");
          if (!pending) {
            forward(up, down, frame.data);
            continue;
          }
          buffered.push(frame);
          size += frame.data.length;
          assert(size <= 1024 * 1024);
          if (frame.type !== "Z") continue;
          const response = Buffer.concat(buffered.map((f) => f.data)),
            candidate = pending;
          pending = undefined;
          if (!successfulResult(buffered, candidate)) {
            forward(up, down, response);
            buffered = [];
            continue;
          }
          assert(records.length < 64);
          const record = {
            receipt_id: randomUUID(),
            phase: candidate.phase,
            session_id: candidate.session_id,
            run_id: candidate.run_id,
            query_hash: candidate.query_hash,
            command_tag: candidate.command_tag,
            delivery: "pending",
          };
          records.push(record);
          if (armed) {
            assert(!held);
            selection = { ...selection, run_id: record.run_id };
            armed = false;
            blocked = true;
            up.pause();
            record.delivery = "held";
            const timer = setTimeout(() => {
              record.delivery = "expired";
              clear();
            }, holdMs);
            held = { record, down, timer, clear };
          } else {
            record.delivery = "delivered";
            forward(up, down, response);
          }
          buffered = [];
        }
      } catch {
        if (errors.length < 32) errors.push("invalid_backend_protocol");
        clear();
      }
    });
  });
  const send = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const control = http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/status")
        return send(res, 200, {
          selection,
          armed,
          held: held?.record ?? null,
          records,
          errors,
          connections: sockets.size / 2,
        });
      if (req.method !== "POST")
        return send(res, 405, { code: "method_not_allowed" });
      const chunks = [];
      let size = 0;
      for await (const c of req) {
        size += c.length;
        assert(size <= 4096);
        chunks.push(c);
      }
      const input = JSON.parse(Buffer.concat(chunks));
      if (req.url === "/arm") {
        if (armed || held) return send(res, 409, { code: "fault_pending" });
        if (
          !["intent", "accept", "finish"].includes(input.phase) ||
          !id(input.session_id) ||
          (input.phase === "finish" && !id(input.run_id))
        )
          return send(res, 400, { code: "invalid_scope" });
        selection = {
          phase: input.phase,
          session_id: input.session_id,
          ...(input.phase === "finish" ? { run_id: input.run_id } : {}),
        };
        records.length = 0;
        armed = true;
        return send(res, 200, { armed: true });
      }
      if (req.url === "/drop") {
        if (!held || held.record.receipt_id !== input.receipt_id)
          return send(res, 409, { code: "no_matching_commit" });
        held.record.delivery = "dropped";
        held.clear();
        return send(res, 200, { dropped: true });
      }
      return send(res, 404, { code: "not_found" });
    } catch {
      if (!res.headersSent) send(res, 400, { code: "invalid_control_request" });
      else res.destroy();
    }
  });
  tcp.listen(dbPort, host);
  await once(tcp, "listening");
  control.listen(httpPort, host);
  await once(control, "listening");
  return {
    tcp,
    http: control,
    close: async () => {
      if (held) {
        clearTimeout(held.timer);
        held.clear();
      }
      for (const socket of sockets) socket.destroy();
      control.closeAllConnections();
      await new Promise((r) => tcp.close(r));
      await new Promise((r) => control.close(r));
    },
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await startProxy();
