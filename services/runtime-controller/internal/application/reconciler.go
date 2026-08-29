package application

import (
	"context"
	"errors"
	"fmt"
	"time"

	"soft/antnest-platform/services/runtime-controller/internal/domain"
)

const (
	unknownObservationDelay    = 5 * time.Second
	connectionObservationDelay = 30 * time.Second
)

type RuntimeDriver interface {
	Ensure(context.Context, EnsureRequest) DriverResult
	Stop(context.Context, RuntimeTarget) DriverResult
	Remove(context.Context, RuntimeTarget, bool) DriverResult
}

type NetworkDriver interface {
	Apply(context.Context, NetworkRequest) domain.EffectOutcome
	Release(context.Context, RuntimeTarget) domain.EffectOutcome
}

type TokenSource interface {
	Token(agentID string, generation uint64) (string, error)
}

type EnsureRequest struct {
	AgentID            string
	Generation         uint64
	RuntimeInstanceID  string
	ImageRef           string
	NetworkMode        domain.NetworkMode
	NetworkPolicyEpoch uint64
	TunnelIPv4         string
	AllocatorEpoch     uint64
	AdvertisedEndpoint string
	EgressEndpoint     string
	ManagementNetwork  string
	DNSIPv4            string
	BootstrapToken     string
}

type RuntimeTarget struct {
	AgentID           string
	Generation        uint64
	RuntimeInstanceID string
	ContainerID       string
}

type NetworkRequest struct {
	RuntimeTarget
	Mode           domain.NetworkMode
	PolicyEpoch    uint64
	TunnelIPv4     string
	AllocatorEpoch uint64
}

type DriverResult struct {
	Outcome     domain.EffectOutcome
	ContainerID string
}

type ReconcileResult struct {
	Settled bool
	RetryAt time.Time
}

type Reconciler struct {
	repository Repository
	driver     RuntimeDriver
	network    NetworkDriver
	tokens     TokenSource
	now        func() time.Time
	bootstrap  BootstrapConfig
}

type BootstrapConfig struct {
	AdvertisedEndpoint string
	EgressEndpoint     string
	ManagementNetwork  string
	DNSIPv4            string
}

func NewReconciler(
	repository Repository,
	driver RuntimeDriver,
	network NetworkDriver,
	tokens TokenSource,
	now func() time.Time,
) (*Reconciler, error) {
	return NewReconcilerWithBootstrap(repository, driver, network, tokens, now, BootstrapConfig{
		AdvertisedEndpoint: "172.30.255.2:8091",
		EgressEndpoint:     "172.30.255.3:8092",
		ManagementNetwork:  "antnest-runtime-management",
		DNSIPv4:            "100.64.0.1",
	})
}

func NewReconcilerWithBootstrap(
	repository Repository,
	driver RuntimeDriver,
	network NetworkDriver,
	tokens TokenSource,
	now func() time.Time,
	bootstrap BootstrapConfig,
) (*Reconciler, error) {
	if repository == nil || driver == nil || network == nil || tokens == nil || now == nil {
		return nil, fmt.Errorf("repository, Runtime driver, network driver, token source, and clock are required")
	}
	if bootstrap.AdvertisedEndpoint == "" || bootstrap.EgressEndpoint == "" ||
		bootstrap.ManagementNetwork == "" || bootstrap.DNSIPv4 == "" {
		return nil, fmt.Errorf("Runtime control, egress, management network, and DNS addresses are required")
	}
	return &Reconciler{
		repository: repository, driver: driver, network: network, tokens: tokens, now: now,
		bootstrap: bootstrap,
	}, nil
}

func (r *Reconciler) Reconcile(ctx context.Context, agentID string) (ReconcileResult, error) {
	runtime, err := r.repository.GetRuntime(ctx, agentID)
	if err != nil {
		return ReconcileResult{}, err
	}
	generation, err := r.repository.GetGeneration(ctx, agentID, runtime.DesiredGeneration)
	if err != nil {
		return ReconcileResult{}, err
	}
	operation, err := r.repository.GetOpenOperation(ctx, agentID, runtime.DesiredGeneration)
	if err != nil && !errors.Is(err, ErrNotFound) {
		return ReconcileResult{}, err
	}
	var operationPtr *domain.Operation
	if err == nil {
		operationPtr = &operation
	}

	now := r.now().UTC()
	if settled(runtime) {
		return ReconcileResult{Settled: true}, nil
	}
	if generation.NextAttemptAt.After(now) {
		return ReconcileResult{RetryAt: generation.NextAttemptAt}, nil
	}
	operationPtr, err = r.claimOperation(ctx, runtime, generation, operationPtr, now)
	if err != nil {
		return ReconcileResult{}, err
	}

	result, err := r.execute(ctx, runtime, generation)
	if err != nil {
		return ReconcileResult{}, err
	}
	if err := result.Outcome.Validate(); err != nil {
		return ReconcileResult{}, fmt.Errorf("runtime driver returned invalid outcome: %w", err)
	}
	return r.commitResult(ctx, runtime, generation, operationPtr, result, now)
}

// claimOperation closes the race between reading desired state and dispatching
// an irreversible Docker side effect. Commands may supersede pending intent,
// but never an operation that this reconciler has durably claimed.
func (r *Reconciler) claimOperation(
	ctx context.Context,
	snapshot domain.Runtime,
	snapshotGeneration domain.RuntimeGeneration,
	snapshotOperation *domain.Operation,
	now time.Time,
) (*domain.Operation, error) {
	if snapshotOperation == nil {
		return nil, nil
	}
	claimed := *snapshotOperation
	err := r.repository.Transact(ctx, func(tx Transaction) error {
		current, err := tx.GetRuntime(ctx, snapshot.AgentID)
		if err != nil {
			return err
		}
		if current.DesiredGeneration != snapshot.DesiredGeneration ||
			current.DesiredState != snapshot.DesiredState ||
			current.ResourceVersion != snapshot.ResourceVersion {
			return domain.ErrGenerationFenced
		}
		generation, err := tx.GetGeneration(ctx, snapshot.AgentID, snapshot.DesiredGeneration)
		if err != nil {
			return err
		}
		if generation.ResourceVersion != snapshotGeneration.ResourceVersion {
			return domain.ErrGenerationFenced
		}
		loaded, err := tx.GetOpenOperation(ctx, snapshot.AgentID, snapshot.DesiredGeneration)
		if err != nil {
			return err
		}
		if loaded.ID != snapshotOperation.ID {
			return domain.ErrGenerationFenced
		}
		if loaded.Status == domain.OperationPending {
			loaded.Status = domain.OperationRunning
			loaded.UpdatedAt = now
			if err := tx.SaveOperation(ctx, loaded); err != nil {
				return err
			}
		}
		claimed = loaded
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &claimed, nil
}

// RestoreReady re-applies process-local infrastructure for Runtime records
// that were already settled before this Controller process started. It runs
// once before Runtime admission opens; ordinary reconciliation remains event
// driven and does not poll healthy Runtime records.
func (r *Reconciler) RestoreReady(ctx context.Context) error {
	agentIDs, err := r.repository.ListReadyRuntimeIDs(ctx)
	if err != nil {
		return fmt.Errorf("list ready Runtime records: %w", err)
	}
	for _, agentID := range agentIDs {
		if err := r.restoreReadyRuntime(ctx, agentID); err != nil {
			return fmt.Errorf("restore Runtime %q: %w", agentID, err)
		}
	}
	return nil
}

func (r *Reconciler) restoreReadyRuntime(ctx context.Context, agentID string) error {
	runtime, err := r.repository.GetRuntime(ctx, agentID)
	if err != nil {
		return err
	}
	generation, err := r.repository.GetGeneration(ctx, agentID, runtime.DesiredGeneration)
	if err != nil {
		return err
	}
	if !settled(runtime) || runtime.DesiredState != domain.DesiredActive ||
		generation.Status != domain.GenerationReady {
		return nil
	}
	result, err := r.execute(ctx, runtime, generation)
	if err != nil {
		return err
	}
	if err := result.Outcome.Validate(); err != nil {
		return fmt.Errorf("runtime driver returned invalid restore outcome: %w", err)
	}
	if result.Outcome.State == domain.EffectCompleted && result.ContainerID == generation.ContainerID {
		return nil
	}
	_, err = r.commitResult(ctx, runtime, generation, nil, result, r.now().UTC())
	return err
}

func (r *Reconciler) execute(
	ctx context.Context, runtime domain.Runtime, generation domain.RuntimeGeneration,
) (DriverResult, error) {
	target := RuntimeTarget{
		AgentID: runtime.AgentID, Generation: generation.Number,
		RuntimeInstanceID: generation.RuntimeInstanceID, ContainerID: generation.ContainerID,
	}
	switch runtime.DesiredState {
	case domain.DesiredActive:
		network := r.network.Apply(ctx, NetworkRequest{
			RuntimeTarget: target,
			Mode:          runtime.NetworkMode, PolicyEpoch: runtime.NetworkPolicyEpoch,
			TunnelIPv4: generation.TunnelIPv4, AllocatorEpoch: generation.AllocatorEpoch,
		})
		if network.State != domain.EffectCompleted {
			return DriverResult{Outcome: network}, nil
		}
		token, err := r.tokens.Token(runtime.AgentID, generation.Number)
		if err != nil {
			return DriverResult{}, fmt.Errorf("issue runtime token: %w", err)
		}
		result := r.driver.Ensure(ctx, EnsureRequest{
			AgentID: runtime.AgentID, Generation: generation.Number,
			RuntimeInstanceID: generation.RuntimeInstanceID,
			ImageRef:          generation.ImageRef, NetworkMode: runtime.NetworkMode,
			NetworkPolicyEpoch: runtime.NetworkPolicyEpoch,
			TunnelIPv4:         generation.TunnelIPv4, AllocatorEpoch: generation.AllocatorEpoch,
			AdvertisedEndpoint: r.bootstrap.AdvertisedEndpoint,
			EgressEndpoint:     r.bootstrap.EgressEndpoint,
			ManagementNetwork:  r.bootstrap.ManagementNetwork,
			DNSIPv4:            r.bootstrap.DNSIPv4,
			BootstrapToken:     token,
		})
		if result.Outcome.State == domain.EffectNotStarted {
			released := r.network.Release(ctx, target)
			if released.State != domain.EffectCompleted {
				return DriverResult{Outcome: released}, nil
			}
		}
		return result, nil
	case domain.DesiredStopped:
		if released := r.network.Release(ctx, target); released.State != domain.EffectCompleted {
			return DriverResult{Outcome: released}, nil
		}
		return r.driver.Stop(ctx, target), nil
	case domain.DesiredRetired:
		if released := r.network.Release(ctx, target); released.State != domain.EffectCompleted {
			return DriverResult{Outcome: released}, nil
		}
		return r.driver.Remove(ctx, target, false), nil
	case domain.DesiredPurged:
		if released := r.network.Release(ctx, target); released.State != domain.EffectCompleted {
			return DriverResult{Outcome: released}, nil
		}
		return r.driver.Remove(ctx, target, true), nil
	default:
		return DriverResult{}, fmt.Errorf("unsupported desired state %q", runtime.DesiredState)
	}
}

func (r *Reconciler) commitResult(
	ctx context.Context,
	snapshot domain.Runtime,
	snapshotGeneration domain.RuntimeGeneration,
	snapshotOperation *domain.Operation,
	result DriverResult,
	now time.Time,
) (ReconcileResult, error) {
	response := ReconcileResult{}
	err := r.repository.Transact(ctx, func(tx Transaction) error {
		current, err := tx.GetRuntime(ctx, snapshot.AgentID)
		if err != nil {
			return err
		}
		if current.DesiredGeneration != snapshot.DesiredGeneration ||
			current.DesiredState != snapshot.DesiredState ||
			current.ResourceVersion != snapshot.ResourceVersion {
			return domain.ErrGenerationFenced
		}
		generation, err := tx.GetGeneration(ctx, current.AgentID, current.DesiredGeneration)
		if err != nil {
			return err
		}
		if generation.ResourceVersion != snapshotGeneration.ResourceVersion {
			return domain.ErrGenerationFenced
		}

		var operation *domain.Operation
		if snapshotOperation != nil {
			loaded, err := tx.GetOpenOperation(ctx, current.AgentID, current.DesiredGeneration)
			if err != nil {
				return err
			}
			if loaded.ID != snapshotOperation.ID {
				return domain.ErrGenerationFenced
			}
			operation = &loaded
		}

		response = applyDriverResult(&current, &generation, operation, result, now)
		if operation != nil {
			if err := tx.SaveOperation(ctx, *operation); err != nil {
				return err
			}
		}
		if err := tx.SaveGeneration(ctx, generation); err != nil {
			return err
		}
		return tx.SaveRuntime(ctx, current)
	})
	if err != nil {
		return ReconcileResult{}, err
	}
	return response, nil
}

func applyDriverResult(
	runtime *domain.Runtime,
	generation *domain.RuntimeGeneration,
	operation *domain.Operation,
	result DriverResult,
	now time.Time,
) ReconcileResult {
	runtime.UpdatedAt = now
	runtime.ResourceVersion++
	generation.UpdatedAt = now
	generation.ResourceVersion++
	if operation != nil {
		operation.UpdatedAt = now
	}

	switch result.Outcome.State {
	case domain.EffectNotStarted:
		markFailed(runtime, generation, operation, result.Outcome)
		return ReconcileResult{Settled: true}
	case domain.EffectUnknown:
		markUnknown(runtime, generation, operation, result.Outcome, now)
		return ReconcileResult{RetryAt: generation.NextAttemptAt}
	default:
		return markCompleted(runtime, generation, operation, result, now)
	}
}

func markFailed(
	runtime *domain.Runtime, generation *domain.RuntimeGeneration,
	operation *domain.Operation, outcome domain.EffectOutcome,
) {
	runtime.Status = domain.RuntimeFailed
	runtime.FailureCode = outcome.Code
	runtime.FailureDetail = outcome.Detail
	generation.Status = domain.GenerationFailed
	generation.FailureCode = outcome.Code
	generation.FailureDetail = outcome.Detail
	generation.NextAttemptAt = time.Time{}
	if operation != nil {
		operation.Status = domain.OperationFailed
		operation.ErrorCode = outcome.Code
		operation.ErrorDetail = outcome.Detail
	}
}

func markUnknown(
	runtime *domain.Runtime, generation *domain.RuntimeGeneration,
	operation *domain.Operation, outcome domain.EffectOutcome, now time.Time,
) {
	runtime.Status = domain.RuntimeStarting
	generation.Status = domain.GenerationStarting
	generation.FailureCode = outcome.Code
	generation.FailureDetail = outcome.Detail
	generation.NextAttemptAt = now.Add(unknownObservationDelay)
	if operation != nil {
		operation.Status = domain.OperationUnknown
		operation.ErrorCode = outcome.Code
		operation.ErrorDetail = outcome.Detail
	}
}

func markCompleted(
	runtime *domain.Runtime, generation *domain.RuntimeGeneration,
	operation *domain.Operation, result DriverResult, now time.Time,
) ReconcileResult {
	switch runtime.DesiredState {
	case domain.DesiredActive:
		if generation.Status == domain.GenerationReady &&
			(result.ContainerID == "" || result.ContainerID == generation.ContainerID) {
			runtime.ObservedPolicyEpoch = runtime.NetworkPolicyEpoch
			generation.NetworkPolicyEpoch = runtime.NetworkPolicyEpoch
			if operation != nil {
				operation.Status = domain.OperationSucceeded
			}
			return ReconcileResult{Settled: true}
		}
		runtime.Status = domain.RuntimeStarting
		generation.Status = domain.GenerationStarting
		if result.ContainerID != "" {
			generation.ContainerID = result.ContainerID
		}
		generation.NextAttemptAt = now.Add(connectionObservationDelay)
		if operation != nil {
			operation.Status = domain.OperationRunning
		}
		return ReconcileResult{RetryAt: generation.NextAttemptAt}
	case domain.DesiredStopped:
		runtime.Status = domain.RuntimeStopped
		generation.Status = domain.GenerationStopped
	case domain.DesiredRetired:
		runtime.Status = domain.RuntimeRetired
		generation.Status = domain.GenerationRetired
	case domain.DesiredPurged:
		runtime.Status = domain.RuntimePurged
		generation.Status = domain.GenerationRetired
	}
	generation.NextAttemptAt = time.Time{}
	if operation != nil {
		operation.Status = domain.OperationSucceeded
	}
	return ReconcileResult{Settled: true}
}

func settled(runtime domain.Runtime) bool {
	if runtime.Status == domain.RuntimeFailed {
		return true
	}
	switch runtime.DesiredState {
	case domain.DesiredActive:
		return runtime.Status == domain.RuntimeReady &&
			runtime.ObservedGeneration == runtime.DesiredGeneration &&
			runtime.ObservedPolicyEpoch == runtime.NetworkPolicyEpoch
	case domain.DesiredStopped:
		return runtime.Status == domain.RuntimeStopped
	case domain.DesiredRetired:
		return runtime.Status == domain.RuntimeRetired
	case domain.DesiredPurged:
		return runtime.Status == domain.RuntimePurged
	default:
		return runtime.Status == domain.RuntimeFailed
	}
}
