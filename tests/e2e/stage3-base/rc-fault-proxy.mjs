import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";

let intercepted = false;
let pendingAgent = "";
let releasePending;
let pendingGate;
let gateReleased = false;
const holdUntilRelease =
  process.env.ANTNEST_E2E_SKILL_RESTART_REBUILD === "true";

const server = createServer(async (incoming, outgoing) => {
  if (incoming.method === "GET" && incoming.url === "/fault/pending") {
    outgoing.writeHead(200, { "content-type": "application/json" });
    outgoing.end(
      JSON.stringify({ pending: pendingAgent !== "", agent_id: pendingAgent }),
    );
    return;
  }
  if (incoming.method === "POST" && incoming.url === "/fault/release") {
    assert(pendingAgent && releasePending, "no fenced Update is held");
    gateReleased = true;
    releasePending();
    releasePending = undefined;
    pendingAgent = "";
    outgoing.writeHead(204);
    outgoing.end();
    return;
  }
  const target = /^\/internal\/runtimes\/(agent_[0-9a-f]{32})\/update$/.exec(
    incoming.url ?? "",
  );
  const started = Date.now();
  console.log(
    JSON.stringify({
      event: "forward_started",
      method: incoming.method,
      path: incoming.url?.split("?")[0],
    }),
  );
  if (
    incoming.method === "POST" &&
    target &&
    ((holdUntilRelease && !gateReleased) || !intercepted)
  ) {
    intercepted = true;
    pendingAgent = target[1];
    if (holdUntilRelease) {
      if (!releasePending) {
        pendingGate = new Promise((resolve) => {
          releasePending = resolve;
        });
      }
      await pendingGate;
    } else {
      await new Promise((resolve) => {
        releasePending = resolve;
      });
    }
  }
  outgoing.once("finish", () =>
    console.log(
      JSON.stringify({
        event: "forward_finished",
        method: incoming.method,
        path: incoming.url?.split("?")[0],
        status: outgoing.statusCode,
        duration_ms: Date.now() - started,
      }),
    ),
  );
  const upstream = httpRequest(
    {
      hostname: "runtime-controller",
      port: 8080,
      path: incoming.url,
      method: incoming.method,
      headers: incoming.headers,
    },
    (response) => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
    },
  );
  upstream.on("error", (error) => {
    if (!outgoing.headersSent) outgoing.writeHead(502);
    outgoing.end(error.message);
  });
  incoming.pipe(upstream);
});
server.listen(8080, "0.0.0.0");
