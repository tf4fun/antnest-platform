import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { startReliabilityProxy } from "./reliability-proxy.mjs";

const INITIALIZE_PATH = "/internal/runtimes/agent-1/initialize";

function completedReceipt(agentID, requestID) {
  return {
    kind: "initialize_runtime",
    state: "completed",
    effect: "completed",
    agent_id: agentID,
    request_id: requestID,
    target_revision: "rtv-fixture-1",
  };
}

function upstreamFixture(state) {
  return createServer((request_, response) => {
    const chunks = [];
    request_.on("data", (chunk) => chunks.push(chunk));
    request_.on("end", () => {
      state.requests.push({
        method: request_.method,
        url: request_.url,
        headers: { ...request_.headers },
        body: Buffer.concat(chunks).toString(),
      });
      if (state.mode === "slow" && request_.url === INITIALIZE_PATH) {
        setTimeout(() => {
          if (!response.destroyed) {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(
              JSON.stringify(
                completedReceipt(
                  "agent-1",
                  request_.headers["idempotency-key"],
                ),
              ),
            );
          }
        }, state.slowMs ?? 400);
        return;
      }
      if (state.mode === "hang" && request_.url === INITIALIZE_PATH) {
        state.hung = true;
        return; // Never respond — tests close under this condition.
      }
      if (request_.url === INITIALIZE_PATH) {
        const key = request_.headers["idempotency-key"];
        if (state.mode === "completed") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(completedReceipt("agent-1", key)));
          return;
        }
        if (state.mode === "other-agent") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(completedReceipt("agent-other", key)));
          return;
        }
        if (state.mode === "pending") {
          response.writeHead(202, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              kind: "initialize_runtime",
              state: "running",
              effect: "unknown",
              agent_id: "agent-1",
              request_id: key,
            }),
          );
          return;
        }
      }
      if (request_.url === "/internal/runtimes/agent-1/delete") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            kind: "delete_runtime",
            state: "completed",
            agent_id: "agent-1",
          }),
        );
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: "not_found" }));
    });
  });
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

const closeUpstream = (server) =>
  new Promise((resolve) => server.close(resolve));

async function start(state, { holdMs = 300 } = {}) {
  const upstream = upstreamFixture(state);
  const upstreamPort = await listen(upstream);
  const proxy = startReliabilityProxy(
    `http://127.0.0.1:${upstreamPort}`,
    0,
    "127.0.0.1",
    { holdMs },
  );
  await once(proxy.server, "listening");
  return { upstream, proxy, port: proxy.server.address().port };
}

async function post(
  port,
  path,
  { key, headers = {}, body = "{}", signal } = {},
) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": key,
      ...headers,
    },
    body,
    signal,
  });
}

const control = (port, path, body = "{}") =>
  fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", body });

const statusOf = (port) =>
  fetch(`http://127.0.0.1:${port}/__test/status`).then((r) => r.json());

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("initialize responses pass through while unarmed", async () => {
  const state = { requests: [], mode: "completed" };
  const { upstream, proxy, port } = await start(state);
  try {
    const response = await post(port, INITIALIZE_PATH, {
      key: "request-initialize-1",
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).state, "completed");
  } finally {
    await proxy.close();
    await closeUpstream(upstream);
  }
});

test("the first incoming initialize freezes the Agent and request selection", async () => {
  const state = { requests: [], mode: "pending" };
  const { upstream, proxy, port } = await start(state);
  try {
    await control(port, "/__test/arm");
    // The 202 request itself freezes the selection — before any completed receipt.
    const running = await post(port, INITIALIZE_PATH, {
      key: "request-initialize-1",
    });
    assert.equal(running.status, 202);
    const status = await statusOf(port);
    assert.equal(status.agent_id, "agent-1");
    assert.equal(status.request_id, "request-initialize-1");
    assert.equal(status.held, 0);
    assert.equal(status.armed, true);
    // A different request identity does not match the frozen selection.
    state.mode = "completed";
    const other = await post(port, INITIALIZE_PATH, { key: "request-other" });
    assert.equal(other.status, 200);
    const after = await statusOf(port);
    assert.equal(after.held, 0);
  } finally {
    await proxy.close();
    await closeUpstream(upstream);
  }
});

test("a matching completed receipt is held and a client disconnect does not unarm", async () => {
  const state = { requests: [], mode: "completed" };
  const { upstream, proxy, port } = await start(state, { holdMs: 5000 });
  try {
    await control(port, "/__test/arm");
    const controller = new AbortController();
    const held = post(port, INITIALIZE_PATH, {
      key: "request-initialize-1",
      signal: controller.signal,
    }).catch(() => {});
    await sleep(60);
    assert.equal((await statusOf(port)).held, 1);
    // Abort the caller — the held response disconnects but the selection stays armed.
    controller.abort();
    await held.catch(() => {});
    await sleep(60);
    let status = await statusOf(port);
    assert.equal(status.held, 0);
    assert.equal(status.armed, true);
    assert.equal(status.records[0].delivery, "caller_disconnected");
    // A same-key retry of the frozen request remains held, not a bypass.
    const retry = post(port, INITIALIZE_PATH, { key: "request-initialize-1" });
    await sleep(60);
    status = await statusOf(port);
    assert.equal(status.armed, true);
    assert.equal(status.held, 1);
    await retry.catch(() => {});
    await control(port, "/__test/release");
    const after = await statusOf(port);
    assert.equal(after.armed, false);
  } finally {
    await proxy.close();
    await closeUpstream(upstream);
  }
});

test("release with zero held still disarms the selection", async () => {
  const state = { requests: [], mode: "pending" };
  const { upstream, proxy, port } = await start(state);
  try {
    await control(port, "/__test/arm");
    await post(port, INITIALIZE_PATH, { key: "request-initialize-1" });
    assert.equal((await statusOf(port)).held, 0);
    const release = await control(port, "/__test/release");
    assert.equal(release.status, 200);
    const after = await statusOf(port);
    assert.equal(after.armed, false);
  } finally {
    await proxy.close();
    await closeUpstream(upstream);
  }
});

test("the global policy timer expires the selection", async () => {
  const state = { requests: [], mode: "pending" };
  const { upstream, proxy, port } = await start(state, { holdMs: 250 });
  try {
    await control(port, "/__test/arm");
    await post(port, INITIALIZE_PATH, { key: "request-initialize-1" });
    await sleep(350);
    const status = await statusOf(port);
    assert.equal(status.armed, false);
    // After expiry a fresh completed receipt passes through unarmed.
    state.mode = "completed";
    const response = await post(port, INITIALIZE_PATH, {
      key: "request-initialize-1",
    });
    assert.equal(response.status, 200);
  } finally {
    await proxy.close();
    await closeUpstream(upstream);
  }
});

test("a mismatched response Agent is forwarded, not held", async () => {
  const state = { requests: [], mode: "other-agent" };
  const { upstream, proxy, port } = await start(state);
  try {
    await control(port, "/__test/arm");
    const response = await post(port, INITIALIZE_PATH, {
      key: "request-initialize-1",
    });
    assert.equal(response.status, 200);
    assert.equal((await statusOf(port)).held, 0);
  } finally {
    await proxy.close();
    await closeUpstream(upstream);
  }
});

test("control bodies must be empty objects", async () => {
  const state = { requests: [], mode: "completed" };
  const { upstream, proxy, port } = await start(state);
  try {
    for (const bad of ["null", "[]", "", '{"agent_id":"x"}']) {
      const response = await control(port, "/__test/arm", bad);
      assert.equal(response.status, 400, `arm body ${bad} must reject`);
    }
    const release = await control(port, "/__test/release", "[]");
    assert.equal(release.status, 400);
  } finally {
    await proxy.close();
    await closeUpstream(upstream);
  }
});

test("close during a hanging upstream is idempotent and frees every socket", async () => {
  const state = { requests: [], mode: "hang" };
  const { upstream, proxy, port } = await start(state, { holdMs: 30000 });
  try {
    await control(port, "/__test/arm");
    void post(port, INITIALIZE_PATH, { key: "request-initialize-1" }).catch(
      () => {},
    );
    await sleep(60);
    await proxy.close();
    await proxy.close();
  } finally {
    await closeUpstream(upstream);
  }
});

test("a late response after global expiry forwards unchanged and is not recorded", async () => {
  const state = { requests: [], mode: "slow", slowMs: 350 };
  const { upstream, proxy, port } = await start(state, { holdMs: 150 });
  try {
    await control(port, "/__test/arm");
    const response = await post(port, INITIALIZE_PATH, {
      key: "request-initialize-1",
    });
    assert.equal(response.status, 200);
    const status = await statusOf(port);
    assert.equal(status.held, 0);
    assert.equal(
      status.records.length,
      0,
      "an expired selection must not record a held receipt",
    );
  } finally {
    await proxy.close();
    await closeUpstream(upstream);
  }
});

test("a late response after release forwards unchanged and is not recorded", async () => {
  const state = { requests: [], mode: "slow", slowMs: 200 };
  const { upstream, proxy, port } = await start(state, { holdMs: 30000 });
  try {
    await control(port, "/__test/arm");
    const pending = post(port, INITIALIZE_PATH, {
      key: "request-initialize-1",
    });
    await sleep(50);
    await control(port, "/__test/release");
    const response = await pending;
    assert.equal(response.status, 200);
    const status = await statusOf(port);
    assert.equal(status.held, 0);
    assert.equal(status.records.length, 0);
  } finally {
    await proxy.close();
    await closeUpstream(upstream);
  }
});

test("a stale response from a prior arm epoch is not recorded under the next policy", async () => {
  const state = { requests: [], mode: "slow", slowMs: 200 };
  const { upstream, proxy, port } = await start(state, { holdMs: 30000 });
  try {
    await control(port, "/__test/arm");
    const stale = post(port, INITIALIZE_PATH, { key: "request-initialize-1" });
    await sleep(50);
    await control(port, "/__test/release");
    await control(port, "/__test/arm");
    const response = await stale;
    assert.equal(response.status, 200);
    const status = await statusOf(port);
    assert.equal(
      status.records.length,
      0,
      "the previous epoch's reply must not record under the new policy",
    );
  } finally {
    await proxy.close();
    await closeUpstream(upstream);
  }
});
