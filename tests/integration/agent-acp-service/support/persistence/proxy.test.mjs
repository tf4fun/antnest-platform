import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("a failed control listener releases the already listening database proxy", () => {
  // Isolate the negative case so a leaked listener is terminated and joined even
  // before the startup cleanup fix exists.
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict';
    import net from 'node:net';
    import { once } from 'node:events';
    import { startProxy } from ${JSON.stringify(new URL("./proxy.mjs", import.meta.url).href)};
    const occupied = net.createServer();
    occupied.listen(0, '127.0.0.1');
    await once(occupied, 'listening');
    const reserved = net.createServer();
    reserved.listen(0, '127.0.0.1');
    await once(reserved, 'listening');
    const dbPort = reserved.address().port;
    await new Promise(resolve => reserved.close(resolve));
    try {
      await assert.rejects(startProxy({ host: '127.0.0.1', dbPort, httpPort: occupied.address().port }), { code: 'EADDRINUSE' });
      const rebound = net.createServer();
      rebound.listen(dbPort, '127.0.0.1');
      await once(rebound, 'listening');
      await new Promise(resolve => rebound.close(resolve));
    } finally {
      await new Promise(resolve => occupied.close(resolve));
    }
  `,
    ],
    { encoding: "utf8", timeout: 3000, killSignal: "SIGKILL" },
  );
  assert.equal(child.status, 0, child.stderr || String(child.error));
  assert.equal(child.signal, null);
});
