import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";

export function classifyDisableFault(fault, method, path) {
  if (
    method !== "POST" ||
    path !== `/internal/runtimes/${fault.agentID}/disable`
  )
    return "forward";
  if (fault.mode === "reject") return "reject";
  if (fault.mode === "unknown_once" && fault.calls === 0) return "unknown_once";
  return "forward";
}

function sendJSON(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

export function createSourceRecoveryRCProxy() {
  const fault = { agentID: "", mode: "", calls: 0, childIDs: [], forwarded: 0 };
  return createServer(async (incoming, outgoing) => {
    if (incoming.method === "GET" && incoming.url === "/status") {
      sendJSON(outgoing, 200, { status: "ok" });
      return;
    }
    if (incoming.method === "GET" && incoming.url === "/fault/status") {
      sendJSON(outgoing, 200, {
        agent_id: fault.agentID,
        mode: fault.mode,
        calls: fault.calls,
        child_ids: fault.childIDs,
        forwarded: fault.forwarded,
      });
      return;
    }
    if (incoming.method === "POST" && incoming.url === "/fault/configure") {
      let body = "";
      for await (const chunk of incoming) {
        body += chunk;
        if (body.length > 1024) {
          sendJSON(outgoing, 413, { code: "invalid_request" });
          return;
        }
      }
      let input;
      try {
        input = JSON.parse(body);
      } catch {
        sendJSON(outgoing, 400, { code: "invalid_request" });
        return;
      }
      if (
        !/^agent_[a-f0-9]{32}$/u.test(input.agent_id) ||
        !["unknown_once", "reject"].includes(input.mode)
      ) {
        sendJSON(outgoing, 400, { code: "invalid_request" });
        return;
      }
      Object.assign(fault, {
        agentID: input.agent_id,
        mode: input.mode,
        calls: 0,
        childIDs: [],
        forwarded: 0,
      });
      sendJSON(outgoing, 200, { agent_id: fault.agentID, mode: fault.mode });
      return;
    }
    const targetDisable =
      incoming.method === "POST" &&
      incoming.url?.split("?")[0] ===
        `/internal/runtimes/${fault.agentID}/disable`;
    const action = classifyDisableFault(
      fault,
      incoming.method,
      incoming.url?.split("?")[0],
    );
    if (action !== "forward") {
      fault.calls++;
      fault.childIDs.push(String(incoming.headers["idempotency-key"] ?? ""));
    } else if (targetDisable) {
      fault.calls++;
      fault.childIDs.push(String(incoming.headers["idempotency-key"] ?? ""));
    }
    if (action === "reject") {
      incoming.resume();
      sendJSON(outgoing, 409, {
        code: "runtime_revision_conflict",
        retryable: false,
      });
      return;
    }
    const upstream = httpRequest(
      {
        hostname: "runtime-controller",
        port: 8080,
        path: incoming.url,
        method: incoming.method,
        headers: incoming.headers,
      },
      (response) => {
        if (action === "unknown_once") {
          response.resume();
          response.once("end", () =>
            sendJSON(outgoing, 503, {
              code: "control_plane_unavailable",
              retryable: true,
            }),
          );
        } else {
          outgoing.writeHead(response.statusCode ?? 502, response.headers);
          response.pipe(outgoing);
        }
      },
    );
    if (targetDisable) fault.forwarded++;
    upstream.on("error", () => {
      if (!outgoing.headersSent)
        sendJSON(outgoing, 502, {
          code: "control_plane_unavailable",
          retryable: true,
        });
    });
    incoming.pipe(upstream);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  assert(process.env.ANTNEST_E2E_SOURCE_RECOVERY === "true");
  createSourceRecoveryRCProxy().listen(8080, "0.0.0.0");
}
