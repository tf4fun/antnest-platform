import assert from "node:assert/strict";
import { once } from "node:events";
import { connect } from "node:net";
import test from "node:test";
import {
  createNetworkDns,
  DNS_FIXTURE_IPV4,
  DNS_FIXTURE_NAME,
  dnsResponse,
} from "./network-dns.mjs";

function query(type = 1) {
  const labels = DNS_FIXTURE_NAME.slice(0, -1).split(".");
  const header = Buffer.from("002401000001000000000000", "hex");
  return Buffer.concat([
    header,
    ...labels.flatMap((label) => [
      Buffer.from([label.length]),
      Buffer.from(label),
    ]),
    Buffer.from([0, 0, type, 0, 1]),
  ]);
}

test("offline DNS fixture returns only its public A answer with the original question and ID", () => {
  const request = query();
  const reply = dnsResponse(request);
  assert.equal(reply.readUInt16BE(0), 36);
  assert.equal(reply.readUInt16BE(2), 0x8180);
  assert.equal(reply.readUInt16BE(4), 1);
  assert.equal(reply.readUInt16BE(6), 1);
  assert.equal(reply.readUInt16BE(8), 0);
  assert.equal(reply.readUInt16BE(10), 0);
  assert.deepEqual(reply.subarray(12, request.length), request.subarray(12));
  assert.equal([...reply.subarray(-4)].join("."), DNS_FIXTURE_IPV4);
  assert.equal(dnsResponse(query(28)).readUInt16BE(6), 0);
  assert.throws(() => dnsResponse(Buffer.alloc(2)));
});

test(
  "offline DNS fixture carries multiple framed queries over one TCP connection",
  { timeout: 5000 },
  async () => {
    const fixture = createNetworkDns();
    let client;
    try {
      fixture.server.listen(0, "127.0.0.1");
      await once(fixture.server, "listening");
      client = connect(fixture.server.address().port, "127.0.0.1");
      await once(client, "connect");
      const request = query();
      const prefix = Buffer.alloc(2);
      prefix.writeUInt16BE(request.length);
      const wire = Buffer.concat([prefix, request]);
      const nextRequest = Buffer.from(request);
      nextRequest.writeUInt16BE(37, 0);
      const nextWire = Buffer.concat([prefix, nextRequest]);
      const response = dnsResponse(request);
      prefix.writeUInt16BE(response.length);
      const expected = Buffer.concat([prefix, response]);
      const nextExpected = Buffer.concat([prefix, dnsResponse(nextRequest)]);
      const replies = new Promise((resolve, reject) => {
        let bytes = Buffer.alloc(0);
        client.on("error", reject);
        client.on("data", (chunk) => {
          bytes = Buffer.concat([bytes, chunk]);
          if (bytes.length === expected.length * 2) resolve(bytes);
        });
      });
      client.write(Buffer.concat([wire, nextWire]));
      assert.deepEqual(await replies, Buffer.concat([expected, nextExpected]));
    } finally {
      client?.destroy();
      await fixture.close();
    }
  },
);
