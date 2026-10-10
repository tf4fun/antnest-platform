import { gatewayOrigin } from "../../support/gateway-origin.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { until } from "./wait.mjs";
export { until } from "./wait.mjs";
import * as v1 from "@agentclientprotocol/sdk";
import * as v2 from "@agentclientprotocol/sdk/experimental/v2";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import { WebSocket } from "ws";
import { observeSocket, requestWithin } from "./connection.mjs";
export { assertMessageReplay } from "./replay.mjs";

export const gateway = "http://edge-gateway:8080";

export class BrowserSession {
  cookie = "";
  csrf = "";
  async login(email, password) {
    const result = await this.request("/api/session/login", {
      organization_slug: "stage3",
      email,
      password,
    });
    this.principal = result.principal;
  }
  async request(path, body, expected = 200) {
    const response = await fetch(gateway + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "content-type": "application/json",
        Cookie: this.cookie,
        Origin: gatewayOrigin(gateway),
        "X-Antnest-CSRF-Token": this.csrf,
        "Idempotency-Key": randomUUID(),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(
      response.status,
      expected,
      `${path}: ${await response.clone().text()}`,
    );
    if (path === "/api/session/login") {
      this.cookie = response.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; ");
      this.csrf = this.cookie.match(/(?:^|; )antnest_csrf=([^;]+)/)?.[1] ?? "";
    }
    return response.json();
  }
  async waitOperation(id) {
    return until(
      async () => {
        const operation = await this.request(`/api/admin/operations/${id}`);
        assert.notEqual(operation.state, "failed", JSON.stringify(operation));
        return operation.state === "completed";
      },
      `operation ${id}`,
      120000,
    );
  }
}

export async function connect(version, agent, browser) {
  const acp = version === 1 ? v1 : v2;
  const updates = [];
  let closeCode;
  const closed = new AbortController();
  const ObservedSocket = observeSocket(WebSocket, closed, (code) => {
    closeCode = code;
  });
  const connection = acp
    .client()
    .onNotification(acp.methods.client.session.update, ({ params }) =>
      updates.push(params),
    )
    .onRequest(acp.methods.client.session.requestPermission, () => ({
      outcome: { outcome: "cancelled" },
    }))
    .connect(
      createWebSocketStream(
        `ws://edge-gateway:8080/api/app/agents/${agent}/v${version}/acp`,
        {
          WebSocket: ObservedSocket,
          headers: { Cookie: browser.cookie, Origin: gatewayOrigin(gateway) },
        },
      ),
    );
  // Only SDK descriptors cross the transport boundary; versions differ in init/replay/completion.
  const send = (method, params, timeout = 30000) =>
    requestWithin(
      (options) => connection.agent.request(method, params, options),
      closed.signal,
      () => connection.close(),
      timeout,
    );
  const request = (name, params) =>
    send(acp.methods.agent.session[name], params);
  try {
    const initialized = await send(
      acp.methods.agent.initialize,
      version === 1
        ? { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} }
        : {
            protocolVersion: acp.PROTOCOL_VERSION,
            info: { name: "closeout", version: "1" },
            capabilities: {},
          },
      10000,
    );
    assert.equal(initialized.protocolVersion, acp.PROTOCOL_VERSION);
  } catch (error) {
    connection.close();
    throw error;
  }
  return {
    updates,
    request,
    get closeCode() {
      return closeCode;
    },
    close: () => connection.close(),
    async replay(sessionId, expectedStopReason) {
      const offset = updates.length;
      await request(version === 1 ? "load" : "resume", {
        sessionId,
        cwd: "/workspace",
        mcpServers: [],
        ...(version === 2 ? { replayFrom: { type: "start" } } : {}),
      });
      const received = updates.slice(offset);
      assert(
        received.every((item) => item.sessionId === sessionId),
        "replay contains foreign Session events",
      );
      if (version === 2) {
        const state = received
          .filter((item) => item.update.sessionUpdate === "state_update")
          .at(-1)?.update;
        assert.equal(state?.state, "idle", "replayed Session did not settle");
        if (expectedStopReason)
          assert.equal(state.stopReason, expectedStopReason);
      }
      return received.filter(
        (item) => item.update.sessionUpdate !== "state_update",
      );
    },
    async prompt(sessionId, phase) {
      const offset = updates.length;
      const result = await request("prompt", {
        sessionId,
        prompt: [{ type: "text", text: phase }],
      });
      if (version === 1) assert.equal(result.stopReason, "end_turn");
      else
        await until(
          () =>
            updates
              .slice(offset)
              .some(
                (item) =>
                  item.update.state === "idle" &&
                  item.update.stopReason === "end_turn",
              ),
          "v2 completion",
        );
      assert(
        JSON.stringify(updates.slice(offset)).includes(`${phase} verified`),
        "missing final response",
      );
    },
  };
}

export async function rejectedUpgrade(version, agent, browser) {
  const socket = new WebSocket(
    `ws://edge-gateway:8080/api/app/agents/${agent}/v${version}/acp`,
    {
      headers: { Cookie: browser.cookie, Origin: gatewayOrigin(gateway) },
      handshakeTimeout: 10000,
    },
  );
  try {
    const status = await new Promise((resolve, reject) => {
      socket.once("open", () =>
        reject(new Error("foreign Agent upgrade succeeded")),
      );
      socket.on("error", reject);
      socket.once("unexpected-response", (_request, response) => {
        response.destroy();
        resolve(response.statusCode);
      });
    });
    assert.equal(status, 404);
  } finally {
    socket.terminate();
  }
}
