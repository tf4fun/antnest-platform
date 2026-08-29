package tunnel

import (
	"encoding/binary"
	"fmt"

	egressgateway "soft/antnest-platform/services/runtime-egress/internal/egress"
)

const (
	packetFrameVersion = 1
	packetFrameHeader  = 12
	maxPacketCount     = 64
)

type PacketBatch = egressgateway.PacketBatch

func EncodePacketBatch(batch PacketBatch, mtu int) ([]byte, error) {
	if err := validatePacketBatch(batch, mtu); err != nil {
		return nil, err
	}
	size := packetFrameHeader
	for _, packet := range batch.Packets {
		size += 2 + len(packet)
	}
	encoded := make([]byte, size)
	encoded[0] = packetFrameVersion
	binary.BigEndian.PutUint64(encoded[2:10], batch.PolicyEpoch)
	binary.BigEndian.PutUint16(encoded[10:12], uint16(len(batch.Packets)))
	offset := packetFrameHeader
	for _, packet := range batch.Packets {
		binary.BigEndian.PutUint16(encoded[offset:offset+2], uint16(len(packet)))
		offset += 2
		copy(encoded[offset:], packet)
		offset += len(packet)
	}
	return encoded, nil
}

func DecodePacketBatch(frame []byte, expectedPolicyEpoch uint64, mtu int) (PacketBatch, error) {
	if len(frame) < packetFrameHeader {
		return PacketBatch{}, fmt.Errorf("runtime packet frame is truncated")
	}
	if frame[0] != packetFrameVersion || frame[1] != 0 {
		return PacketBatch{}, fmt.Errorf("runtime packet frame version or flags are invalid")
	}
	batch := PacketBatch{
		PolicyEpoch: binary.BigEndian.Uint64(frame[2:10]),
		Packets:     make([][]byte, 0, binary.BigEndian.Uint16(frame[10:12])),
	}
	if batch.PolicyEpoch != expectedPolicyEpoch {
		return PacketBatch{}, fmt.Errorf("runtime packet frame policy epoch is stale")
	}
	count := int(binary.BigEndian.Uint16(frame[10:12]))
	if count == 0 || count > maxPacketCount {
		return PacketBatch{}, fmt.Errorf("runtime packet frame count is invalid")
	}
	offset := packetFrameHeader
	for range count {
		if offset+2 > len(frame) {
			return PacketBatch{}, fmt.Errorf("runtime packet length is truncated")
		}
		size := int(binary.BigEndian.Uint16(frame[offset : offset+2]))
		offset += 2
		if size == 0 || offset+size > len(frame) {
			return PacketBatch{}, fmt.Errorf("runtime packet payload is truncated")
		}
		packet := append([]byte(nil), frame[offset:offset+size]...)
		offset += size
		if err := validateIPv4TCPPacket(packet, mtu); err != nil {
			return PacketBatch{}, err
		}
		batch.Packets = append(batch.Packets, packet)
	}
	if offset != len(frame) {
		return PacketBatch{}, fmt.Errorf("runtime packet frame has trailing bytes")
	}
	return batch, nil
}

func validatePacketBatch(batch PacketBatch, mtu int) error {
	if batch.PolicyEpoch == 0 || len(batch.Packets) == 0 || len(batch.Packets) > maxPacketCount {
		return fmt.Errorf("runtime packet batch identity or count is invalid")
	}
	for _, packet := range batch.Packets {
		if err := validateIPv4TCPPacket(packet, mtu); err != nil {
			return err
		}
	}
	return nil
}

func validateIPv4TCPPacket(packet []byte, mtu int) error {
	if mtu <= 0 || mtu > 65535 || len(packet) < 20 || len(packet) > mtu || len(packet) > 65535 {
		return fmt.Errorf("runtime packet size is invalid")
	}
	if packet[0]>>4 != 4 {
		return fmt.Errorf("runtime tunnel only accepts IPv4 packets")
	}
	headerLength := int(packet[0]&0x0f) * 4
	if headerLength < 20 || headerLength > len(packet) {
		return fmt.Errorf("runtime IPv4 header length is invalid")
	}
	if int(binary.BigEndian.Uint16(packet[2:4])) != len(packet) {
		return fmt.Errorf("runtime IPv4 total length does not match packet size")
	}
	if packet[9] != 6 {
		return fmt.Errorf("runtime tunnel only accepts TCP packets")
	}
	fragment := binary.BigEndian.Uint16(packet[6:8])
	if fragment&0x3fff != 0 {
		return fmt.Errorf("runtime tunnel rejects fragmented IPv4 packets")
	}
	return nil
}
