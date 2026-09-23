import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { connect } from "node:net";
import { createNetworkTarget } from "./network-target.mjs";

test(
  "a peer TCP reset must not terminate the fixture process/readline handler",
  { timeout: 5000 },
  async () => {
    const target = createNetworkTarget();
    let socket;
    try {
      target.tcp.listen(0, "127.0.0.1");
      await once(target.tcp, "listening");
      target.http.listen(0, "127.0.0.1");
      await once(target.http, "listening");
      socket = connect(target.tcp.address().port, "127.0.0.1");
      await once(socket, "connect");
      const reply = once(socket, "data");
      socket.write('{"phase":"held-a","nonce":"abc123"}\n');
      await reply;
      const closed = once(socket, "close");
      socket.resetAndDestroy();
      await closed;
      const response = await fetch(
        `http://127.0.0.1:${target.http.address().port}/status`,
        { signal: AbortSignal.timeout(2000) },
      );
      assert.equal(response.status, 200);
      assert.deepEqual((await response.json()).errors, []);
    } finally {
      socket?.destroy();
      await target.close();
    }
  },
);
