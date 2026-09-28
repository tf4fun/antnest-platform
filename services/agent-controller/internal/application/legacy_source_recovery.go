package application

import (
	"context"
	"errors"
	"fmt"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

var ErrLegacySourceRecoveryNotApplicable = errors.New("legacy source recovery is not applicable")
var ErrLegacySourceManualRecoveryRequired = errors.New("legacy source requires manual recovery")

type LegacySourceRecoveryInput struct {
	RequestID        string `json:"request_id"`
	OrganizationID   string `json:"organization_id"`
	ActorPrincipalID string `json:"actor_principal_id"`
	AgentID          string `json:"agent_id"`
}

type LegacySourceRecoveryStore interface {
	GetAgent(context.Context, string) (ports.AgentRecord, error)
	GetLegacySkillMigration(context.Context, string, string) (ports.LegacySkillMigrationRecord, error)
	GetLegacySourceRecovery(context.Context, string) (ports.LegacySourceRecoveryRecord, error)
	BeginLegacySourceRecovery(context.Context, ports.BeginLegacySourceRecovery) (ports.LegacySourceRecoveryRecord, bool, error)
	CompleteLegacySourceDrain(context.Context, string, string, time.Time) (ports.LegacySourceRecoveryRecord, error)
	RecordLegacySourceFence(context.Context, string, string, uint64, time.Time) (ports.LegacySourceRecoveryRecord, error)
	RecordLegacySourceRuntimeDisabled(context.Context, string, string, string, ports.RuntimeOperation, time.Time) (ports.LegacySourceRecoveryRecord, error)
	PublishLegacySourceRecovery(context.Context, string, string, uint64, string, string, time.Time) (ports.LegacySourceRecoveryRecord, error)
	MarkLegacySourceManualRecovery(context.Context, string, string, string, string, time.Time) (ports.LegacySourceRecoveryRecord, error)
}

type LegacySourceRecoveryRuntime interface {
	InspectRuntime(context.Context, string) (ports.RuntimeInspection, error)
	DisableRuntime(context.Context, string, string, string) (ports.RuntimeOperation, error)
}

type LegacySourceRecoveryEgress interface {
	GetAgentNetwork(context.Context, string) (ports.NetworkAttachment, error)
	SetAgentNetworkAttachment(context.Context, string, string, uint64) (ports.NetworkAttachment, error)
}

type LegacySourceRecoveryService struct {
	store        LegacySourceRecoveryStore
	runtime      LegacySourceRecoveryRuntime
	egress       LegacySourceRecoveryEgress
	execution    ports.LifecycleExecution
	clock        ports.Clock
	drainTimeout time.Duration
}

func NewLegacySourceRecoveryService(store LegacySourceRecoveryStore, runtime LegacySourceRecoveryRuntime, egress LegacySourceRecoveryEgress,
	execution ports.LifecycleExecution, clock ports.Clock, drainTimeout time.Duration) *LegacySourceRecoveryService {
	return &LegacySourceRecoveryService{store: store, runtime: runtime, egress: egress, execution: execution, clock: clock, drainTimeout: drainTimeout}
}

func (s *LegacySourceRecoveryService) Replay(ctx context.Context, in LegacySourceRecoveryInput) (ports.LegacySourceRecoveryRecord, bool, error) {
	if !validIdentifier(in.RequestID) || !validIdentifier(in.AgentID) || !validLifecycleCaller(in.OrganizationID, in.ActorPrincipalID) {
		return ports.LegacySourceRecoveryRecord{}, false, ErrInvalidInput
	}
	fingerprint, err := requestFingerprint(in)
	if err != nil {
		return ports.LegacySourceRecoveryRecord{}, false, err
	}
	record, err := s.store.GetLegacySourceRecovery(ctx, in.RequestID)
	if errors.Is(err, ports.ErrNotFound) {
		return ports.LegacySourceRecoveryRecord{}, false, nil
	}
	if err != nil {
		return ports.LegacySourceRecoveryRecord{}, false, err
	}
	if record.OrganizationID != in.OrganizationID || record.AgentID != in.AgentID {
		return ports.LegacySourceRecoveryRecord{}, false, ErrAgentNotFound
	}
	if record.Fingerprint != fingerprint || record.ActorPrincipalID != in.ActorPrincipalID {
		return ports.LegacySourceRecoveryRecord{}, false, ports.ErrRequestConflict
	}
	return record, true, nil
}

func (s *LegacySourceRecoveryService) Get(ctx context.Context, organizationID, requestID string) (ports.LegacySourceRecoveryRecord, error) {
	if !validIdentifier(organizationID) || !validIdentifier(requestID) {
		return ports.LegacySourceRecoveryRecord{}, ErrInvalidInput
	}
	record, err := s.store.GetLegacySourceRecovery(ctx, requestID)
	if err != nil {
		return ports.LegacySourceRecoveryRecord{}, err
	}
	if record.OrganizationID != organizationID {
		return ports.LegacySourceRecoveryRecord{}, ports.ErrNotFound
	}
	return record, nil
}

// Current is used by the trusted workflow worker to compare a stage before and after an Activity.
func (s *LegacySourceRecoveryService) Current(ctx context.Context, requestID string) (ports.LegacySourceRecoveryRecord, error) {
	return s.store.GetLegacySourceRecovery(ctx, requestID)
}

func (s *LegacySourceRecoveryService) Admit(ctx context.Context, in LegacySourceRecoveryInput) (ports.LegacySourceRecoveryRecord, error) {
	record, found, err := s.Replay(ctx, in)
	if err != nil || found {
		return record, err
	}
	agent, err := s.store.GetAgent(ctx, in.AgentID)
	if errors.Is(err, ports.ErrNotFound) {
		return ports.LegacySourceRecoveryRecord{}, ErrAgentNotFound
	}
	if err != nil {
		return ports.LegacySourceRecoveryRecord{}, err
	}
	if agent.OrganizationID != in.OrganizationID {
		return ports.LegacySourceRecoveryRecord{}, ErrAgentNotFound
	}
	if agent.ActiveOperationRequestID != "" {
		return ports.LegacySourceRecoveryRecord{}, ErrLifecycleConflict
	}
	if agent.IdentityRevoked() || agent.FailureCode == legacyMigrationProofLostCode || agent.AgentSpecRevisionID == "" || agent.RuntimeRevision == "" ||
		agent.LifecycleState != domain.AgentCreated || agent.DesiredState != domain.DesiredEnabled || agent.ActivationState != domain.ActivationEnabled {
		return ports.LegacySourceRecoveryRecord{}, ErrLegacySourceRecoveryNotApplicable
	}
	marker, err := s.store.GetLegacySkillMigration(ctx, in.OrganizationID, in.AgentID)
	if errors.Is(err, ports.ErrNotFound) {
		return ports.LegacySourceRecoveryRecord{}, ErrLegacySourceRecoveryNotApplicable
	}
	if err != nil {
		return ports.LegacySourceRecoveryRecord{}, err
	}
	if marker.State != "pending" {
		return ports.LegacySourceRecoveryRecord{}, ErrLegacySourceRecoveryNotApplicable
	}
	inspection, err := s.runtime.InspectRuntime(ctx, in.AgentID)
	if err != nil {
		if legacySourceDependencyCode(err) == "runtime_not_found" {
			return ports.LegacySourceRecoveryRecord{}, ErrLegacySourceManualRecoveryRequired
		}
		return ports.LegacySourceRecoveryRecord{}, fmt.Errorf("%w: inspect source Runtime: %v", ErrDependencyUnavailable, err)
	}
	if inspection.AgentID != in.AgentID || inspection.RuntimeRevision != agent.RuntimeRevision || inspection.Phase != "running" ||
		inspection.LifecycleState != "provisioned" || inspection.RuntimeExecutionID == "" {
		return ports.LegacySourceRecoveryRecord{}, ErrLegacySourceManualRecoveryRequired
	}
	attachment, err := s.egress.GetAgentNetwork(ctx, in.AgentID)
	if err != nil {
		if legacySourceDependencyCode(err) == "agent_network_not_found" {
			return ports.LegacySourceRecoveryRecord{}, ErrLegacySourceManualRecoveryRequired
		}
		return ports.LegacySourceRecoveryRecord{}, fmt.Errorf("%w: inspect source Egress: %v", ErrDependencyUnavailable, err)
	}
	if !networkAttachmentInState(attachment, in.AgentID, ports.NetworkStateActive, ports.NetworkAttachmentOpen) {
		return ports.LegacySourceRecoveryRecord{}, ErrLegacySourceManualRecoveryRequired
	}
	now := s.clock.Now()
	fingerprint, err := requestFingerprint(in)
	if err != nil {
		return ports.LegacySourceRecoveryRecord{}, err
	}
	childID := domain.DeriveResourceID("acr", "legacy-source-disable/"+inspection.RuntimeRevision, in.RequestID)
	record, _, err = s.store.BeginLegacySourceRecovery(ctx, ports.BeginLegacySourceRecovery{
		RequestID: in.RequestID, Fingerprint: fingerprint, AgentID: in.AgentID, OrganizationID: in.OrganizationID,
		ActorPrincipalID: in.ActorPrincipalID, ExpectedAggregateSequence: agent.AggregateSequence, SourceSpecRevisionID: agent.AgentSpecRevisionID,
		SourceRuntimeRevision: agent.RuntimeRevision, ObservedRuntimeExecutionID: inspection.RuntimeExecutionID,
		ObservedAttachmentVersion: attachment.AttachmentResourceVersion, ChildRequestID: childID,
		DrainDeadlineAt: now.Add(s.drainTimeout).UTC().Truncate(time.Microsecond), Now: now,
	})
	if errors.Is(err, ports.ErrConcurrentChange) {
		return ports.LegacySourceRecoveryRecord{}, ErrLegacySourceRecoveryNotApplicable
	}
	return record, err
}

func (s *LegacySourceRecoveryService) Advance(ctx context.Context, requestID string) (ports.LegacySourceRecoveryRecord, error) {
	record, err := s.store.GetLegacySourceRecovery(ctx, requestID)
	if err != nil {
		return ports.LegacySourceRecoveryRecord{}, err
	}
	if record.State != "running" {
		return record, nil
	}
	switch record.Phase {
	case "drain":
		if !s.clock.Now().Before(record.DrainDeadlineAt) {
			return s.manual(ctx, record, "drain_not_settled")
		}
		if s.execution == nil {
			return record, ErrDependencyUnavailable
		}
		settled, err := s.execution.CloseAndSettle(ctx, ports.LifecycleSettlementRequest{
			OrganizationID: record.OrganizationID, AgentID: record.AgentID, OperationID: record.RequestID,
			Mode: "wait", DeadlineAt: record.DrainDeadlineAt,
		})
		if err != nil {
			return record, fmt.Errorf("%w: settle ACP execution: %v", ErrDependencyUnavailable, err)
		}
		if settled.Outcome == ports.ExecutionNotSettled {
			return record, nil
		}
		if settled.Outcome != ports.ExecutionSettled && settled.Outcome != ports.ExecutionRuntimeBarrierRequired {
			return record, fmt.Errorf("%w: invalid ACP settlement", ErrDependencyUnavailable)
		}
		return s.store.CompleteLegacySourceDrain(ctx, record.RequestID, record.Fingerprint, s.clock.Now())
	case "network_fence":
		attachment, err := s.egress.GetAgentNetwork(ctx, record.AgentID)
		if err != nil {
			return record, fmt.Errorf("%w: inspect source Egress: %v", ErrDependencyUnavailable, err)
		}
		if attachment.AttachmentState == ports.NetworkAttachmentClosed && attachment.AttachmentResourceVersion == record.ObservedAttachmentVersion+1 &&
			networkAttachmentInState(attachment, record.AgentID, ports.NetworkStateActive, ports.NetworkAttachmentClosed) {
			return s.store.RecordLegacySourceFence(ctx, record.RequestID, record.Fingerprint, attachment.AttachmentResourceVersion, s.clock.Now())
		}
		if !networkAttachmentInState(attachment, record.AgentID, ports.NetworkStateActive, ports.NetworkAttachmentOpen) ||
			attachment.AttachmentResourceVersion != record.ObservedAttachmentVersion {
			return s.manualAfterNetworkDrift(ctx, record, attachment)
		}
		closed, err := s.egress.SetAgentNetworkAttachment(ctx, record.AgentID, ports.NetworkAttachmentClosed, attachment.AttachmentResourceVersion)
		if err != nil {
			if errors.Is(err, ports.ErrConcurrentChange) || legacySourceDependencyCode(err) == "resource_version_conflict" {
				observed, readErr := s.egress.GetAgentNetwork(ctx, record.AgentID)
				if readErr != nil {
					return record, fmt.Errorf("%w: recheck source Egress: %v", ErrDependencyUnavailable, readErr)
				}
				if networkAttachmentInState(observed, record.AgentID, ports.NetworkStateActive, ports.NetworkAttachmentClosed) &&
					observed.AttachmentResourceVersion == record.ObservedAttachmentVersion+1 {
					return s.store.RecordLegacySourceFence(ctx, record.RequestID, record.Fingerprint, observed.AttachmentResourceVersion, s.clock.Now())
				}
				return s.manualAfterNetworkDrift(ctx, record, observed)
			}
			return record, fmt.Errorf("%w: close source Egress: %v", ErrDependencyUnavailable, err)
		}
		if !networkAttachmentInState(closed, record.AgentID, ports.NetworkStateActive, ports.NetworkAttachmentClosed) ||
			closed.AttachmentResourceVersion != record.ObservedAttachmentVersion+1 {
			return record, fmt.Errorf("%w: source Egress closure unconfirmed", ErrDependencyUnavailable)
		}
		return s.store.RecordLegacySourceFence(ctx, record.RequestID, record.Fingerprint, closed.AttachmentResourceVersion, s.clock.Now())
	case "disable_runtime":
		result, err := s.runtime.DisableRuntime(ctx, record.ChildRequestID, record.AgentID, record.SourceRuntimeRevision)
		if err != nil {
			var failure *ports.DependencyError
			if errors.As(err, &failure) && !failure.Retryable {
				return s.manual(ctx, record, "runtime_disable_rejected")
			}
			return record, fmt.Errorf("%w: disable source Runtime: %v", ErrDependencyUnavailable, err)
		}
		if result.State == "running" || result.State == "unknown" {
			return record, nil
		}
		if result.State == "failed" && result.Effect != "unknown" {
			return s.manual(ctx, record, "runtime_disable_rejected")
		}
		if !completedDisabledRuntime(result) {
			return record, fmt.Errorf("%w: unproven source Runtime result", ErrDependencyUnavailable)
		}
		return s.store.RecordLegacySourceRuntimeDisabled(ctx, record.RequestID, record.Fingerprint, record.ChildRequestID, result, s.clock.Now())
	case "publish":
		attachment, err := s.egress.GetAgentNetwork(ctx, record.AgentID)
		if err != nil {
			return record, fmt.Errorf("%w: recheck source Egress: %v", ErrDependencyUnavailable, err)
		}
		if !networkAttachmentInState(attachment, record.AgentID, ports.NetworkStateActive, ports.NetworkAttachmentClosed) ||
			attachment.AttachmentResourceVersion != record.ClosedAttachmentVersion {
			return s.manualAfterNetworkDrift(ctx, record, attachment)
		}
		published, err := s.store.PublishLegacySourceRecovery(ctx, record.RequestID, record.Fingerprint, attachment.AttachmentResourceVersion,
			domain.DeriveResourceID("event", "event-legacy-source-recovered", record.RequestID), currentTraceID(ctx), s.clock.Now())
		if errors.Is(err, ports.ErrConcurrentChange) {
			return s.manual(ctx, record, "publication_conflict")
		}
		return published, err
	default:
		return record, fmt.Errorf("%w: invalid source recovery phase", ErrLegacySourceManualRecoveryRequired)
	}
}

func (s *LegacySourceRecoveryService) manual(ctx context.Context, record ports.LegacySourceRecoveryRecord, reason string) (ports.LegacySourceRecoveryRecord, error) {
	return s.store.MarkLegacySourceManualRecovery(ctx, record.RequestID, record.Fingerprint, record.Phase, reason, s.clock.Now())
}

func (s *LegacySourceRecoveryService) manualAfterNetworkDrift(ctx context.Context, record ports.LegacySourceRecoveryRecord,
	attachment ports.NetworkAttachment) (ports.LegacySourceRecoveryRecord, error) {
	if networkAttachmentInState(attachment, record.AgentID, ports.NetworkStateActive, ports.NetworkAttachmentOpen) {
		closed, err := s.egress.SetAgentNetworkAttachment(ctx, record.AgentID, ports.NetworkAttachmentClosed,
			attachment.AttachmentResourceVersion)
		if err != nil {
			return record, fmt.Errorf("%w: refence changed source Egress: %v", ErrDependencyUnavailable, err)
		}
		attachment = closed
	}
	if !networkAttachmentInState(attachment, record.AgentID, ports.NetworkStateActive, ports.NetworkAttachmentClosed) {
		return record, fmt.Errorf("%w: changed source Egress closure is unconfirmed", ErrDependencyUnavailable)
	}
	return s.manual(ctx, record, "network_attachment_changed")
}

func legacySourceDependencyCode(err error) string {
	var failure *ports.DependencyError
	if errors.As(err, &failure) {
		return failure.Code
	}
	return ""
}
