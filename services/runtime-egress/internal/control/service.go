package control

import (
	"context"
	"fmt"
	"sync"

	"soft/antnest-platform/services/runtime-egress/internal/egress"
	"soft/antnest-platform/services/runtime-egress/internal/protocol"
)

type Gateway interface {
	ReserveRuntime(egress.Reservation) error
	SetPolicy(egress.GenerationKey, string, uint64) error
	ReleaseRuntime(context.Context, egress.GenerationKey) error
	ReleaseAgentExcept(context.Context, string, egress.GenerationKey) error
}

type Service struct {
	gateway Gateway
	mu      sync.Mutex
	active  map[string]protocol.Reservation
}

func New(gateway Gateway) (*Service, error) {
	if gateway == nil {
		return nil, fmt.Errorf("egress Gateway is required")
	}
	return &Service{gateway: gateway, active: make(map[string]protocol.Reservation)}, nil
}

func (s *Service) Ensure(ctx context.Context, reservation protocol.Reservation) error {
	if err := reservation.Validate(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.ensureLocked(ctx, reservation)
}

// EnsureTunnel reconstructs process-local state after an Egress restart while
// preventing a still-live token for an older generation from replacing newer
// Controller intent.
func (s *Service) EnsureTunnel(ctx context.Context, reservation protocol.Reservation) error {
	if err := reservation.Validate(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if current, ok := s.active[reservation.AgentID]; ok && !sameReservation(current, reservation) &&
		!newerReservation(current, reservation) {
		return fmt.Errorf("Runtime egress token is stale")
	}
	return s.ensureLocked(ctx, reservation)
}

func (s *Service) ensureLocked(ctx context.Context, reservation protocol.Reservation) error {
	key := egress.GenerationKey{
		RuntimeInstanceID: reservation.RuntimeInstanceID,
		Generation:        reservation.Generation,
	}
	if err := s.gateway.ReleaseAgentExcept(ctx, reservation.AgentID, key); err != nil {
		return fmt.Errorf("release stale Agent reservations: %w", err)
	}
	if err := s.gateway.ReserveRuntime(egress.Reservation{
		Key:            key,
		AgentID:        reservation.AgentID,
		VirtualIP:      reservation.VirtualIP,
		AllocatorEpoch: reservation.AllocatorEpoch,
		NetworkMode:    reservation.NetworkMode,
		PolicyEpoch:    reservation.PolicyEpoch,
	}); err != nil {
		return fmt.Errorf("reserve Runtime egress: %w", err)
	}
	if err := s.gateway.SetPolicy(key, reservation.NetworkMode, reservation.PolicyEpoch); err != nil {
		return fmt.Errorf("apply Runtime egress policy: %w", err)
	}
	s.active[reservation.AgentID] = reservation
	return nil
}

func (s *Service) Release(ctx context.Context, key protocol.GenerationKey) error {
	if err := key.Validate(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.gateway.ReleaseRuntime(ctx, egress.GenerationKey(key)); err != nil {
		return err
	}
	for agentID, reservation := range s.active {
		if reservation.GenerationKey == key {
			delete(s.active, agentID)
		}
	}
	return nil
}

func sameReservation(left, right protocol.Reservation) bool {
	return left.GenerationKey == right.GenerationKey && left.AgentID == right.AgentID &&
		left.VirtualIP == right.VirtualIP && left.AllocatorEpoch == right.AllocatorEpoch &&
		left.NetworkMode == right.NetworkMode && left.PolicyEpoch == right.PolicyEpoch &&
		left.PolicyRevision == right.PolicyRevision
}

func newerReservation(current, candidate protocol.Reservation) bool {
	if current.AgentID != candidate.AgentID {
		return false
	}
	if current.RuntimeInstanceID == candidate.RuntimeInstanceID {
		return candidate.Generation > current.Generation
	}
	return candidate.AllocatorEpoch > current.AllocatorEpoch
}
