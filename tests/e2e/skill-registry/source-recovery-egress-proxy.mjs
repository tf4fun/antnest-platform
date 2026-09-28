import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";

export function shouldHoldPublishRead(fault, method, path) {
  return (
    fault.mode === "hold_publish" &&
    !fault.held &&
    fault.reads >= 2 &&
    method === "GET" &&
    path === `/internal/agent-networks/${fault.agentID}`
  );
}

function sendJSON(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

export function createSourceRecoveryEgressProxy(upstreamHost) {
  const fault = {
    agentID: "",
    mode: "",
    reads: 0,
    held: false,
    pending: false,
    reopened: false,
    release: undefined,
  };
  return createServer(async (incoming, outgoing) => {
    if (incoming.method === "GET" && incoming.url === "/status") {
      sendJSON(outgoing, 200, { status: "ok" });
      return;
    }
    if (incoming.method === "GET" && incoming.url === "/fault/status") {
      sendJSON(outgoing, 200, {
        agent_id: fault.agentID,
        reads: fault.reads,
        held: fault.held,
        pending: fault.pending,
        reopened: fault.reopened,
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
        input.mode !== "hold_publish" ||
        fault.pending
      ) {
        sendJSON(outgoing, 400, { code: "invalid_request" });
        return;
      }
      Object.assign(fault, {
        agentID: input.agent_id,
        mode: input.mode,
        reads: 0,
        held: false,
        pending: false,
        reopened: false,
        release: undefined,
      });
      sendJSON(outgoing, 200, { agent_id: fault.agentID, mode: fault.mode });
      return;
    }
    if (incoming.method === "POST" && incoming.url === "/fault/reopen") {
      if (!fault.pending || fault.reopened) {
        sendJSON(outgoing, 409, { code: "not_pending" });
        return;
      }
      try {
        const network = await fetch(
          `http://${upstreamHost}:8081/internal/agent-networks/${fault.agentID}`,
          { signal: AbortSignal.timeout(10000) },
        );
        assert.equal(network.status, 200);
        const attachment = await network.json();
        assert.equal(attachment.attachment_state, "closed");
        const response = await fetch(
          `http://${upstreamHost}:8081/internal/agent-network-attachments/${fault.agentID}`,
          {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              state: "open",
              expected_resource_version: attachment.attachment_resource_version,
            }),
            signal: AbortSignal.timeout(10000),
          },
        );
        assert.equal(response.status, 200);
        fault.reopened = true;
        sendJSON(outgoing, 200, { attachment_state: "open" });
      } catch {
        sendJSON(outgoing, 502, { code: "fault_injection_failed" });
      }
      return;
    }
    if (incoming.method === "POST" && incoming.url === "/fault/release") {
      if (!fault.pending || !fault.reopened || !fault.release) {
        sendJSON(outgoing, 409, { code: "not_reopened" });
        return;
      }
      fault.release();
      fault.release = undefined;
      sendJSON(outgoing, 200, { released: true });
      return;
    }
    const path = incoming.url?.split("?")[0];
    const hold = shouldHoldPublishRead(fault, incoming.method, path);
    if (
      incoming.method === "GET" &&
      path === `/internal/agent-networks/${fault.agentID}`
    )
      fault.reads++;
    if (hold) {
      fault.held = true;
      fault.pending = true;
      await new Promise((resolve) => {
        fault.release = resolve;
      });
      fault.pending = false;
    }
    const upstream = httpRequest(
      {
        hostname: upstreamHost,
        port: 8081,
        path: incoming.url,
        method: incoming.method,
        headers: incoming.headers,
      },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(outgoing);
      },
    );
    upstream.on("error", () => {
      if (!outgoing.headersSent)
        sendJSON(outgoing, 502, { code: "control_plane_unavailable" });
    });
    incoming.pipe(upstream);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  assert.match(
    process.env.ANTNEST_EGRESS_CONTROL_IPV4 ?? "",
    /^\d{1,3}(?:\.\d{1,3}){3}$/u,
  );
  createSourceRecoveryEgressProxy(
    process.env.ANTNEST_EGRESS_CONTROL_IPV4,
  ).listen(8081, "0.0.0.0");
}
