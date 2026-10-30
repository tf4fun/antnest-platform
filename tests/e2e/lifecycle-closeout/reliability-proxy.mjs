import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, request } from "node:http";
import { pathToFileURL } from "node:url";

const digest = (body) => createHash("sha256").update(body).digest("hex");

const json = (response, status, value) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
};

const identifier = (value) =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,256}$/.test(value);

const emptyObject = async (stream) => {
  const raw = await bytes(stream, 4096);
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return false;
  }
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
};

async function bytes(stream, limit) {
  let total = 0;
  const parts = [];
  for await (const chunk of stream) {
    total += chunk.length;
    assert(total <= limit);
    parts.push(chunk);
  }
  return Buffer.concat(parts);
}

const initializePath = (url) =>
  typeof url === "string" &&
  url.startsWith("/internal/runtimes/") &&
  url.endsWith("/initialize");

// Test-only transparent transport: it forwards every request and response
// unchanged unless a real completed Runtime initialize receipt matches the
// armed selection. The selection freezes at the FIRST incoming initialize
// request for the Agent, so retries of the same request stay held under one
// global policy timer.
export function startReliabilityProxy(
  upstream,
  port = 0,
  host = "127.0.0.1",
  { holdMs = 45000 } = {},
) {
  const origin = new URL(upstream);
  const state = {
    armed: false,
    agent_id: "",
    request_id: "",
    held: 0,
    records: [],
    epoch: 0,
  };
  const incomingSockets = new Set();
  const outgoingRequests = new Set();
  const heldResponses = new Set();
  let policyTimer;
  let closePromise;

  function selected(request_, headers) {
    if (
      !state.armed ||
      request_.method !== "POST" ||
      !initializePath(request_.url)
    )
      return -1;
    const pathAgent = request_.url.slice(
      "/internal/runtimes/".length,
      -"/initialize".length,
    );
    const key = headers["idempotency-key"];
    if (!identifier(pathAgent) || !identifier(key)) return -1;
    if (!state.agent_id) {
      state.agent_id = pathAgent;
      state.request_id = key;
      policyTimer = setTimeout(() => {
        state.armed = false;
        for (const held of [...heldResponses]) held.expire();
      }, holdMs);
      return state.epoch;
    }
    return pathAgent === state.agent_id && key === state.request_id
      ? state.epoch
      : -1;
  }

  function dropHeld(record, delivery) {
    if (record.delivery !== "held") return;
    record.delivery = delivery;
    state.held = Math.max(0, state.held - 1);
  }

  function finishArmed() {
    if (state.held === 0 && state.armed) {
      clearTimeout(policyTimer);
      state.armed = false;
    }
  }

  const server = createServer(async (request_, response) => {
    try {
      if (request_.method === "GET" && request_.url === "/status") {
        return json(response, 200, { status: "ok" });
      }
      if (request_.method === "GET" && request_.url === "/__test/status") {
        return json(response, 200, {
          armed: state.armed,
          agent_id: state.agent_id,
          request_id: state.request_id,
          held: state.held,
          records: state.records.map((record) => ({ ...record })),
        });
      }
      if (request_.method === "POST" && request_.url === "/__test/arm") {
        if (!(await emptyObject(request_))) {
          return json(response, 400, { code: "invalid_arm" });
        }
        if (state.armed || state.held > 0) {
          return json(response, 409, { code: "fault_pending" });
        }
        state.records.length = 0;
        state.agent_id = "";
        state.request_id = "";
        state.epoch += 1;
        state.armed = true;
        return json(response, 200, { armed: true });
      }
      if (request_.method === "POST" && request_.url === "/__test/release") {
        if (!(await emptyObject(request_))) {
          return json(response, 400, { code: "invalid_release" });
        }
        const released = state.held;
        for (const held of [...heldResponses]) held.release();
        finishArmed();
        return json(response, 200, { released });
      }
      if (request_.url.startsWith("/__test/")) {
        return json(response, 404, { code: "not_found" });
      }

      const selectedEpoch = selected(request_, request_.headers);
      const body =
        request_.method === "POST"
          ? await bytes(request_, 16 * 1024 * 1024)
          : undefined;
      const outgoing = request(
        new URL(request_.url, origin),
        {
          method: request_.method,
          headers: { ...request_.headers, host: origin.host },
        },
        async (upstreamResponse) => {
          try {
            if (selectedEpoch < 0) {
              response.writeHead(
                upstreamResponse.statusCode,
                upstreamResponse.headers,
              );
              upstreamResponse.pipe(response);
              return;
            }
            const raw = await bytes(upstreamResponse, 1024 * 1024);
            let output;
            try {
              output = JSON.parse(raw);
            } catch {
              /* Non-JSON responses pass through unchanged. */
            }
            const matches = Boolean(
              state.armed &&
              selectedEpoch === state.epoch &&
              upstreamResponse.statusCode === 200 &&
              output?.kind === "initialize_runtime" &&
              output.state === "completed" &&
              output.effect === "completed" &&
              output.agent_id === state.agent_id &&
              output.request_id === state.request_id &&
              identifier(output.target_revision),
            );
            if (!matches) {
              response.writeHead(
                upstreamResponse.statusCode,
                upstreamResponse.headers,
              );
              response.end(raw);
              return;
            }
            assert(state.records.length < 32);
            const record = {
              agent_id: state.agent_id,
              request_id: state.request_id,
              target_revision: output.target_revision,
              status: upstreamResponse.statusCode,
              request_hash: digest(body),
              response_hash: digest(raw),
              delivery: "held",
            };
            state.records.push(record);
            state.held += 1;
            const held = {
              expire() {
                dropHeld(record, "expired");
                heldResponses.delete(held);
                finishArmed();
                if (!response.destroyed) response.destroy();
              },
              release() {
                dropHeld(record, "released");
                heldResponses.delete(held);
                finishArmed();
                if (!response.destroyed) response.destroy();
              },
            };
            heldResponses.add(held);
            response.once("close", () => {
              if (record.delivery === "held") {
                dropHeld(record, "caller_disconnected");
                heldResponses.delete(held);
              }
            });
          } catch {
            if (!response.destroyed) response.destroy();
          }
        },
      );
      outgoingRequests.add(outgoing);
      outgoing.once("close", () => outgoingRequests.delete(outgoing));
      outgoing.on("error", () => {
        if (!response.destroyed && !response.headersSent) {
          json(response, 502, { code: "fixture_proxy_failure" });
        } else if (!response.destroyed) {
          response.destroy();
        }
      });
      response.once("close", () => {
        if (!response.writableEnded) outgoing.destroy();
      });
      if (body) outgoing.end(body);
      else request_.pipe(outgoing);
    } catch {
      if (!response.destroyed && !response.headersSent) {
        json(response, 502, { code: "fixture_proxy_failure" });
      } else if (!response.destroyed) {
        response.destroy();
      }
    }
  });

  server.on("connection", (socket) => {
    incomingSockets.add(socket);
    socket.once("close", () => incomingSockets.delete(socket));
  });

  server.listen(port, host);
  const close = () => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      clearTimeout(policyTimer);
      for (const held of [...heldResponses]) held.expire();
      heldResponses.clear();
      for (const outgoing of [...outgoingRequests]) outgoing.destroy();
      for (const socket of [...incomingSockets]) socket.destroy();
      await new Promise((resolve) => {
        if (!server.listening) return resolve();
        server.close(resolve);
      });
    })();
    return closePromise;
  };
  return { server, close };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const proxy = startReliabilityProxy(
    "http://runtime-controller:8080",
    8080,
    "0.0.0.0",
  );
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.once(signal, () => void proxy.close().then(() => process.exit(0)));
  }
}
