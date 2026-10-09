import assert from "node:assert/strict";
import { createServer } from "node:net";

export const DNS_FIXTURE_NAME = "egress-fixture.example.";
export const DNS_FIXTURE_IPV4 = "1.1.1.1";

export function dnsResponse(query) {
  assert(query.length >= 12 && query.length <= 4096);
  assert.equal(query.readUInt16BE(4), 1);
  assert.equal(query.readUInt16BE(2) & 0xf800, 0);
  let offset = 12;
  const labels = [];
  while (query[offset] !== 0) {
    const length = query[offset++];
    assert(length > 0 && length <= 63 && offset + length < query.length);
    labels.push(query.subarray(offset, offset + length).toString("ascii"));
    offset += length;
  }
  offset += 1;
  assert(offset + 4 <= query.length);
  assert.equal(query.readUInt16BE(offset + 2), 1);
  const answers =
    labels.join(".").toLowerCase() + "." === DNS_FIXTURE_NAME &&
    query.readUInt16BE(offset) === 1;
  const header = Buffer.alloc(12);
  header.writeUInt16BE(query.readUInt16BE(0), 0);
  header.writeUInt16BE(0x8080 | (query.readUInt16BE(2) & 0x0100), 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(answers ? 1 : 0, 6);
  const record = Buffer.concat([
    Buffer.from("c00c000100010000003c0004", "hex"),
    Buffer.from(DNS_FIXTURE_IPV4.split(".").map(Number)),
  ]);
  return Buffer.concat([
    header,
    query.subarray(12, offset + 4),
    ...(answers ? [record] : []),
  ]);
}

export function createNetworkDns() {
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.setTimeout(5000, () => socket.destroy());
    socket.on("error", () => socket.destroy());
    socket.on("close", () => sockets.delete(socket));
    let bytes = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      try {
        assert(bytes.length + chunk.length <= 8192);
        bytes = Buffer.concat([bytes, chunk]);
        while (bytes.length >= 2) {
          const length = bytes.readUInt16BE(0);
          assert(length >= 12 && length <= 4096);
          if (bytes.length < length + 2) break;
          const response = dnsResponse(bytes.subarray(2, length + 2));
          bytes = bytes.subarray(length + 2);
          const prefix = Buffer.alloc(2);
          prefix.writeUInt16BE(response.length);
          socket.write(Buffer.concat([prefix, response]));
        }
      } catch {
        socket.destroy();
      }
    });
  });
  return {
    server,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      if (server.listening)
        await new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
    },
  };
}
