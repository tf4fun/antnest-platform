package tunnel

import (
	"encoding/binary"
	"testing"
)

func TestPacketBatchCodecRejectsProtocolAmbiguity(t *testing.T) {
	packet := validIPv4TCPPacket(24)
	encoded, err := EncodePacketBatch(PacketBatch{PolicyEpoch: 7, Packets: [][]byte{packet}}, 1400)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := DecodePacketBatch(encoded, 7, 1400)
	if err != nil || len(decoded.Packets) != 1 || len(decoded.Packets[0]) != len(packet) {
		t.Fatalf("decode valid packet batch: batch=%#v err=%v", decoded, err)
	}
	tests := []struct {
		name  string
		frame []byte
		epoch uint64
	}{
		{name: "stale epoch", frame: encoded, epoch: 8},
		{name: "trailing bytes", frame: append(append([]byte(nil), encoded...), 0), epoch: 7},
		{name: "unknown flags", frame: mutateByte(encoded, 1, 1), epoch: 7},
		{name: "udp", frame: replacePacket(encoded, validIPv4Packet(24, 17, 0)), epoch: 7},
		{name: "fragment", frame: replacePacket(encoded, validIPv4Packet(24, 6, 1)), epoch: 7},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := DecodePacketBatch(test.frame, test.epoch, 1400); err == nil {
				t.Fatal("invalid Runtime packet frame was accepted")
			}
		})
	}
}

func validIPv4TCPPacket(size int) []byte {
	return validIPv4Packet(size, 6, 0)
}

func validIPv4Packet(size int, protocol byte, fragment uint16) []byte {
	packet := make([]byte, size)
	packet[0] = 0x45
	binary.BigEndian.PutUint16(packet[2:4], uint16(size))
	binary.BigEndian.PutUint16(packet[6:8], fragment)
	packet[8] = 64
	packet[9] = protocol
	return packet
}

func mutateByte(input []byte, offset int, value byte) []byte {
	cloned := append([]byte(nil), input...)
	cloned[offset] = value
	return cloned
}

func replacePacket(frame []byte, packet []byte) []byte {
	cloned := append([]byte(nil), frame...)
	copy(cloned[packetFrameHeader+2:], packet)
	return cloned
}
