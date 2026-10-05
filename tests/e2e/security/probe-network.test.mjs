import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer as createHTTPServer } from "node:http";
import { createServer as createTCPServer } from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const script = fileURLToPath(new URL("./probe-network.mjs", import.meta.url));

async function probe(port) {
  const plan = {
    key: "untrusted-network",
    internal: true,
    probes: [{ service: "fixture", address: "127.0.0.1", port, closed: true }],
  };
  try {
    const { stdout } = await execute(
      process.execPath,
      [script, JSON.stringify(plan)],
      { env: {}, timeout: 8000, maxBuffer: 8192 },
    );
    return { exitCode: 0, result: JSON.parse(stdout) };
  } catch (error) {
    assert.equal(typeof error.code, "number");
    return { exitCode: error.code, result: JSON.parse(error.stdout) };
  }
}

async function withServer(server, inspect) {
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    await inspect(server.address().port);
  } finally {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
}

test("a forbidden interface returning even HTTP 401 is reachable and fails", async () => {
  await withServer(
    createHTTPServer((_request, response) => {
      response.writeHead(401).end("unauthenticated");
    }),
    async (port) => {
      const { exitCode, result } = await probe(port);
      assert.notEqual(exitCode, 0);
      assert.equal(result.status, "failed");
      assert.match(result.error.message, /forbidden interface/u);
    },
  );
});

test("a proxy accepting TCP then resetting without HTTP is not application access", async () => {
  await withServer(
    createTCPServer((socket) => socket.destroy()),
    async (port) => {
      const { exitCode, result } = await probe(port);
      assert.equal(exitCode, 0);
      assert.equal(result.status, "passed");
      assert.equal(result.checks, 1);
    },
  );
});

test("an accepted handshake without an HTTP response is bounded and closed", async () => {
  await withServer(
    createTCPServer(() => {}),
    async (port) => {
      const started = Date.now();
      const { exitCode, result } = await probe(port);
      assert.equal(exitCode, 0);
      assert.equal(result.status, "passed");
      assert(Date.now() - started < 6000);
    },
  );
});
