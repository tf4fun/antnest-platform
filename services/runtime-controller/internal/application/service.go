package application

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"net/netip"
	"time"

	"soft/antnest-platform/services/runtime-controller/internal/domain"
)

var ErrNotFound = errors.New("not found")

type Repository interface {
	Transact(context.Context, func(Transaction) error) error
	GetRuntime(context.Context, string) (domain.Runtime, error)
	GetGeneration(context.Context, string, uint64) (domain.RuntimeGeneration, error)
	GetOpenOperation(context.Context, string, uint64) (domain.Operation, error)
	GetOperation(context.Context, string) (domain.Operation, error)
	FindGenerationByInstanceID(context.Context, string) (domain.RuntimeGeneration, error)
	ListReadyRuntimeIDs(context.Context) ([]string, error)
	ListReconcileCandidates(context.Context, time.Time, int) ([]string, error)
}

func (s *Service) GetRuntime(ctx context.Context, agentID string) (domain.Runtime, error) {
	return s.repository.GetRuntime(ctx, agentID)
}

func (s *Service) GetOperation(ctx context.Context, operationID string) (domain.Operation, error) {
	return s.repository.GetOperation(ctx, operationID)
}

type Transaction interface {
	GetRuntime(context.Context, string) (domain.Runtime, error)
	GetGeneration(context.Context, string, uint64) (domain.RuntimeGeneration, error)
	GetOpenOperation(context.Context, string, uint64) (domain.Operation, error)
	GetOperationByIdempotencyKey(context.Context, domain.OperationKind, string, string) (domain.Operation, error)
	NextNetworkOffset(context.Context) (uint64, uint64, error)
	SaveRuntime(context.Context, domain.Runtime) error
	SaveGeneration(context.Context, domain.RuntimeGeneration) error
	SaveOperation(context.Context, domain.Operation) error
}

type ReconcileSignal interface {
	Notify(context.Context, string)
}

type IDGenerator interface {
	NewID() string
}

type Service struct {
	repository Repository
	signal     ReconcileSignal
	ids        IDGenerator
	now        func() time.Time
	tunnelCIDR netip.Prefix
}

func NewService(repository Repository, signal ReconcileSignal, ids IDGenerator, now func() time.Time) (*Service, error) {
	return NewServiceWithTunnelCIDR(repository, signal, ids, now, "100.64.0.0/10")
}

func NewServiceWithTunnelCIDR(
	repository Repository,
	signal ReconcileSignal,
	ids IDGenerator,
	now func() time.Time,
	tunnelCIDR string,
) (*Service, error) {
	if repository == nil {
		return nil, fmt.Errorf("runtime repository is required")
	}
	if signal == nil {
		return nil, fmt.Errorf("reconcile signal is required")
	}
	if ids == nil {
		return nil, fmt.Errorf("id generator is required")
	}
	if now == nil {
		return nil, fmt.Errorf("clock is required")
	}
	prefix, err := netip.ParsePrefix(tunnelCIDR)
	if err != nil || !prefix.Addr().Is4() || prefix != prefix.Masked() || prefix.Bits() > 30 {
		return nil, fmt.Errorf("tunnel CIDR must be a canonical IPv4 prefix with usable hosts")
	}
	return &Service{
		repository: repository, signal: signal, ids: ids, now: now, tunnelCIDR: prefix,
	}, nil
}

type PrepareInput struct {
	AgentID        string
	ImageRef       string
	NetworkMode    domain.NetworkMode
	IdempotencyKey string
}

type PrepareResult = domain.PreparePlan

func (s *Service) Prepare(ctx context.Context, input PrepareInput) (PrepareResult, error) {
	var result domain.PreparePlan
	err := s.repository.Transact(ctx, func(tx Transaction) error {
		current, currentErr := tx.GetRuntime(ctx, input.AgentID)
		if currentErr != nil && !errors.Is(currentErr, ErrNotFound) {
			return currentErr
		}
		var currentPtr *domain.Runtime
		if currentErr == nil {
			currentPtr = &current
		}

		existing, operationErr := tx.GetOperationByIdempotencyKey(
			ctx, domain.OperationPrepare, input.AgentID, input.IdempotencyKey,
		)
		if operationErr != nil && !errors.Is(operationErr, ErrNotFound) {
			return operationErr
		}
		var existingPtr *domain.Operation
		operationID := ""
		if operationErr == nil {
			existingPtr = &existing
		} else {
			operationID = s.ids.NewID()
		}

		planned, planErr := domain.PlanPrepare(currentPtr, existingPtr, domain.PrepareCommand{
			AgentID: input.AgentID, ImageRef: input.ImageRef, NetworkMode: input.NetworkMode,
			IdempotencyKey: input.IdempotencyKey, OperationID: operationID, Now: s.now(),
		})
		if planErr != nil {
			return planError(planErr)
		}
		result = planned
		if planned.Replayed {
			return nil
		}
		if currentPtr != nil && currentPtr.DesiredGeneration > 0 {
			if err := supersedeOpenOperation(
				ctx, tx, currentPtr.AgentID, currentPtr.DesiredGeneration,
				planned.Operation.ID, commandTime(planned.Operation),
			); err != nil {
				return err
			}
		}
		if err := tx.SaveRuntime(ctx, planned.Runtime); err != nil {
			return err
		}
		if planned.Generation != nil {
			if err := s.allocateGeneration(ctx, tx, planned.Generation); err != nil {
				return err
			}
			result = planned
		}
		return tx.SaveOperation(ctx, planned.Operation)
	})
	if err != nil {
		return PrepareResult{}, err
	}
	if !result.Replayed {
		s.signal.Notify(ctx, result.Runtime.AgentID)
	}
	return result, nil
}

func addressAt(prefix netip.Prefix, offset uint64) (netip.Addr, error) {
	host := offset + 1 // offset zero and the first host are reserved for network and DNS.
	hostBits := 32 - prefix.Bits()
	capacity := uint64(1) << hostBits
	if host >= capacity-1 {
		return netip.Addr{}, fmt.Errorf("runtime tunnel address pool is exhausted")
	}
	bytes := prefix.Addr().As4()
	value := uint64(binary.BigEndian.Uint32(bytes[:])) + host
	var result [4]byte
	binary.BigEndian.PutUint32(result[:], uint32(value))
	address := netip.AddrFrom4(result)
	if !prefix.Contains(address) {
		return netip.Addr{}, fmt.Errorf("allocated tunnel address is outside configured prefix")
	}
	return address, nil
}

type LifecycleInput struct {
	AgentID        string
	IdempotencyKey string
}

func (s *Service) Stop(ctx context.Context, input LifecycleInput) (domain.LifecyclePlan, error) {
	return s.changeLifecycle(ctx, domain.OperationStop, input)
}

func (s *Service) Retire(ctx context.Context, input LifecycleInput) (domain.LifecyclePlan, error) {
	return s.changeLifecycle(ctx, domain.OperationRetire, input)
}

func (s *Service) Purge(ctx context.Context, input LifecycleInput) (domain.LifecyclePlan, error) {
	return s.changeLifecycle(ctx, domain.OperationPurge, input)
}

func (s *Service) changeLifecycle(
	ctx context.Context, kind domain.OperationKind, input LifecycleInput,
) (domain.LifecyclePlan, error) {
	var result domain.LifecyclePlan
	err := s.repository.Transact(ctx, func(tx Transaction) error {
		current, err := tx.GetRuntime(ctx, input.AgentID)
		if err != nil {
			return err
		}
		existing, err := optionalOperation(ctx, tx, kind, input.AgentID, input.IdempotencyKey)
		if err != nil {
			return err
		}
		operationID := ""
		if existing == nil {
			operationID = s.ids.NewID()
		}
		planned, err := domain.PlanLifecycle(current, existing, domain.LifecycleCommand{
			AgentID: input.AgentID, Kind: kind, IdempotencyKey: input.IdempotencyKey,
			OperationID: operationID, Now: s.now(),
		})
		if err != nil {
			return planError(err)
		}
		result = planned
		if planned.Replayed {
			return nil
		}
		if err := supersedeOpenOperation(
			ctx, tx, current.AgentID, current.DesiredGeneration,
			planned.Operation.ID, commandTime(planned.Operation),
		); err != nil {
			return err
		}
		if err := tx.SaveRuntime(ctx, planned.Runtime); err != nil {
			return err
		}
		return tx.SaveOperation(ctx, planned.Operation)
	})
	if err != nil {
		return domain.LifecyclePlan{}, err
	}
	if !result.Replayed {
		s.signal.Notify(ctx, input.AgentID)
	}
	return result, nil
}

func (s *Service) allocateGeneration(
	ctx context.Context, tx Transaction, generation *domain.RuntimeGeneration,
) error {
	offset, allocatorEpoch, err := tx.NextNetworkOffset(ctx)
	if err != nil {
		return err
	}
	address, err := addressAt(s.tunnelCIDR, offset)
	if err != nil {
		return err
	}
	generation.TunnelIPv4 = address.String()
	generation.AllocatorEpoch = allocatorEpoch
	generation.RuntimeInstanceID = domain.RuntimeInstanceID(generation.AgentID, generation.Number)
	return tx.SaveGeneration(ctx, *generation)
}

type NetworkPolicyInput struct {
	AgentID        string
	NetworkMode    domain.NetworkMode
	IdempotencyKey string
}

func (s *Service) UpdateNetworkPolicy(
	ctx context.Context, input NetworkPolicyInput,
) (domain.NetworkPolicyPlan, error) {
	var result domain.NetworkPolicyPlan
	err := s.repository.Transact(ctx, func(tx Transaction) error {
		current, err := tx.GetRuntime(ctx, input.AgentID)
		if err != nil {
			return err
		}
		existing, err := optionalOperation(
			ctx, tx, domain.OperationUpdateNetwork, input.AgentID, input.IdempotencyKey,
		)
		if err != nil {
			return err
		}
		operationID := ""
		if existing == nil {
			operationID = s.ids.NewID()
		}
		previousGeneration := current.DesiredGeneration
		planned, err := domain.PlanNetworkPolicy(current, existing, domain.NetworkPolicyCommand{
			AgentID: input.AgentID, NetworkMode: input.NetworkMode,
			IdempotencyKey: input.IdempotencyKey, OperationID: operationID, Now: s.now(),
		})
		if err != nil {
			return planError(err)
		}
		result = planned
		if planned.Replayed {
			return nil
		}
		if previousGeneration > 0 {
			if err := supersedeOpenOperation(
				ctx, tx, current.AgentID, previousGeneration,
				planned.Operation.ID, commandTime(planned.Operation),
			); err != nil {
				return err
			}
		}
		if err := tx.SaveRuntime(ctx, planned.Runtime); err != nil {
			return err
		}
		if planned.Generation != nil {
			if err := s.allocateGeneration(ctx, tx, planned.Generation); err != nil {
				return err
			}
			result = planned
		}
		return tx.SaveOperation(ctx, planned.Operation)
	})
	if err != nil {
		return domain.NetworkPolicyPlan{}, err
	}
	if !result.Replayed && result.Operation.Status != domain.OperationSucceeded {
		s.signal.Notify(ctx, input.AgentID)
	}
	return result, nil
}

func supersedeOpenOperation(
	ctx context.Context,
	tx Transaction,
	agentID string,
	generation uint64,
	replacementID string,
	now time.Time,
) error {
	operation, err := tx.GetOpenOperation(ctx, agentID, generation)
	if errors.Is(err, ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if operation.ID == replacementID {
		return nil
	}
	if operation.Status == domain.OperationRunning || operation.Status == domain.OperationUnknown {
		return fmt.Errorf("%w: operation %s is already dispatched", domain.ErrConcurrentWrite, operation.ID)
	}
	operation.Status = domain.OperationSuperseded
	operation.ErrorCode = "superseded"
	operation.ErrorDetail = "replaced by operation " + replacementID
	operation.UpdatedAt = now.UTC()
	return tx.SaveOperation(ctx, operation)
}

func commandTime(operation domain.Operation) time.Time {
	if operation.UpdatedAt.IsZero() {
		return time.Now().UTC()
	}
	return operation.UpdatedAt.UTC()
}

func planError(err error) error {
	if errors.Is(err, domain.ErrIdempotencyConflict) ||
		errors.Is(err, domain.ErrGenerationFenced) ||
		errors.Is(err, domain.ErrConcurrentWrite) {
		return err
	}
	return fmt.Errorf("%w: %v", domain.ErrInvalidArgument, err)
}

type ConnectedInput struct {
	AgentID           string
	Generation        uint64
	ConnectionEpoch   uint64
	RuntimeInstanceID string
}

func (s *Service) RuntimeConnected(
	ctx context.Context, input ConnectedInput,
) (domain.Runtime, error) {
	var result domain.Runtime
	err := s.repository.Transact(ctx, func(tx Transaction) error {
		current, err := tx.GetRuntime(ctx, input.AgentID)
		if err != nil {
			return err
		}
		if input.Generation == 0 || input.Generation != current.DesiredGeneration {
			return domain.ErrGenerationFenced
		}
		generation, err := tx.GetGeneration(ctx, input.AgentID, input.Generation)
		if err != nil {
			return err
		}
		nextRuntime, nextGeneration, err := domain.PlanGenerationConnected(
			current, generation, domain.RuntimeConnected{
				Generation: input.Generation, ConnectionEpoch: input.ConnectionEpoch,
				RuntimeInstanceID: input.RuntimeInstanceID, ConnectedAt: s.now(),
			},
		)
		if err != nil {
			return err
		}
		if err := tx.SaveGeneration(ctx, nextGeneration); err != nil {
			return err
		}
		if err := tx.SaveRuntime(ctx, nextRuntime); err != nil {
			return err
		}
		result = nextRuntime
		return nil
	})
	if err != nil {
		return domain.Runtime{}, err
	}
	return result, nil
}

type HealthyInput struct {
	AgentID         string
	Generation      uint64
	ConnectionEpoch uint64
	PolicyEpoch     uint64
}

func (s *Service) RuntimeHealthy(ctx context.Context, input HealthyInput) (domain.Runtime, error) {
	var result domain.Runtime
	err := s.repository.Transact(ctx, func(tx Transaction) error {
		current, err := tx.GetRuntime(ctx, input.AgentID)
		if err != nil {
			return err
		}
		if input.Generation == 0 || input.Generation != current.DesiredGeneration {
			return domain.ErrGenerationFenced
		}
		generation, err := tx.GetGeneration(ctx, input.AgentID, input.Generation)
		if err != nil {
			return err
		}
		nextRuntime, nextGeneration, err := domain.PlanGenerationHealthy(
			current, generation, domain.RuntimeHealthy{
				Generation: input.Generation, ConnectionEpoch: input.ConnectionEpoch,
				PolicyEpoch: input.PolicyEpoch, ObservedAt: s.now(),
			},
		)
		if err != nil {
			return err
		}
		operation, err := tx.GetOpenOperation(ctx, input.AgentID, input.Generation)
		if err != nil && !errors.Is(err, ErrNotFound) {
			return err
		}
		if err == nil && (operation.Kind == domain.OperationPrepare ||
			operation.Kind == domain.OperationUpdateNetwork) {
			operation.Status = domain.OperationSucceeded
			operation.UpdatedAt = s.now()
			if err := tx.SaveOperation(ctx, operation); err != nil {
				return err
			}
		}
		if err := tx.SaveGeneration(ctx, nextGeneration); err != nil {
			return err
		}
		if err := tx.SaveRuntime(ctx, nextRuntime); err != nil {
			return err
		}
		result = nextRuntime
		return nil
	})
	if err != nil {
		return domain.Runtime{}, err
	}
	return result, nil
}

type DisconnectedInput struct {
	AgentID         string
	Generation      uint64
	ConnectionEpoch uint64
}

func (s *Service) RuntimeDisconnected(
	ctx context.Context, input DisconnectedInput,
) error {
	return s.repository.Transact(ctx, func(tx Transaction) error {
		current, err := tx.GetRuntime(ctx, input.AgentID)
		if err != nil {
			return err
		}
		generation, err := tx.GetGeneration(ctx, input.AgentID, input.Generation)
		if err != nil {
			return err
		}
		nextRuntime, nextGeneration, err := domain.PlanGenerationDisconnected(
			current, generation, domain.RuntimeDisconnected{
				Generation: input.Generation, ConnectionEpoch: input.ConnectionEpoch,
				DisconnectedAt: s.now(),
			},
		)
		if err != nil {
			return err
		}
		if err := tx.SaveGeneration(ctx, nextGeneration); err != nil {
			return err
		}
		return tx.SaveRuntime(ctx, nextRuntime)
	})
}

func optionalOperation(
	ctx context.Context,
	tx Transaction,
	kind domain.OperationKind,
	agentID string,
	key string,
) (*domain.Operation, error) {
	operation, err := tx.GetOperationByIdempotencyKey(ctx, kind, agentID, key)
	if errors.Is(err, ErrNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &operation, nil
}
