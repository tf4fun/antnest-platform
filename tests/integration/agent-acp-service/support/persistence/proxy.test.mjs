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

test("both proxy TCP directions disable Nagle before forwarding PostgreSQL frames", () => {
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
    const directions = new Map(), enabled = new WeakMap(), firstWrites = new Map();
    const sockets = new Set(), closed = [], reads = [], socketErrors = [], failures = [];
    const originalNoDelay = net.Socket.prototype.setNoDelay;
    const originalWrite = net.Socket.prototype.write;
    const originalConnect = net.createConnection;
    const observe = socket => {
      if (sockets.has(socket)) return socket;
      sockets.add(socket);
      closed.push(new Promise(resolve => socket.once('close', resolve)));
      socket.on('error', error => socketErrors.push(error));
      return socket;
    };
    net.Socket.prototype.setNoDelay = function (...args) {
      const result = Reflect.apply(originalNoDelay, this, args);
      enabled.set(this, args[0] === undefined || args[0] === true);
      return result;
    };
    net.Socket.prototype.write = function (...args) {
      if (directions.has(this) && !firstWrites.has(this))
        firstWrites.set(this, enabled.get(this) === true);
      return Reflect.apply(originalWrite, this, args);
    };
    const integer = value => {
      const bytes = Buffer.alloc(4);
      bytes.writeInt32BE(value);
      return bytes;
    };
    const text = value => Buffer.concat([Buffer.from(value), Buffer.from([0])]);
    const frame = (type, body) => Buffer.concat([Buffer.from(type), integer(body.length + 4), body]);
    const parameters = Buffer.concat([integer(196608), text('user'), text('proxy_test'), text('database'), text('proxy_test'), Buffer.from([0])]);
    const startup = Buffer.concat([integer(parameters.length + 4), parameters]);
    const startupResult = Buffer.concat([frame('R', integer(0)), frame('Z', Buffer.from('I'))]);
    const query = frame('Q', text("SET application_name TO 'proxy-no-delay'"));
    const result = Buffer.concat([frame('C', text('SET')), frame('Z', Buffer.from('I'))]);
    const receive = (socket, expected) => {
      const task = new Promise((resolve, reject) => {
        let bytes = Buffer.alloc(0);
        const cleanup = () => {
          socket.removeListener('data', data);
          socket.removeListener('close', ended);
          socket.removeListener('error', failed);
        };
        const failed = error => { cleanup(); reject(error); };
        const ended = () => failed(new Error('Socket closed before the complete PostgreSQL response'));
        const data = chunk => {
          bytes = Buffer.concat([bytes, chunk]);
          if (bytes.length < expected.length) return;
          cleanup();
          try { assert.deepEqual(bytes, expected); resolve(); }
          catch (error) { reject(error); }
        };
        socket.on('data', data);
        socket.once('close', ended);
        socket.once('error', failed);
      });
      reads.push(task);
      void task.catch(() => {});
      return task;
    };
    const write = (socket, bytes) => new Promise((resolve, reject) =>
      socket.write(bytes, error => error ? reject(error) : resolve()));
    const accepted = Promise.withResolvers();
    const upstream = net.createServer(socket => accepted.resolve(observe(socket)));
    let proxy;
    try {
      upstream.listen(0, '127.0.0.1');
      await once(upstream, 'listening');
      const upstreamPort = upstream.address().port;
      net.createConnection = function (...args) {
        const socket = Reflect.apply(originalConnect, this, args);
        if (args[0]?.port === upstreamPort) {
          directions.set(socket, 'upstream');
          observe(socket);
        }
        return socket;
      };
      proxy = await startProxy({ upstreamHost: '127.0.0.1', upstreamPort, host: '127.0.0.1', dbPort: 0, httpPort: 0 });
      proxy.tcp.on('connection', socket => {
        directions.set(socket, 'downstream');
        observe(socket);
      });
      const client = observe(new net.Socket());
      client.connect(proxy.tcp.address().port, '127.0.0.1');
      await once(client, 'connect');
      const server = await accepted.promise;
      let forwarded = receive(server, startup);
      let returned = receive(client, startupResult);
      await write(client, startup);
      await forwarded;
      await write(server, startupResult);
      await returned;
      forwarded = receive(server, query);
      returned = receive(client, result);
      await write(client, query);
      await forwarded;
      await write(server, result);
      await returned;
      assert.equal(directions.size, 2);
      assert.equal(firstWrites.size, 2);
      assert.deepEqual(
        [...directions].map(([socket, direction]) => ({ direction, noDelay: firstWrites.get(socket) })).sort((a, b) => a.direction.localeCompare(b.direction)),
        [{ direction: 'downstream', noDelay: true }, { direction: 'upstream', noDelay: true }],
        'both proxy sockets must disable Nagle before their first forwarded bytes',
      );
    } catch (error) {
      failures.push(error);
    } finally {
      for (const socket of sockets) socket.destroy();
      if (proxy) {
        try { await proxy.close(); } catch (error) { failures.push(error); }
      }
      if (upstream.listening) {
        try { await new Promise((resolve, reject) => upstream.close(error => error ? reject(error) : resolve())); }
        catch (error) { failures.push(error); }
      }
      const outcomes = await Promise.allSettled([...reads, ...closed]);
      for (const outcome of outcomes) if (outcome.status === 'rejected') failures.push(outcome.reason);
      net.createConnection = originalConnect;
      net.Socket.prototype.setNoDelay = originalNoDelay;
      net.Socket.prototype.write = originalWrite;
      failures.push(...socketErrors);
    }
    if (failures.length) throw new AggregateError(failures, 'Proxy TCP forwarding or original cleanup failed');
    assert.equal(upstream.listening, false);
    assert.equal(proxy.tcp.listening, false);
    assert.equal(proxy.http.listening, false);
    for (const socket of sockets) assert.equal(socket.closed, true);
`,
    ],
    { encoding: "utf8", timeout: 5000, killSignal: "SIGKILL" },
  );
  assert.equal(child.status, 0, child.stderr || String(child.error));
  assert.equal(child.signal, null);
});
