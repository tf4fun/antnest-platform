package ports

import "net/netip"

func ValidRuntimePeer(value string) bool {
	address, err := netip.ParseAddr(value)
	return err == nil && address.Is4() && address.IsGlobalUnicast() && address.String() == value
}

// The selector is public metadata, but must preserve the RC-issued exact identity.
func ValidTunnelKeyID(value string) bool {
	if len(value) != 36 || value[:4] != "rtk_" {
		return false
	}
	for _, b := range value[4:] {
		if (b < '0' || b > '9') && (b < 'a' || b > 'f') {
			return false
		}
	}
	return true
}
