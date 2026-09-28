package application

import (
	"context"
	"errors"
	"fmt"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

var ErrLegacyProofLossRecoveryNotApplicable = errors.New("legacy proof-loss recovery is not applicable")
var ErrLegacyMigrationManualRecoveryRequired = errors.New("legacy migration target requires manual recovery")

type LegacyProofLossRecoveryInput struct {
	RequestID                string `json:"request_id"`
	OrganizationID           string `json:"organization_id"`
	ActorPrincipalID         string `json:"actor_principal_id"`
	AgentID                  string `json:"agent_id"`
	FailedMigrationRequestID string `json:"failed_migration_request_id"`
}

type LegacyProofLossRecoveryStore interface {
	GetAgent(context.Context, string) (ports.AgentRecord, error)
	GetLifecycleOperation(context.Context, string) (ports.LifecycleOperationRecord, error)
	GetLegacyProofLossRecovery(context.Context, string) (ports.LegacyProofLossRecoveryRecord, error)
	BeginLegacyProofLossRecovery(context.Context, ports.BeginLegacyProofLossRecovery) (ports.LegacyProofLossRecoveryRecord, bool, error)
	RecordLegacyProofLossRuntimeDisabled(context.Context, string, string, string, ports.RuntimeOperation, time.Time) (ports.LegacyProofLossRecoveryRecord, error)
	PublishLegacyProofLossRecovery(context.Context, string, string, uint64, string, string, time.Time) (ports.LegacyProofLossRecoveryRecord, error)
	MarkLegacyProofLossManualRecovery(context.Context, string, string, string, string, time.Time) (ports.LegacyProofLossRecoveryRecord, error)
}

type LegacyProofLossRuntime interface {
	InspectRuntime(context.Context, string) (ports.RuntimeInspection, error)
	DisableRuntime(context.Context, string, string, string) (ports.RuntimeOperation, error)
}

type LegacyProofLossEgress interface {
	GetAgentNetwork(context.Context, string) (ports.NetworkAttachment, error)
}

type LegacyProofLossRecoveryService struct {
	store   LegacyProofLossRecoveryStore
	runtime LegacyProofLossRuntime
	egress  LegacyProofLossEgress
	clock   ports.Clock
}

func NewLegacyProofLossRecoveryService(store LegacyProofLossRecoveryStore, runtime LegacyProofLossRuntime, egress LegacyProofLossEgress, clock ports.Clock) *LegacyProofLossRecoveryService {
	return &LegacyProofLossRecoveryService{store: store, runtime: runtime, egress: egress, clock: clock}
}

func (service *LegacyProofLossRecoveryService) Replay(ctx context.Context, input LegacyProofLossRecoveryInput) (ports.LegacyProofLossRecoveryRecord, bool, error) {
	if !validIdentifier(input.RequestID) || !validIdentifier(input.AgentID) || !validLifecycleCaller(input.OrganizationID, input.ActorPrincipalID) || !validIdentifier(input.FailedMigrationRequestID) {
		return ports.LegacyProofLossRecoveryRecord{}, false, ErrInvalidInput
	}
	fingerprint, err := requestFingerprint(input)
	if err != nil {
		return ports.LegacyProofLossRecoveryRecord{}, false, err
	}
	replayed, err := service.store.GetLegacyProofLossRecovery(ctx, input.RequestID)
	if err == nil {
		if replayed.OrganizationID != input.OrganizationID || replayed.AgentID != input.AgentID {
			return ports.LegacyProofLossRecoveryRecord{}, false, ErrAgentNotFound
		}
		if replayed.Fingerprint != fingerprint || replayed.ActorPrincipalID != input.ActorPrincipalID || replayed.FailedMigrationRequestID != input.FailedMigrationRequestID {
			return ports.LegacyProofLossRecoveryRecord{}, false, ports.ErrRequestConflict
		}
		return replayed, true, nil
	}
	if !errors.Is(err, ports.ErrNotFound) {
		return ports.LegacyProofLossRecoveryRecord{}, false, err
	}
	return ports.LegacyProofLossRecoveryRecord{}, false, nil
}

func (service *LegacyProofLossRecoveryService) Get(ctx context.Context, organizationID, requestID string) (ports.LegacyProofLossRecoveryRecord, error) {
	if !validIdentifier(organizationID) || !validIdentifier(requestID) {
		return ports.LegacyProofLossRecoveryRecord{}, ErrInvalidInput
	}
	record, err := service.store.GetLegacyProofLossRecovery(ctx, requestID)
	if err != nil {
		return ports.LegacyProofLossRecoveryRecord{}, err
	}
	if record.OrganizationID != organizationID {
		return ports.LegacyProofLossRecoveryRecord{}, ports.ErrNotFound
	}
	return record, nil
}

func (service *LegacyProofLossRecoveryService) Admit(ctx context.Context, input LegacyProofLossRecoveryInput) (ports.LegacyProofLossRecoveryRecord, error) {
	replayed, found, err := service.Replay(ctx, input)
	if err != nil || found {
		return replayed, err
	}
	fingerprint, err := requestFingerprint(input)
	if err != nil {
		return ports.LegacyProofLossRecoveryRecord{}, err
	}
	agent, err := service.store.GetAgent(ctx, input.AgentID)
	if errors.Is(err, ports.ErrNotFound) {
		return ports.LegacyProofLossRecoveryRecord{}, ErrAgentNotFound
	}
	if err != nil {
		return ports.LegacyProofLossRecoveryRecord{}, err
	}
	if agent.OrganizationID != input.OrganizationID {
		return ports.LegacyProofLossRecoveryRecord{}, ErrAgentNotFound
	}
	if agent.ActiveOperationRequestID != "" {
		return ports.LegacyProofLossRecoveryRecord{}, ErrLifecycleConflict
	}
	if agent.FailureCode != legacyMigrationProofLostCode || agent.ExecutionRevisionID != "" ||
		agent.LifecycleState != domain.AgentCreated || agent.DesiredState != domain.DesiredEnabled || agent.ActivationState != domain.ActivationEnabled {
		return ports.LegacyProofLossRecoveryRecord{}, ErrLegacyProofLossRecoveryNotApplicable
	}
	failed, err := service.store.GetLifecycleOperation(ctx, input.FailedMigrationRequestID)
	if errors.Is(err, ports.ErrNotFound) {
		return ports.LegacyProofLossRecoveryRecord{}, ErrAgentNotFound
	}
	if err != nil {
		return ports.LegacyProofLossRecoveryRecord{}, err
	}
	if failed.AgentID != input.AgentID || failed.State != domain.OperationFailed || failed.Phase != domain.PhasePublish ||
		(failed.Kind != domain.OperationRebuild && failed.Kind != domain.OperationEnable) || failed.ErrorCode != legacyMigrationProofLostCode ||
		failed.RuntimeResult == nil || failed.RuntimeResult.State != "completed" || failed.RuntimeResult.Effect != "completed" ||
		failed.RuntimeResult.LifecycleState != "provisioned" || failed.RuntimeResult.RuntimeRevision == "" {
		return ports.LegacyProofLossRecoveryRecord{}, ErrLegacyProofLossRecoveryNotApplicable
	}
	inspection, err := service.runtime.InspectRuntime(ctx, input.AgentID)
	if err != nil {
		return ports.LegacyProofLossRecoveryRecord{}, fmt.Errorf("%w: inspect recovery Runtime: %v", ErrDependencyUnavailable, err)
	}
	if inspection.AgentID != input.AgentID || inspection.RuntimeRevision != failed.RuntimeResult.RuntimeRevision ||
		inspection.Phase != "running" || inspection.LifecycleState != "provisioned" {
		return ports.LegacyProofLossRecoveryRecord{}, ErrLegacyMigrationManualRecoveryRequired
	}
	if inspection.RuntimeExecutionID == "" {
		return ports.LegacyProofLossRecoveryRecord{}, fmt.Errorf("%w: recovery Runtime process observation is pending", ErrDependencyUnavailable)
	}
	attachment, err := service.egress.GetAgentNetwork(ctx, input.AgentID)
	if err != nil {
		return ports.LegacyProofLossRecoveryRecord{}, fmt.Errorf("%w: inspect recovery Egress: %v", ErrDependencyUnavailable, err)
	}
	if !networkAttachmentInState(attachment, input.AgentID, ports.NetworkStateActive, ports.NetworkAttachmentClosed) {
		return ports.LegacyProofLossRecoveryRecord{}, ErrLegacyMigrationManualRecoveryRequired
	}
	childID := domain.DeriveResourceID("acr", "legacy-proof-loss-disable/"+inspection.RuntimeRevision, input.RequestID)
	record, _, err := service.store.BeginLegacyProofLossRecovery(ctx, ports.BeginLegacyProofLossRecovery{RequestID: input.RequestID, Fingerprint: fingerprint,
		AgentID: input.AgentID, OrganizationID: input.OrganizationID, ActorPrincipalID: input.ActorPrincipalID, FailedMigrationRequestID: input.FailedMigrationRequestID,
		TargetRuntimeRevision: inspection.RuntimeRevision, ObservedRuntimeExecutionID: inspection.RuntimeExecutionID, ClosedAttachmentVersion: attachment.AttachmentResourceVersion,
		ExpectedAggregateSequence: agent.AggregateSequence, ChildRequestID: childID, Now: service.clock.Now()})
	return record, err
}

func (service *LegacyProofLossRecoveryService) Advance(ctx context.Context, requestID string) (ports.LegacyProofLossRecoveryRecord, error) {
	record, err := service.store.GetLegacyProofLossRecovery(ctx, requestID)
	if err != nil {
		return ports.LegacyProofLossRecoveryRecord{}, err
	}
	if record.State == "completed" || record.State == "manual_recovery_required" {
		return record, nil
	}
	switch record.Phase {
	case "disable_runtime":
		result, err := service.runtime.DisableRuntime(ctx, record.ChildRequestID, record.AgentID, record.TargetRuntimeRevision)
		if err != nil {
			return record, fmt.Errorf("%w: disable recovery Runtime: %v", ErrDependencyUnavailable, err)
		}
		if result.State == "running" || result.State == "unknown" {
			return record, nil
		}
		if result.State == "failed" && result.Effect != "unknown" {
			return service.store.MarkLegacyProofLossManualRecovery(ctx, record.RequestID, record.Fingerprint, record.Phase, "runtime_disable_rejected", service.clock.Now())
		}
		if !completedDisabledRuntime(result) {
			return record, fmt.Errorf("%w: RC returned unproven disabled result", ErrDependencyUnavailable)
		}
		return service.store.RecordLegacyProofLossRuntimeDisabled(ctx, record.RequestID, record.Fingerprint, record.ChildRequestID, result, service.clock.Now())
	case "publish":
		attachment, err := service.egress.GetAgentNetwork(ctx, record.AgentID)
		if err != nil {
			return record, fmt.Errorf("%w: recheck recovery Egress: %v", ErrDependencyUnavailable, err)
		}
		if !networkAttachmentInState(attachment, record.AgentID, ports.NetworkStateActive, ports.NetworkAttachmentClosed) || attachment.AttachmentResourceVersion != record.ClosedAttachmentVersion {
			return service.store.MarkLegacyProofLossManualRecovery(ctx, record.RequestID, record.Fingerprint, record.Phase, "network_attachment_changed", service.clock.Now())
		}
		published, err := service.store.PublishLegacyProofLossRecovery(ctx, record.RequestID, record.Fingerprint, attachment.AttachmentResourceVersion,
			domain.DeriveResourceID("event", "event-legacy-proof-loss-recovered", record.RequestID), currentTraceID(ctx), service.clock.Now())
		if errors.Is(err, ports.ErrConcurrentChange) {
			return service.store.MarkLegacyProofLossManualRecovery(ctx, record.RequestID, record.Fingerprint, record.Phase, "publication_conflict", service.clock.Now())
		}
		return published, err
	default:
		return record, fmt.Errorf("%w: invalid legacy proof-loss recovery phase", ErrLegacyMigrationManualRecoveryRequired)
	}
}
