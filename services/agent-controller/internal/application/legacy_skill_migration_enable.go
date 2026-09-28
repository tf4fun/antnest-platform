package application

import (
	"context"
	"errors"
	"fmt"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func legacyMigrationEnableFingerprint(input LegacySkillMigrationOperationInput) (string, error) {
	return requestFingerprint(struct {
		Kind                                                 string
		RequestID, OrganizationID, ActorPrincipalID, AgentID string
		ChoiceSequence                                       int64
		Attestation                                          LegacyExportAttestation
	}{"legacy-skill-enable-v1", input.RequestID, input.OrganizationID, input.ActorPrincipalID,
		input.AgentID, input.ChoiceSequence, input.Attestation})
}

func validateLegacyMigrationOperationInput(input LegacySkillMigrationOperationInput) error {
	if !validIdentifier(input.RequestID) || !validIdentifier(input.AgentID) ||
		!validLifecycleCaller(input.OrganizationID, input.ActorPrincipalID) ||
		input.ChoiceSequence < 1 || input.Attestation.Version != 1 {
		return ErrInvalidInput
	}
	return nil
}

func (service *LifecycleService) migrateDisabledLegacySkills(ctx context.Context, input LegacySkillMigrationOperationInput) (EnableAgentResult, error) {
	if err := validateLegacyMigrationOperationInput(input); err != nil {
		return EnableAgentResult{}, err
	}
	fingerprint, err := legacyMigrationEnableFingerprint(input)
	if err != nil {
		return EnableAgentResult{}, err
	}
	state, found, err := service.store.ReplayAgentEnable(ctx, input.RequestID, fingerprint)
	if err != nil {
		return EnableAgentResult{}, fmt.Errorf("replay legacy Skill Enable: %w", err)
	}
	if found {
		if !lifecycleScopeMatches(state.Agent.OrganizationID, input.OrganizationID) {
			return EnableAgentResult{}, ErrAgentNotFound
		}
		return enableAgentResult(state), nil
	}
	base, err := service.store.GetAgentEnableBase(ctx, input.AgentID)
	if errors.Is(err, ports.ErrNotFound) {
		return EnableAgentResult{}, ErrAgentNotFound
	}
	if err != nil {
		return EnableAgentResult{}, err
	}
	if !lifecycleScopeMatches(base.Agent.OrganizationID, input.OrganizationID) {
		return EnableAgentResult{}, ErrAgentNotFound
	}
	if err := validateEnableSource(base); err != nil {
		return EnableAgentResult{}, err
	}
	authorization, err := service.authorizeOwner(ctx, base.Agent.OrganizationID, base.Agent.OwnerUserID)
	if err != nil {
		return EnableAgentResult{}, err
	}
	choice, err := service.preflightLegacyMigration(ctx, base.Agent.OrganizationID, input.AgentID, &input)
	if err != nil {
		return EnableAgentResult{}, err
	}
	intent, existing, err := service.existingSkillPreparation(ctx, input.RequestID, fingerprint, domain.OperationEnable, input.AgentID, base.Agent.OrganizationID)
	if err != nil {
		return EnableAgentResult{}, err
	}
	var snapshot domain.AgentSpecSnapshot
	var digest string
	if existing {
		snapshot, digest = intent.TargetSpec, intent.TargetSpecDigest
	} else if choice.Kind == "empty" {
		snapshot, digest, err = emptyLegacyMigrationTarget(base.Agent.OrganizationID, base.Spec.Snapshot)
	} else {
		var spec domain.AgentSpec
		_, _, spec, err = service.resolveAgentSpecRevision(ctx, base.Agent.OrganizationID, choice.TemplateID, choice.TemplateRevision)
		if err == nil {
			snapshot = spec.Snapshot()
			digest, err = spec.Digest()
		}
	}
	if err != nil {
		return EnableAgentResult{}, err
	}
	if err := validateLegacyMigrationTarget(base.Agent.OrganizationID, base.Spec.Snapshot, snapshot, choice); err != nil {
		return EnableAgentResult{}, err
	}
	now := service.clock.Now()
	prepared, err := service.prepareAgentSkills(ctx, ports.SkillPreparationIntent{
		RequestID: input.RequestID, RequestFingerprint: fingerprint, Kind: domain.OperationEnable,
		AgentID: input.AgentID, OrganizationID: base.Agent.OrganizationID,
		TargetSpec: snapshot, TargetSpecDigest: digest,
		ExpectedAggregateSequence: base.Agent.AggregateSequence,
		ExpectedSpecRevisionID:    base.Spec.ID, ExpectedExecutionRevisionID: base.LastSuccessfulExecution.ID,
		ExpectedRuntimeRevision: base.Agent.RuntimeRevision, CreatedAt: now, UpdatedAt: now,
	})
	if err != nil {
		return EnableAgentResult{}, err
	}
	targetID := domain.DeriveResourceID("agentspec", "agentspec-legacy-enable", input.RequestID)
	binding, err := legacyMigrationBinding(choice, input.Attestation)
	if err != nil {
		return EnableAgentResult{}, err
	}
	operation, err := domain.NewLifecycleOperation(domain.NewLifecycleOperationInput{
		RequestID: input.RequestID, RequestFingerprint: fingerprint, AgentID: input.AgentID, Kind: domain.OperationEnable,
		SourceSpecRevision: base.Spec.ID, SourceExecutionRevision: base.LastSuccessfulExecution.ID,
		SourceRuntimeRevision: base.Agent.RuntimeRevision, TargetSpecRevision: targetID, Now: now,
	})
	if err != nil {
		return EnableAgentResult{}, fmt.Errorf("%w: %v", ErrInvalidInput, err)
	}
	target := ports.AgentSpecRecord{ID: targetID, AgentID: input.AgentID, Revision: base.NextSpecRevision,
		Snapshot: prepared.TargetSpec, CanonicalDigest: prepared.TargetSpecDigest, CreatedAt: now}
	state, _, err = service.store.BeginAgentEnable(ctx, ports.BeginAgentEnable{
		OwnerAuthorizationSequence: authorization.LastRevocationSequence,
		AgentID:                    input.AgentID, ExpectedAggregateSequence: base.Agent.AggregateSequence,
		ExpectedSpecRevisionID: base.Spec.ID, ExpectedExecutionRevisionID: base.LastSuccessfulExecution.ID,
		ExpectedRuntimeRevision: base.Agent.RuntimeRevision, TargetSpec: &target, LegacyMigration: &binding,
		Operation: ports.LifecycleOperationRecord{
			RequestID: input.RequestID, RequestFingerprint: fingerprint, AgentID: input.AgentID,
			Kind: domain.OperationEnable, Phase: operation.Phase(), State: operation.State(),
			SourceSpecRevisionID: base.Spec.ID, SourceExecutionRevisionID: base.LastSuccessfulExecution.ID,
			SourceRuntimeRevision: base.Agent.RuntimeRevision, TargetSpecRevisionID: targetID,
			ChildRequestID: operation.ChildRequestID(), CreatedAt: now, UpdatedAt: now,
		},
		RequestedEvent: ports.AgentEventRecord{
			EventID: domain.DeriveResourceID("event", "event-legacy-enable-requested", input.RequestID),
			AgentID: input.AgentID, AggregateSequence: base.Agent.AggregateSequence + 1,
			SchemaVersion: 1, EventType: ports.EventAgentEnableRequested,
			OperationRequestID: input.RequestID, TraceID: currentTraceID(ctx),
			Data: map[string]any{"actor_principal_id": input.ActorPrincipalID, "agent_spec_revision_id": targetID,
				"source_execution_revision_id": base.LastSuccessfulExecution.ID, "source_runtime_revision": base.Agent.RuntimeRevision},
			OccurredAt: now,
		}, Now: now,
	})
	if err != nil {
		return EnableAgentResult{}, fmt.Errorf("begin legacy Skill Enable: %w", err)
	}
	return enableAgentResult(state), nil
}
