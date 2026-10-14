import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setImmediate as turn } from "node:timers/promises";
import test from "node:test";
import * as acp from "../../../services/agent-acp-service/node_modules/@agentclientprotocol/sdk/dist/acp.js";
import { AcpServer } from "../../../services/agent-acp-service/node_modules/@agentclientprotocol/sdk/dist/server.js";
import { createNodeHttpHandler } from "../../../services/agent-acp-service/node_modules/@agentclientprotocol/sdk/dist/node-adapter.js";
import { remoteCloseReceipt } from "./http-close-receipt.mjs";

async function reach(barrier, completed, label) {
  const reached = await Promise.race([
    barrier.then(() => true),
    completed.then(() => false),
  ]);
  assert(reached, `Helper ended before ${label}`);
}

// The official client and server exchange real HTTP. This small receiver models
// the receipt contract only; the production Docker receiver proves its owner.
async function receiver(t, operation = () => undefined) {
  const claims = { org: "organization", sub: "principal", agt: "agent" };
  const configuration = {
    revision: 1,
    agents: [{ agent_id: claims.agt, principal_ids: [claims.sub] }],
  };
  const persisted = {
    sessions: [{ id: "session", state: "open" }],
    runs: [{ id: "run", state: "unresolved" }],
  };
  const history = [];
  const counts = { snapshot: 0, publish: 0 };
  let connectionId;
  let retired = false;
  let consumed = false;
  const sdk = new AcpServer({
    agent: acp
      .agent()
      .onRequest(acp.methods.agent.initialize, () => ({
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
      }))
      .onRequest(acp.methods.agent.session.load, () => ({})),
  });
  const http = createServer(
    createNodeHttpHandler({
      async handleRequest(request) {
        const id = request.headers.get("acp-connection-id");
        if (id) {
          if (id !== connectionId || consumed)
            return new Response(null, { status: 404 });
          if (request.headers.get("x-test-binding") !== JSON.stringify(claims))
            return new Response(null, { status: 403 });
          if (retired) {
            if (request.method !== "DELETE")
              return new Response(null, { status: 404 });
            if ((await request.text()) !== "")
              return new Response(null, { status: 400 });
            consumed = true;
            return new Response(null, { status: 202 });
          }
        }
        const response = await sdk.handleRequest(request);
        connectionId ??= response.headers.get("acp-connection-id");
        return response;
      },
    }),
  );
  t.after(async () => {
    await sdk.close();
    http.closeAllConnections();
    await new Promise((resolve, reject) =>
      http.close((error) => (error ? reject(error) : resolve())),
    );
  });
  await new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", resolve);
  });
  async function record(kind) {
    const count = ++counts[kind];
    const name = `${kind}:${count}`;
    history.push(name);
    await operation(name);
  }
  return {
    history,
    options: {
      origin: `http://127.0.0.1:${http.address().port}`,
      headersFor: (scope) => ({ "x-test-binding": JSON.stringify(scope) }),
      claims,
      configuration,
      sessionId: "session",
      async snapshot() {
        await record("snapshot");
        return structuredClone(persisted);
      },
      async publish(next) {
        await record("publish");
        if (next.agents[0].principal_ids.length === 0) {
          retired = true;
          await sdk.close();
        }
      },
    },
  };
}

test(
  "remote close receipt completes the official SDK exchange",
  { timeout: 5000 },
  async (t) => {
    const fixture = await receiver(t);
    const result = await remoteCloseReceipt({
      ...fixture.options,
      signal: new AbortController().signal,
    });
    assert.deepEqual(result.automaticDelete, {
      count: 1,
      status: 202,
      completeEmptyBody: true,
    });
    assert.deepEqual(fixture.history, [
      "snapshot:1",
      "publish:1",
      "snapshot:2",
      "snapshot:3",
      "publish:2",
      "snapshot:4",
    ]);
  },
);

for (const held of ["snapshot:1", "publish:2", "snapshot:4"]) {
  test(
    `cancellation joins ${held} and prevents later work or success`,
    { timeout: 5000 },
    async (t) => {
      const entered = Promise.withResolvers();
      const release = Promise.withResolvers();
      const fixture = await receiver(t, async (name) => {
        if (name === held) {
          entered.resolve();
          await release.promise;
        }
      });
      const stop = new AbortController();
      const reason = new Error(`Cancelled while awaiting ${held}`);
      let settled = false;
      const completed = remoteCloseReceipt({
        ...fixture.options,
        signal: stop.signal,
      })
        .then(
          (value) => ({ value }),
          (error) => ({ error }),
        )
        .finally(() => {
          settled = true;
        });
      t.after(async () => {
        stop.abort(reason);
        release.resolve();
        await completed;
      });
      let returnedBeforeRelease;
      let historyAtAbort;
      try {
        await reach(entered.promise, completed, held);
        historyAtAbort = [...fixture.history];
        stop.abort(reason);
        await turn();
        returnedBeforeRelease = settled;
      } finally {
        stop.abort(reason);
        release.resolve();
        await completed;
      }
      const outcome = await completed;
      assert.equal(
        returnedBeforeRelease,
        false,
        "Original operation was abandoned",
      );
      assert.equal(
        outcome.error,
        reason,
        "Cancellation was reported as success",
      );
      assert.deepEqual(
        fixture.history,
        historyAtAbort,
        "Work started after cancellation",
      );
    },
  );
}

test(
  "caller cancellation during final body cleanup cannot report success",
  { timeout: 5000 },
  async (t) => {
    const businessComplete = Promise.withResolvers();
    const cancelling = Promise.withResolvers();
    const release = Promise.withResolvers();
    const fixture = await receiver(t, (name) => {
      if (name === "snapshot:4") businessComplete.resolve();
    });
    const stop = new AbortController();
    const reason = new Error("Cancelled while final cleanup was pending");
    const originalFetch = globalThis.fetch;
    let bodyCancelled = false;
    t.mock.method(globalThis, "fetch", async (input, init) => {
      const response = await originalFetch(input, init);
      if (
        init?.method !== "GET" ||
        !new Headers(init.headers).has("acp-session-id")
      )
        return response;
      const reader = response.body.getReader();
      let cancellingBody = false;
      return new Response(
        new ReadableStream({
          async pull(controller) {
            try {
              const next = await reader.read();
              if (next.done) {
                // Keep this body open until the independent connection GET closes
                // and SDK cancellation reaches it. Preserve all actual messages.
                await release.promise;
                if (!cancellingBody) controller.close();
              } else controller.enqueue(next.value);
            } catch (error) {
              await release.promise;
              if (!cancellingBody) controller.error(error);
            }
          },
          async cancel(error) {
            cancellingBody = true;
            cancelling.resolve();
            // Native fetch may already have errored when the SDK aborts. Join
            // that result, then hold this body's independent cleanup receipt.
            await Promise.allSettled([reader.cancel(error)]);
            await release.promise;
            bodyCancelled = true;
          },
        }),
        { status: response.status, headers: response.headers },
      );
    });
    let settled = false;
    const completed = remoteCloseReceipt({
      ...fixture.options,
      signal: stop.signal,
    })
      .then(
        (value) => ({ value }),
        (error) => ({ error }),
      )
      .finally(() => {
        settled = true;
      });
    t.after(async () => {
      stop.abort(reason);
      release.resolve();
      await completed;
    });
    let returnedBeforeRelease;
    try {
      await reach(businessComplete.promise, completed, "final snapshot");
      await reach(cancelling.promise, completed, "session body cancellation");
      await turn();
      stop.abort(reason);
      await turn();
      returnedBeforeRelease = settled;
    } finally {
      stop.abort(reason);
      release.resolve();
      await completed;
    }
    assert.equal(returnedBeforeRelease, false);
    assert.equal(bodyCancelled, true);
    assert.equal(
      (await completed).error,
      reason,
      "Late cancellation was reported as success",
    );
  },
);

test(
  "cancellation joins the initialize response body before returning",
  { timeout: 5000 },
  async (t) => {
    const fixture = await receiver(t);
    const read = Promise.withResolvers();
    const cancelling = Promise.withResolvers();
    const release = Promise.withResolvers();
    const stop = new AbortController();
    const reason = new Error("Interrupted initialize body");
    const originalFetch = globalThis.fetch;
    let bodyController;
    let bodyCancelled = false;
    t.mock.method(globalThis, "fetch", async (input, init) => {
      const response = await originalFetch(input, init);
      if (init?.method !== "POST" || !response.headers.has("acp-connection-id"))
        return response;
      await response.body.cancel();
      return new Response(
        new ReadableStream({
          start(controller) {
            bodyController = controller;
          },
          pull() {
            read.resolve();
          },
          async cancel() {
            cancelling.resolve();
            await release.promise;
            bodyCancelled = true;
          },
        }),
        { status: response.status, headers: response.headers },
      );
    });
    let settled = false;
    const completed = remoteCloseReceipt({
      ...fixture.options,
      signal: stop.signal,
    })
      .then(
        (value) => ({ value }),
        (error) => ({ error }),
      )
      .finally(() => {
        settled = true;
      });
    t.after(async () => {
      stop.abort(reason);
      release.resolve();
      if (!bodyCancelled) bodyController?.error(reason);
      await completed;
    });
    let returnedBeforeRelease;
    let cancelledBeforeReturn;
    try {
      await reach(read.promise, completed, "initialize body read");
      await turn();
      stop.abort(reason);
      await Promise.race([cancelling.promise, completed]);
      await turn();
      returnedBeforeRelease = settled;
    } finally {
      stop.abort(reason);
      release.resolve();
      // Also release an implementation that failed to cancel its body, so a red
      // regression leaves neither the SDK initialize write nor a socket behind.
      if (!bodyCancelled) bodyController?.error(reason);
      await completed;
      cancelledBeforeReturn = bodyCancelled;
    }
    assert.equal(
      returnedBeforeRelease,
      false,
      "Returned while the body cleanup was pending",
    );
    assert.equal(
      cancelledBeforeReturn,
      true,
      "Initialize body was not cancelled and joined",
    );
    assert.equal((await completed).error, reason);
  },
);
