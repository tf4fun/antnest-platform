package ports

import "net/netip"

func ValidRuntimePeer(value string) bool {
	address, err := netip.ParseAddr(value)
	return err == nil && address.Is4() && address.IsGlobalUnicast() && address.String() == value
}
