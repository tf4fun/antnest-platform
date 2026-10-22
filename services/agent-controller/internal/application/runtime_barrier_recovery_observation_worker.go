package application

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

// Observation selects candidates only. The admission transaction remains the
// authority for current binding, policy, lifecycle and revocation checks.
type RuntimeBarrierRecoveryObservationStore interface {
	ports.RuntimeBarrierObservationStore
	ListAgents(context.Context, ports.AgentQuery) ([]ports.AgentRecord, error)
	GetAgentLifecycleBase(context.Context, string) (ports.AgentLifecycleBase, error)
	GetRuntimeBarrierRecoveryPolicy(context.Context, string) (domain.RuntimeBarrierRecoveryPolicy, error)
}

type RuntimeBarrierRecoveryAdmitter interface {
	Admit(context.Context, ports.RuntimeBarrierRecoveryIntent) (RuntimeBarrierRecoveryAdmissionResult, error)
}

type RuntimeBarrierRecoveryObservationSchedule struct {
	PollInterval time.Duration
	RoundTimeout time.Duration
	BatchSize    int
}

type RuntimeBarrierRecoveryObservationWorker struct {
	store          RuntimeBarrierRecoveryObservationStore
	reader         ports.RuntimeBarrierReader
	admitter       RuntimeBarrierRecoveryAdmitter
	schedule       RuntimeBarrierRecoveryObservationSchedule
	logger         *slog.Logger
	gate           chan struct{}
	afterCreatedAt time.Time
	afterAgentID   string
}

func NewRuntimeBarrierRecoveryObservationWorker(store RuntimeBarrierRecoveryObservationStore, reader ports.RuntimeBarrierReader,
	admitter RuntimeBarrierRecoveryAdmitter, schedule RuntimeBarrierRecoveryObservationSchedule, logger *slog.Logger,
) (*RuntimeBarrierRecoveryObservationWorker, error) {
	if store == nil || reader == nil || admitter == nil || schedule.PollInterval <= 0 || schedule.RoundTimeout <= 0 ||
		schedule.BatchSize < 1 || schedule.BatchSize > 1000 {
		return nil, fmt.Errorf("runtime barrier observation dependencies or schedule are invalid")
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &RuntimeBarrierRecoveryObservationWorker{store: store, reader: reader, admitter: admitter,
		schedule: schedule, logger: logger, gate: make(chan struct{}, 1)}, nil
}

func (worker *RuntimeBarrierRecoveryObservationWorker) Run(ctx context.Context) {
	for ctx.Err() == nil {
		if err := worker.RunOnce(ctx); err != nil && ctx.Err() == nil {
			worker.logger.WarnContext(ctx, "Runtime barrier observation failed",
				"component", "runtime_barrier_recovery_observation", "error_class", "recovery_observation_failed")
		}
		if !waitPublication(ctx, worker.schedule.PollInterval, nil) {
			return
		}
	}
}

// RunOnce visits one bounded page with one deadline, including cursor-gate
// waiting. Synchronous calls must actually return before this owner can exit.
func (worker *RuntimeBarrierRecoveryObservationWorker) RunOnce(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, worker.schedule.RoundTimeout)
	defer cancel()
	select {
	case worker.gate <- struct{}{}:
		defer func() { <-worker.gate }()
	case <-ctx.Done():
		return ctx.Err()
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	// ACP may retain a barrier while the Controller still reports available.
	// Pending Runtime bindings and RuntimeState filters would miss that Agent.
	page, err := worker.store.ListAgents(ctx, ports.AgentQuery{
		LifecycleState: domain.AgentCreated, ActivationState: domain.ActivationEnabled,
		AfterCreatedAt: worker.afterCreatedAt, AfterAgentID: worker.afterAgentID, Limit: worker.schedule.BatchSize,
	})
	if err := runtimeBarrierObservationCallError(ctx, err, "list Runtime barrier candidates"); err != nil {
		return err
	}
	if len(page) > worker.schedule.BatchSize {
		return fmt.Errorf("%w: oversized Runtime barrier candidate page", ErrQueryContract)
	}
	previousTime, previousID := worker.afterCreatedAt, worker.afterAgentID
	for _, candidate := range page {
		if !domain.ValidRuntimeBarrierPolicyIdentifier(candidate.AgentID) ||
			!domain.ValidRuntimeBarrierPolicyIdentifier(candidate.OrganizationID) || candidate.CreatedAt.IsZero() ||
			candidate.CreatedAt.Before(previousTime) || candidate.CreatedAt.Equal(previousTime) && candidate.AgentID <= previousID {
			return fmt.Errorf("%w: invalid Runtime barrier candidate cursor", ErrQueryContract)
		}
		previousTime, previousID = candidate.CreatedAt, candidate.AgentID
	}
	var failure error
	for _, candidate := range page {
		if err := ctx.Err(); err != nil {
			return errors.Join(failure, err)
		}
		err := worker.observe(ctx, candidate)
		// A visited failure cannot starve later Agents. Cancellation never skips
		// the unvisited tail; a later complete short/empty page wraps the scan.
		worker.afterCreatedAt, worker.afterAgentID = candidate.CreatedAt, candidate.AgentID
		failure = errors.Join(failure, err)
		if cancelled := ctx.Err(); cancelled != nil {
			return errors.Join(failure, cancelled)
		}
	}
	if len(page) < worker.schedule.BatchSize {
		worker.afterCreatedAt, worker.afterAgentID = time.Time{}, ""
	}
	return failure
}

func (worker *RuntimeBarrierRecoveryObservationWorker) observe(ctx context.Context, candidate ports.AgentRecord) error {
	base, err := worker.store.GetAgentLifecycleBase(ctx, candidate.AgentID)
	if err := runtimeBarrierObservationCallError(ctx, err, "read Runtime barrier lifecycle base"); err != nil {
		return err
	}
	agent := base.Agent
	if agent.AgentID != candidate.AgentID || agent.OrganizationID != candidate.OrganizationID {
		return fmt.Errorf("%w: mismatched Runtime barrier lifecycle scope", ErrQueryContract)
	}
	if !agent.CanObserveRuntime() || agent.OwnerUserID == "" {
		return nil
	}
	source := ports.AgentRuntimeSource{Spec: base.ConfiguredSpec, Execution: base.SourceExecution}
	snapshot := base.ConfiguredSpec.Snapshot
	if !source.MatchesAgent(agent) || !domain.ValidRuntimeBarrierPolicyIdentifier(agent.OwnerUserID) ||
		agent.OwnerAuthorizationSequence < 0 || agent.IdentityRevocationSequence < 0 ||
		!domain.ValidRuntimeBarrierPolicyIdentifier(snapshot.TemplateID) || snapshot.TemplateRevision < 1 {
		return fmt.Errorf("%w: invalid Runtime barrier lifecycle source", ErrQueryContract)
	}
	query := ports.RuntimeBarrierQuery{OrganizationID: agent.OrganizationID, AgentID: agent.AgentID,
		ExpectedRuntimeRevision: agent.RuntimeRevision}
	if query.Validate() != nil {
		return fmt.Errorf("%w: invalid Runtime barrier query scope", ErrQueryContract)
	}
	revision, err := worker.store.GetRuntimeBarrierObservationRevision(ctx, agent.OrganizationID, agent.AgentID)
	if err := runtimeBarrierObservationCallError(ctx, err, "read Runtime barrier observation version"); err != nil {
		return err
	}
	if revision < 0 {
		return fmt.Errorf("%w: invalid Runtime barrier observation version", ErrQueryContract)
	}
	fact, err := worker.reader.GetRuntimeBarrier(ctx, query)
	if err := runtimeBarrierObservationCallError(ctx, err, "read original Runtime barrier"); err != nil {
		return err
	}
	if !fact.Matches(query) {
		return fmt.Errorf("%w: mismatched Runtime barrier fact", ErrQueryContract)
	}
	policy, err := worker.store.GetRuntimeBarrierRecoveryPolicy(ctx, agent.OrganizationID)
	if err := runtimeBarrierObservationCallError(ctx, err, "read Runtime barrier recovery policy"); err != nil {
		return err
	}
	if policy.OrganizationID != agent.OrganizationID || policy.Validate() != nil {
		return fmt.Errorf("%w: invalid Runtime barrier recovery policy", ErrQueryContract)
	}
	err = worker.store.RecordRuntimeBarrierObservation(ctx, ports.RecordRuntimeBarrierObservation{
		Fact: fact, ExpectedAgent: agent, ExpectedPolicyRevision: policy.Revision,
		ExpectedObservationRevision: revision,
	})
	if err := runtimeBarrierObservationCallError(ctx, err, "persist Runtime barrier observation"); err != nil {
		return err
	}
	if fact.Barrier == nil || policy.Mode != "auto" {
		return nil
	}
	requestID, err := ports.RuntimeBarrierRecoveryRequestID(agent.OrganizationID, agent.AgentID, fact.Barrier.BarrierID)
	if err != nil {
		return fmt.Errorf("%w: invalid Runtime barrier recovery identity", ErrQueryContract)
	}
	// The protected execution identity belongs to the original barrier. It need
	// not equal newer health observations, and the configured Template is frozen.
	_, err = worker.admitter.Admit(ctx, ports.RuntimeBarrierRecoveryIntent{
		Fact: fact, ExpectedPolicyRevision: policy.Revision, ExpectedOwnerUserID: agent.OwnerUserID,
		ExpectedOwnerAuthorizationSequence: agent.OwnerAuthorizationSequence,
		ExpectedIdentityRevocationSequence: agent.IdentityRevocationSequence,
		Command: ports.RuntimeBarrierRebuildCommand{RequestID: requestID, OrganizationID: agent.OrganizationID,
			AgentID: agent.AgentID, ActorPrincipalID: "agent-controller",
			TemplateID: snapshot.TemplateID, TemplateRevision: snapshot.TemplateRevision},
	})
	// An uncertain admission may already be committed. A later observation or
	// independent pending-start worker recovers it; never start/confirm here.
	return runtimeBarrierObservationCallError(ctx, err, "admit original Runtime barrier recovery")
}

func runtimeBarrierObservationCallError(ctx context.Context, err error, operation string) error {
	if err != nil {
		err = fmt.Errorf("%s: %w", operation, err)
	}
	return errors.Join(err, ctx.Err())
}
