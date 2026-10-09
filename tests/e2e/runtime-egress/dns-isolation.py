import os
import socket
import struct
import subprocess
import sys


DEADLINE = 2
EMBEDDED_RESOLVER = ("127.0.0.11", 53)


def read_exact(stream, length):
    chunks = bytearray()
    while len(chunks) < length:
        chunk = stream.recv(length - len(chunks))
        if not chunk:
            raise ConnectionError("DNS connection closed")
        chunks.extend(chunk)
    return bytes(chunks)


def embedded_query(transport):
    labels = b"".join(
        bytes([len(label)]) + label.encode("ascii")
        for label in "runtime-controller".split(".")
    ) + b"\x00"
    query = struct.pack("!6H", 36, 0x0100, 1, 0, 0, 0) + labels + struct.pack("!2H", 1, 1)
    kind = socket.SOCK_STREAM if transport == "tcp" else socket.SOCK_DGRAM
    with socket.socket(socket.AF_INET, kind) as stream:
        stream.settimeout(DEADLINE)
        stream.connect(EMBEDDED_RESOLVER)
        if transport == "tcp":
            stream.sendall(struct.pack("!H", len(query)) + query)
            length = struct.unpack("!H", read_exact(stream, 2))[0]
            assert 12 <= length <= 4096, "Invalid embedded DNS frame"
            return read_exact(stream, length)
        stream.sendall(query)
        return stream.recv(4096)


def check_embedded_resolver(control):
    for transport in ("tcp", "udp"):
        try:
            response = embedded_query(transport)
        except (TimeoutError, ConnectionError):
            assert not control, "Root control query must reach embedded DNS"
            continue
        except OSError as error:
            assert not control, "Root control query must reach embedded DNS"
            assert error.errno in (1, 13, 101, 113), "Unexpected DNS socket failure"
            continue
        assert control, f"Unprivileged {transport} query reached embedded DNS"
        identity, flags, _, answers, _, _ = struct.unpack("!6H", response[:12])
        assert identity == 36 and flags & 0x8000 and flags & 0xF == 0
        assert answers > 0, "Root control query must resolve the internal service"


def check_lookup(name, succeeds):
    result = subprocess.run(
        ["getent", "hosts", name], capture_output=True, timeout=15, check=False
    )
    if succeeds:
        assert result.returncode == 0 and result.stdout.strip(), "Public DNS lookup failed"
    else:
        assert result.returncode == 2 and not result.stdout.strip(), "Internal DNS lookup succeeded"


def check_loopback():
    payload = b"loopback"
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.settimeout(DEADLINE)
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        with socket.create_connection(listener.getsockname(), timeout=DEADLINE) as client:
            peer, _ = listener.accept()
            with peer:
                peer.settimeout(DEADLINE)
                client.sendall(payload)
                assert read_exact(peer, len(payload)) == payload
                peer.sendall(payload)
                assert read_exact(client, len(payload)) == payload
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as listener:
        listener.settimeout(DEADLINE)
        listener.bind(("127.0.0.1", 0))
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as client:
            client.settimeout(DEADLINE)
            client.sendto(payload, listener.getsockname())
            received, address = listener.recvfrom(64)
            assert received == payload
            listener.sendto(received, address)
            assert client.recv(64) == payload


def main():
    control = sys.argv[1:] == ["control"]
    if control:
        assert os.getuid() == 0, "Embedded DNS control must run as root"
    else:
        assert len(sys.argv) == 3 and sys.argv[1] == "agent", "Expected control or agent probe mode"
        assert os.getuid() in (1000, 2000, 2007), "Probe must run as an Executor or tool UID"
        check_lookup("postgres", False)
        check_lookup("runtime-controller", False)
        # Docker's embedded resolver answers PTR for every container on Egress networks.
        check_lookup(sys.argv[2], False)
        check_lookup("example.com", True)
        check_loopback()
    check_embedded_resolver(control)
    print("DNS isolation control passed" if control else "Agent DNS isolation passed")


if __name__ == "__main__":
    main()

