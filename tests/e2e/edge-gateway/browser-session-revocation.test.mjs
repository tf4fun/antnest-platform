import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { withSessionRevocationObserver } from "./browser-session-revocation.mjs";
import { quietObservers } from "./browser-sessions-flow.mjs";

function fixture(failure) {
  const calls = [];
  const error = new Error("controlled failure");
  const streams = {
    sseClosedAfterMs: 12,
    bothClosedAfterMs: 20,
    wssCloseCode: 1008,
    localAbort: false,
    beforeNaturalCCTExpiry: true,
  };
  const step = (name) => {
    calls.push(name);
    if (failure === name) throw error;
  };
  const observer = {
    beforeMutation() {
      step("before");
      return 100;
    },
    async revoked(at) {
      assert.equal(at, 100);
      step("remote");
      return streams;
    },
    async close() {
      step("close");
    },
  };
  return {
    calls,
    error,
    streams,
    observer,
    observe: async () => {
      step("open");
      return observer;
    },
    action: async () => step("action"),
  };
}

test("self-all opens independent observers before the real action and retains remote evidence", async () => {
  const f = fixture();
  assert.equal(
    await withSessionRevocationObserver(f.observe, f.action),
    f.streams,
  );
  assert.deepEqual(f.calls, ["open", "before", "action", "remote", "close"]);
});

test("HTTP and UI completion cannot substitute for independent remote closure", async () => {
  const f = fixture();
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  f.observer.revoked = async (at) => {
    assert.equal(at, 100);
    f.calls.push("remote");
    await pending;
    return f.streams;
  };
  let settled = false;
  const running = withSessionRevocationObserver(f.observe, f.action).then(
    (value) => {
      settled = true;
      return value;
    },
  );
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    assert.deepEqual(f.calls, ["open", "before", "action", "remote"]);
  } finally {
    release();
    await running;
  }
  assert.equal(settled, true);
  assert.equal(f.calls.at(-1), "close");
});

for (const [failure, calls] of [
  ["open", ["open"]],
  ["before", ["open", "before", "close"]],
  ["action", ["open", "before", "action", "close"]],
  ["remote", ["open", "before", "action", "remote", "close"]],
  ["close", ["open", "before", "action", "remote", "close"]],
])
  test(`self-all fails and joins observer cleanup after ${failure} failure`, async () => {
    const f = fixture(failure);
    await assert.rejects(
      withSessionRevocationObserver(f.observe, f.action),
      (error) => error === f.error,
    );
    assert.deepEqual(f.calls, calls);
  });

test("remote failure and cleanup failure are both retained", async () => {
  const f = fixture("remote");
  const cleanup = new Error("controlled cleanup failure");
  f.observer.close = async () => {
    f.calls.push("close");
    throw cleanup;
  };
  await assert.rejects(
    withSessionRevocationObserver(f.observe, f.action),
    (error) => {
      assert(error instanceof AggregateError);
      assert.deepEqual(error.errors, [f.error, cleanup]);
      return true;
    },
  );
});

test("observer cleanup finishes before success is returned", async () => {
  const f = fixture();
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  f.observer.close = async () => {
    f.calls.push("close");
    await pending;
  };
  let settled = false;
  const running = withSessionRevocationObserver(f.observe, f.action).then(
    () => {
      settled = true;
    },
  );
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    assert.equal(f.calls.at(-1), "close");
  } finally {
    release();
    await running;
  }
  assert.equal(settled, true);
});

test(
  "quiet observer cleanup waits for the upgraded socket's actual close",
  { timeout: 10000 },
  async (t) => {
    const require = createRequire(
      new URL(
        "../../../services/agent-acp-service/package.json",
        import.meta.url,
      ),
    );
    const { WebSocketServer } = require("ws");
    const server = createServer((request, response) => {
      assert.equal(request.headers.cookie, "synthetic-session");
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(": open\n\n");
    });
    const sockets = new WebSocketServer({ server });
    const controller = new AbortController();
    let peer, running;
    sockets.on("connection", (socket) => {
      peer = socket;
      socket.once("message", (raw) => {
        const message = JSON.parse(raw.toString());
        socket.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: message.params.protocolVersion,
              agentCapabilities: {},
            },
          }),
        );
        // Hold the close handshake after a real successful HTTP 101 upgrade.
        socket.pause();
      });
    });
    t.after(async () => {
      controller.abort();
      for (const socket of sockets.clients) {
        socket.resume();
        socket.terminate();
      }
      await running;
      await new Promise((resolve) => sockets.close(resolve));
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const observer = await quietObservers(
      { gateway: `http://127.0.0.1:${server.address().port}` },
      "agent",
      { cookie: "synthetic-session" },
      controller.signal,
    );
    observer.beforeMutation();
    const failure = new Error("controlled action failure");
    let settled = false;
    running = withSessionRevocationObserver(
      async () => observer,
      async () => {
        throw failure;
      },
    )
      .then(
        () => ({ success: true }),
        (error) => ({ error }),
      )
      .then((result) => {
        settled = true;
        return result;
      });
    try {
      await delay(50);
      assert.equal(
        settled,
        false,
        "HTTP 101 does not prove WSS cleanup completed",
      );
    } finally {
      peer.resume();
    }
    const result = await running;
    assert.equal(result.error, failure);
    assert.equal(settled, true);
  },
);
