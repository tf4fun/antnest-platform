import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import { createServer as createTcpServer } from "node:net";
import { createServer as createHttpServer } from "node:http";

const [mode, raw = "{}"] = process.argv.slice(2);
const options = JSON.parse(raw);
function checksum(bytes) {
  let sum = 0;
  for (let offset = 0; offset < bytes.length; offset += 2)
    sum += (bytes[offset] << 8) + (bytes[offset + 1] ?? 0);
  while (sum > 65535) sum = (sum & 65535) + (sum >>> 16);
  return ~sum & 65535;
}
if (mode === "server") {
  let connections = 0;
  const tcp = createTcpServer((socket) => {
    connections++;
    socket.destroy();
  });
  const http = createHttpServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ connections }));
  });
  tcp.listen(9010, "0.0.0.0");
  http.listen(9050, "0.0.0.0");
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      tcp.close();
      http.close();
    });
} else if (mode === "count") {
  const response = await fetch("http://127.0.0.1:9050", {
    signal: AbortSignal.timeout(2000),
  });
  assert.equal(response.status, 200);
  process.stdout.write(JSON.stringify(await response.json()));
} else if (mode === "send") {
  const packet = Buffer.alloc(40);
  packet[0] = 0x45;
  packet.writeUInt16BE(40, 2);
  packet[8] = 64;
  packet[9] = 6;
  Buffer.from(options.source.split(".").map(Number)).copy(packet, 12);
  Buffer.from(options.destination.split(".").map(Number)).copy(packet, 16);
  packet.writeUInt16BE(options.sourcePort ?? 40000, 20);
  packet.writeUInt16BE(9010, 22);
  packet.writeUInt32BE(1, 24);
  packet[32] = 0x50;
  packet[33] = 2;
  packet.writeUInt16BE(8192, 34);
  packet.writeUInt16BE(checksum(packet.subarray(0, 20)), 10);
  packet.writeUInt16BE(
    checksum(
      Buffer.concat([
        packet.subarray(12, 20),
        Buffer.from([0, 6, 0, 20]),
        packet.subarray(20),
      ]),
    ),
    36,
  );
  const socket = createSocket("udp4");
  try {
    await new Promise((resolve, reject) => {
      socket.once("error", reject);
      socket.send(packet, 8092, process.env.EGRESS_AUTH_PACKET_IP, (error) =>
        error ? reject(error) : resolve(),
      );
    });
    process.stdout.write(JSON.stringify({ sent: true }));
  } finally {
    socket.close();
  }
} else throw new Error("unknown peer proof mode");
