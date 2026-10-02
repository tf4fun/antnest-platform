import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { temporaryStorageRoot } from "../../support/storage.mjs";
import { startObservationProxy } from "./observation-retry-proxy.mjs";

function unixRequest(socketPath) {
  return new Promise((resolve, reject) => {
    const call = request(
      { socketPath, path: "/v1.47/containers/json?all=true" },
      (response) => {
        let body = "";
        response.on("data", (value) => (body += value));
        response.on("end", () => resolve(body));
        response.on("error", reject);
      },
    );
    call.on("error", reject);
    call.setTimeout(2000, () => call.destroy(new Error("request timeout")));
    call.end();
  });
}

test("observation fault proxy removes the Unix socket and restores real forwarding", async () => {
  const directory = await mkdtemp(join(temporaryStorageRoot(), "rc-retry-"));
  const upstreamSocket = join(directory, "upstream.sock");
  const socketPath = join(directory, "docker.sock");
  const upstream = createServer((incoming, outgoing) => {
    assert.equal(incoming.url, "/v1.47/containers/json?all=true");
    outgoing.end('[{"Id":"fixture-runtime"}]');
  });
  await new Promise((resolve) => upstream.listen(upstreamSocket, resolve));
  let proxy;
  try {
    proxy = await startObservationProxy({
      socketPath,
      upstreamSocket,
      host: "127.0.0.1",
      port: 0,
    });
    await assert.rejects(unixRequest(socketPath), { code: "ENOENT" });
    const online = await fetch(`${proxy.url}/online`, { method: "POST" });
    assert.equal(online.status, 200);
    assert.equal(await unixRequest(socketPath), '[{"Id":"fixture-runtime"}]');
    const offline = await fetch(`${proxy.url}/offline`, { method: "POST" });
    assert.equal(offline.status, 200);
    await assert.rejects(unixRequest(socketPath), { code: "ENOENT" });
    await fetch(`${proxy.url}/online`, { method: "POST" });
    assert.equal(await unixRequest(socketPath), '[{"Id":"fixture-runtime"}]');
    const status = await (await fetch(`${proxy.url}/status`)).json();
    assert.deepEqual(status, { online: true, forwarded: 2 });
  } finally {
    await proxy?.close();
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
