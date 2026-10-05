// Hermetic packet-contract fixture: answer only Runtime's ordinary readiness
// SYN to 192.0.2.1:9. This neither runs Runtime Egress nor forwards user traffic.
import { createSocket } from "node:dgram";

function checksum(bytes) {
  let sum = 0;
  for (let index = 0; index < bytes.length; index += 2)
    sum += (bytes[index] << 8) | (bytes[index + 1] ?? 0);
  while (sum >>> 16) sum = (sum & 0xffff) + (sum >>> 16);
  return ~sum & 0xffff;
}
const socket = createSocket("udp4");
socket.on("message", (packet, peer) => {
  if (
    packet.length !== 40 ||
    packet[0] !== 0x45 ||
    packet[9] !== 6 ||
    !packet.subarray(16, 20).equals(Buffer.from([192, 0, 2, 1])) ||
    packet.readUInt16BE(22) !== 9 ||
    packet[33] !== 2
  )
    return;
  const reply = Buffer.alloc(40);
  reply[0] = 0x45;
  reply.writeUInt16BE(40, 2);
  reply.writeUInt16BE(0x4000, 6);
  reply[8] = 64;
  reply[9] = 6;
  packet.copy(reply, 12, 16, 20);
  packet.copy(reply, 16, 12, 16);
  packet.copy(reply, 20, 22, 24);
  packet.copy(reply, 22, 20, 22);
  reply.writeUInt32BE((packet.readUInt32BE(24) + 1) >>> 0, 28);
  reply[32] = 0x50;
  reply[33] = 0x14;
  reply.writeUInt16BE(checksum(reply.subarray(0, 20)), 10);
  const pseudo = Buffer.alloc(12);
  reply.copy(pseudo, 0, 12, 20);
  pseudo[9] = 6;
  pseudo.writeUInt16BE(20, 10);
  reply.writeUInt16BE(
    checksum(Buffer.concat([pseudo, reply.subarray(20)])),
    36,
  );
  socket.send(reply, peer.port, peer.address);
});
socket.on("error", () => {
  socket.close();
  process.exitCode = 1;
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => socket.close());
socket.bind(8092, "0.0.0.0");
