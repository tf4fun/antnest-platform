"""Readiness-only UDP fixture. Never forwards traffic or calls external systems."""
import socket
import struct


def checksum(data):
    if len(data) % 2:
        data += b"\0"
    total = sum(struct.unpack("!%dH" % (len(data) // 2), data))
    while total >> 16:
        total = (total & 65535) + (total >> 16)
    return (~total) & 65535


sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.bind(("0.0.0.0", 8092))
while True:
    packet, peer = sock.recvfrom(65536)
    # Linux SYNs carry TCP options; the readiness probe uses a bare header.
    if len(packet) < 40 or packet[0] != 0x45 or packet[9] != 6 or not packet[33] & 2:
        continue
    reply = bytearray(40)
    reply[0], reply[8], reply[9] = 0x45, 64, 6
    reply[2:4] = struct.pack("!H", 40)
    reply[12:20] = packet[16:20] + packet[12:16]
    reply[20:24] = packet[22:24] + packet[20:22]
    reply[28:32] = struct.pack("!I", (struct.unpack("!I", packet[24:28])[0] + 1) & 0xFFFFFFFF)
    reply[32], reply[33] = 0x50, 0x14
    reply[10:12] = struct.pack("!H", checksum(reply[:20]))
    pseudo = reply[12:20] + bytes([0, 6, 0, 20])
    reply[36:38] = struct.pack("!H", checksum(pseudo + reply[20:]))
    sock.sendto(reply, peer)
