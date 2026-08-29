package egress

import (
	"context"
	"net/netip"
	"strings"
)

type packetDataPlane interface {
	Start(context.Context, netip.Prefix, int, func([]byte), func(error)) error
	WritePacket([]byte) error
	SetDenied(context.Context, netip.Addr, bool) error
	Close() error
}

func conntrackOutputHasFlow(output string) bool {
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if strings.Contains(line, "src=") && strings.Contains(line, "dst=") {
			return true
		}
	}
	return false
}
