//go:build !linux

package egress

import (
	"context"
	"fmt"
	"net/netip"
)

type unsupportedDataPlane struct{}

func newPlatformDataPlane() packetDataPlane { return unsupportedDataPlane{} }

func (unsupportedDataPlane) Start(context.Context, netip.Prefix, int, func([]byte), func(error)) error {
	return fmt.Errorf("the Antnest L3 Gateway requires Linux TUN and NET_ADMIN: %w", ErrDataPlaneUnavailable)
}

func (unsupportedDataPlane) WritePacket([]byte) error {
	return ErrDataPlaneUnavailable
}

func (unsupportedDataPlane) SetDenied(context.Context, netip.Addr, bool) error {
	return ErrDataPlaneUnavailable
}

func (unsupportedDataPlane) Close() error { return nil }
