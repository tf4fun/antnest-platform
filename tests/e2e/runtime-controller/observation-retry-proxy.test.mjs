import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { temporaryStorageRoot } from "../../support/storage.mjs";
import { startObservationProxy } from "./observation-retry-proxy.mjs";

function unixResponse(socketPath, path) {
  return new Promise((resolve, reject) => {
    const call = request({ socketPath, path }, resolve);
    call.on("error", reject);
    call.setTimeout(2000, () => call.destroy(new Error("request timeout")));
    call.end();
  });
}

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
    const socket = await stat(socketPath);
    assert.equal(socket.gid, process.getgid());
    assert.equal(socket.mode & 0o777, 0o660);
    assert.equal(await unixRequest(socketPath), '[{"Id":"fixture-runtime"}]');
    const offline = await fetch(`${proxy.url}/offline`, { method: "POST" });
    assert.equal(offline.status, 200);
    await assert.rejects(unixRequest(socketPath), { code: "ENOENT" });
    await fetch(`${proxy.url}/online`, { method: "POST" });
    assert.equal((await stat(socketPath)).mode & 0o777, 0o660);
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

test("Watch-only disconnect keeps Docker lifecycle requests available until Watch resumes", async () => {
  const directory = await mkdtemp(join(temporaryStorageRoot(), "rc-watch-"));
  const upstreamSocket = join(directory, "upstream.sock");
  const socketPath = join(directory, "docker.sock");
  const upstream = createServer((incoming, outgoing) => {
    if (incoming.url.startsWith("/v1.47/events")) {
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.flushHeaders();
    } else outgoing.end('[{"Id":"fixture-runtime"}]');
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
    await fetch(`${proxy.url}/online`, { method: "POST" });
    const stream = await unixResponse(socketPath, "/v1.47/events?since=1");
    assert.equal(stream.statusCode, 200);
    stream.on("error", () => {});
    const closed = new Promise((resolve) => stream.once("close", resolve));
    const disconnected = await fetch(`${proxy.url}/disconnect-watch`, {
      method: "POST",
    });
    assert.equal(disconnected.status, 200);
    await closed;
    assert.equal(await unixRequest(socketPath), '[{"Id":"fixture-runtime"}]');
    const rejected = await unixResponse(socketPath, "/v1.47/events?since=2");
    assert.equal(rejected.statusCode, 503);
    rejected.resume();
    const resumed = await fetch(`${proxy.url}/resume-watch`, {
      method: "POST",
    });
    assert.equal(resumed.status, 200);
    const recovered = await unixResponse(socketPath, "/v1.47/events?since=3");
    assert.equal(recovered.statusCode, 200);
    recovered.on("error", () => {});
    recovered.destroy();
  } finally {
    await proxy?.close();
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
