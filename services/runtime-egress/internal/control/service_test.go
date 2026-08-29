package control

import (
	"context"
	"net/netip"
	"testing"

	"soft/antnest-platform/services/runtime-egress/internal/egress"
	"soft/antnest-platform/services/runtime-egress/internal/protocol"
)

type fakeGateway struct {
	reserved       egress.Reservation
	released       egress.GenerationKey
	releasedExcept []egress.GenerationKey
	mode           string
}

func (f *fakeGateway) ReserveRuntime(value egress.Reservation) error {
	f.reserved = value
	return nil
}

func (f *fakeGateway) SetPolicy(_ egress.GenerationKey, mode string, _ uint64) error {
	f.mode = mode
	return nil
}

func (f *fakeGateway) ReleaseRuntime(_ context.Context, key egress.GenerationKey) error {
	f.released = key
	return nil
}

func (f *fakeGateway) ReleaseAgentExcept(_ context.Context, _ string, keep egress.GenerationKey) error {
	f.releasedExcept = append(f.releasedExcept, keep)
	return nil
}

func TestEnsureAppliesUnrestrictedReservation(t *testing.T) {
	gateway := &fakeGateway{}
	service, err := New(gateway)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	reservation := protocol.Reservation{
		GenerationKey: protocol.GenerationKey{RuntimeInstanceID: "runtime-1", Generation: 2},
		AgentID:       "agent-1", VirtualIP: netip.MustParseAddr("100.64.0.2"),
		AllocatorEpoch: 1, NetworkMode: protocol.NetworkUnrestricted,
		PolicyEpoch: 3, PolicyRevision: 3,
	}
	if err := service.Ensure(context.Background(), reservation); err != nil {
		t.Fatalf("Ensure() error = %v", err)
	}
	if gateway.reserved.AgentID != "agent-1" || gateway.mode != protocol.NetworkUnrestricted {
		t.Fatalf("unexpected Gateway state: %+v mode=%q", gateway.reserved, gateway.mode)
	}
}

func TestTunnelRecoveryRejectsOlderGeneration(t *testing.T) {
	gateway := &fakeGateway{}
	service, err := New(gateway)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	current := unrestrictedReservation(3)
	if err := service.Ensure(context.Background(), current); err != nil {
		t.Fatalf("Ensure() error = %v", err)
	}
	stale := unrestrictedReservation(2)
	if err := service.EnsureTunnel(context.Background(), stale); err == nil {
		t.Fatal("EnsureTunnel() accepted an older generation")
	}
	if gateway.reserved.Key.Generation != 3 {
		t.Fatalf("stale token changed reservation: %+v", gateway.reserved)
	}
}

func TestTunnelRecoveryReconstructsAndAdvancesGeneration(t *testing.T) {
	gateway := &fakeGateway{}
	service, err := New(gateway)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	if err := service.EnsureTunnel(context.Background(), unrestrictedReservation(2)); err != nil {
		t.Fatalf("reconstruct reservation: %v", err)
	}
	if err := service.EnsureTunnel(context.Background(), unrestrictedReservation(3)); err != nil {
		t.Fatalf("advance reservation: %v", err)
	}
	if gateway.reserved.Key.Generation != 3 {
		t.Fatalf("reservation generation = %d", gateway.reserved.Key.Generation)
	}
}

func unrestrictedReservation(generation uint64) protocol.Reservation {
	return protocol.Reservation{
		GenerationKey: protocol.GenerationKey{RuntimeInstanceID: "runtime-1", Generation: generation},
		AgentID:       "agent-1", VirtualIP: netip.MustParseAddr("100.64.0.2"),
		AllocatorEpoch: 1, NetworkMode: protocol.NetworkUnrestricted,
		PolicyEpoch: generation, PolicyRevision: generation,
	}
}
