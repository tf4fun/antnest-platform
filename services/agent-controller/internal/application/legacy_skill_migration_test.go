package application

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

type legacySkillGateStub struct {
	checked  []string
	required bool
}

type activeSkillVerifierStub struct {
	request ports.ActiveSkillSetVerificationRequest
	receipt ports.ActiveSkillSetVerificationReceipt
	err     error
	calls   int
}

type legacyMigrationPreflightStub struct {
	choice ports.LegacySkillChoice
	err    error
	calls  int
}

func (stub *legacyMigrationPreflightStub) VerifyLegacySkillMigrationPrerequisites(_ context.Context, _, _ string, _ int64, _ LegacyExportAttestation) (ports.LegacySkillChoice, error) {
	stub.calls++
	return stub.choice, stub.err
}

func TestExplicitLegacyMigrationAdmitsEmptySetWhileOrdinaryRebuildStaysBlocked(t *testing.T) {
	template, model := mustLifecycleTemplate(t), mustLifecycleModel(t)
	base := rebuildLifecycleBase(t, template, model)
	store := &rebuildLifecycleStoreStub{base: base}
	gate := &legacySkillGateStub{required: true}
	preflight := &legacyMigrationPreflightStub{choice: ports.LegacySkillChoice{RequestID: "choice-1", Sequence: 2,
		AgentID: base.Agent.AgentID, OrganizationID: base.Agent.OrganizationID, Kind: "empty"}}
	intents := &skillIntentStub{}
	service := newTestLifecycleService(lifecycleSpecSourceStub{template: template, model: model}, store,
		&rebuildDependenciesStub{}, &rebuildDependenciesStub{}, fixedClock{now: time.Unix(100, 0).UTC()},
		WithLegacySkillMigrationGate(gate), WithLegacyMigrationPreflight(preflight),
		WithSkillPreparation(intents, &skillPreparationClientStub{state: "ready"}))
	proof := LegacyExportAttestation{Version: 1, KeyID: "verifier-key", ExpiresAt: time.Unix(200, 0).UTC().Format(time.RFC3339Nano)}
	if _, err := service.RebuildAgent(context.Background(), RebuildAgentInput{RequestID: "ordinary-1", AgentID: base.Agent.AgentID,
		TemplateID: template.Snapshot().TemplateID, TemplateRevision: template.Revision()}); !errors.Is(err, ErrLegacySystemSkillsMigrationRequired) {
		t.Fatalf("ordinary rebuild admitted: %v", err)
	}
	result, err := service.MigrateLegacySkills(context.Background(), LegacySkillMigrationOperationInput{
		RequestID: "migration-1", OrganizationID: base.Agent.OrganizationID, ActorPrincipalID: "admin-1",
		AgentID: base.Agent.AgentID, ChoiceSequence: 2, Attestation: proof})
	if err != nil || result.Operation.RequestID != "migration-1" || store.begin.LegacyMigration == nil ||
		store.begin.LegacyMigration.ChoiceRequestID != "choice-1" || preflight.calls != 1 ||
		len(store.begin.TargetSpec.Snapshot.SystemSkills) != 0 || store.begin.TargetSpec.Snapshot.SkillSetDigest == "" ||
		store.begin.TargetSpec.Snapshot.ModelProfileID != base.ConfiguredSpec.Snapshot.ModelProfileID || intents.intent.State != "ready" {
		t.Fatalf("migration admission result=%+v begin=%+v intent=%+v preflight=%d err=%v", result, store.begin, intents.intent, preflight.calls, err)
	}
}

func TestLegacyMigrationPreflightFailureLeavesAgentAndPreparationUntouched(t *testing.T) {
	template, model := mustLifecycleTemplate(t), mustLifecycleModel(t)
	base := rebuildLifecycleBase(t, template, model)
	store := &rebuildLifecycleStoreStub{base: base}
	preflight := &legacyMigrationPreflightStub{err: ErrLegacyAttestationInvalid}
	intents := &skillIntentStub{}
	service := newTestLifecycleService(lifecycleSpecSourceStub{template: template, model: model}, store,
		&rebuildDependenciesStub{}, &rebuildDependenciesStub{}, fixedClock{now: time.Unix(100, 0).UTC()},
		WithLegacyMigrationPreflight(preflight), WithSkillPreparation(intents, &skillPreparationClientStub{state: "ready"}))
	_, err := service.MigrateLegacySkills(context.Background(), LegacySkillMigrationOperationInput{
		RequestID: "migration-1", OrganizationID: base.Agent.OrganizationID, ActorPrincipalID: "admin-1",
		AgentID: base.Agent.AgentID, ChoiceSequence: 1, Attestation: LegacyExportAttestation{Version: 1}})
	if !errors.Is(err, ErrLegacyAttestationInvalid) || preflight.calls != 1 || intents.reserved != 0 || store.begin.Operation.RequestID != "" {
		t.Fatalf("invalid proof mutated Agent: err=%v preflight=%d intent=%+v begin=%+v", err, preflight.calls, intents.intent, store.begin)
	}
}

func TestLegacyMigrationWithUnprovenEnabledSourceRequiresRecovery(t *testing.T) {
	template, model := mustLifecycleTemplate(t), mustLifecycleModel(t)
	base := rebuildLifecycleBase(t, template, model)
	base.SourceExecution = ports.ExecutionRecord{}
	store := &rebuildLifecycleStoreStub{base: base}
	intents := &skillIntentStub{}
	service := newTestLifecycleService(lifecycleSpecSourceStub{template: template, model: model}, store,
		&rebuildDependenciesStub{}, &rebuildDependenciesStub{}, fixedClock{now: time.Unix(100, 0).UTC()},
		WithSkillPreparation(intents, &skillPreparationClientStub{state: "ready"}))
	_, err := service.MigrateLegacySkills(context.Background(), LegacySkillMigrationOperationInput{
		RequestID: "migration-recovery", OrganizationID: base.Agent.OrganizationID, ActorPrincipalID: "admin-1",
		AgentID: base.Agent.AgentID, ChoiceSequence: 1, Attestation: LegacyExportAttestation{Version: 1}})
	if !errors.Is(err, ErrLegacyMigrationRecoveryRequired) || intents.reserved != 0 || store.begin.Operation.RequestID != "" {
		t.Fatalf("unproven source entered migration: err=%v intent=%+v begin=%+v", err, intents.intent, store.begin)
	}
}

func TestLegacyTemplateMigrationRejectsEmptyTemplateBeforePreparation(t *testing.T) {
	template, model := mustLifecycleTemplate(t), mustLifecycleModel(t)
	base := rebuildLifecycleBase(t, template, model)
	store := &rebuildLifecycleStoreStub{base: base}
	preflight := &legacyMigrationPreflightStub{choice: ports.LegacySkillChoice{RequestID: "choice-1", Sequence: 2,
		AgentID: base.Agent.AgentID, OrganizationID: base.Agent.OrganizationID, Kind: "template_revision",
		TemplateID: template.Snapshot().TemplateID, TemplateRevision: template.Revision()}}
	intents := &skillIntentStub{}
	service := newTestLifecycleService(lifecycleSpecSourceStub{template: template, model: model}, store,
		&rebuildDependenciesStub{}, &rebuildDependenciesStub{}, fixedClock{now: time.Unix(100, 0).UTC()},
		WithLegacyMigrationPreflight(preflight), WithSkillPreparation(intents, &skillPreparationClientStub{state: "ready"}))
	_, err := service.MigrateLegacySkills(context.Background(), LegacySkillMigrationOperationInput{
		RequestID: "migration-1", OrganizationID: base.Agent.OrganizationID, ActorPrincipalID: "admin-1",
		AgentID: base.Agent.AgentID, ChoiceSequence: 2, Attestation: LegacyExportAttestation{Version: 1, KeyID: "verifier-key", ExpiresAt: time.Unix(200, 0).UTC().Format(time.RFC3339Nano)}})
	if !errors.Is(err, ErrInvalidReference) || intents.reserved != 0 || store.begin.Operation.RequestID != "" {
		t.Fatalf("empty selected Template was admitted: err=%v intent=%+v begin=%+v", err, intents.intent, store.begin)
	}
}

func TestDisabledLegacyMigrationAdmitsControlledEnableWithClosedNetwork(t *testing.T) {
	base := enableLifecycleBase(t)
	store := &enableLifecycleStoreStub{base: base}
	preflight := &legacyMigrationPreflightStub{choice: ports.LegacySkillChoice{RequestID: "choice-1", Sequence: 2,
		AgentID: base.Agent.AgentID, OrganizationID: base.Agent.OrganizationID, Kind: "empty"}}
	intents := &skillIntentStub{}
	service := newTestLifecycleService(lifecycleSpecSourceStub{}, store, &rebuildDependenciesStub{}, &rebuildDependenciesStub{},
		fixedClock{now: time.Unix(100, 0).UTC()}, WithIdentityDirectory(activeIdentityDirectory()),
		WithLegacyMigrationPreflight(preflight), WithSkillPreparation(intents, &skillPreparationClientStub{state: "ready"}))
	result, err := service.MigrateLegacySkills(context.Background(), LegacySkillMigrationOperationInput{
		RequestID: "disabled-migration", OrganizationID: base.Agent.OrganizationID, ActorPrincipalID: "admin-1",
		AgentID: base.Agent.AgentID, ChoiceSequence: 2, Attestation: LegacyExportAttestation{Version: 1, KeyID: "verifier-key",
			ExpiresAt: time.Unix(200, 0).UTC().Format(time.RFC3339Nano)}})
	if err != nil || result.Operation.Kind != domain.OperationEnable || result.Operation.Phase != domain.PhaseNetworkEnsure ||
		store.begin.LegacyMigration == nil || store.begin.TargetSpec == nil || store.begin.TargetSpec.ID == base.Spec.ID ||
		store.state.Agent.ActivationState != domain.ActivationDisabled || intents.intent.State != "ready" {
		t.Fatalf("disabled migration result=%+v begin=%+v err=%v", result, store.begin, err)
	}
}

func TestDisabledLegacyMigrationVerifiesMountedSkillsBeforeOpeningNetwork(t *testing.T) {
	base := enableLifecycleBase(t)
	now := time.Unix(100, 0).UTC()
	closed := validLifecycleNetwork()
	closed.AgentID = base.Agent.AgentID
	closed.AttachmentState = ports.NetworkAttachmentClosed
	state := ports.AgentEnableState{Agent: base.Agent, Spec: base.Spec, SourceSpec: base.Spec,
		LegacyMigration: &ports.LegacySkillMigrationBinding{ChoiceRequestID: "choice-1", ChoiceSequence: 1},
		Operation: ports.LifecycleOperationRecord{RequestID: "disabled-migration", RequestFingerprint: "fingerprint-1",
			AgentID: base.Agent.AgentID, Kind: domain.OperationEnable, Phase: domain.PhaseNetworkRestore, State: domain.OperationRunning,
			NetworkAttachment: &closed, RuntimeResult: &ports.RuntimeOperation{
				State: "completed", Effect: "completed", RuntimeRevision: "rtv_55555555555555555555555555555555",
				LifecycleState: "provisioned", Health: "unknown"}}}
	store := &enableLifecycleStoreStub{base: base, state: state, replayed: true}
	deps := newEnableDependencies(base, readyEnableRuntime())
	intents := &skillIntentStub{intent: ports.SkillPreparationIntent{RequestID: state.Operation.RequestID,
		RequestFingerprint: state.Operation.RequestFingerprint, Kind: domain.OperationEnable,
		AgentID: base.Agent.AgentID, OrganizationID: base.Agent.OrganizationID, State: "ready",
		PreparedReferenceID: "psr_" + "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", TargetSpec: base.Spec.Snapshot}}
	verifier := &activeSkillVerifierStub{err: errors.New("mount missing")}
	service := newTestLifecycleService(lifecycleSpecSourceStub{}, store, deps, deps, fixedClock{now: now},
		WithSkillPreparation(intents, &skillPreparationClientStub{state: "ready"}), WithActiveSkillSetVerifier(verifier))
	if _, err := service.restoreEnableNetwork(context.Background(), state); !errors.Is(err, ErrDependencyUnavailable) || len(deps.calls) != 0 {
		t.Fatalf("opened network before mount verification: err=%v calls=%v", err, deps.calls)
	}
	verifier.err = nil
	verifier.receipt = ports.ActiveSkillSetVerificationReceipt{AgentID: base.Agent.AgentID,
		RuntimeRevision: state.Operation.RuntimeResult.RuntimeRevision, SkillSetDigest: base.Spec.Snapshot.SkillSetDigest,
		LayoutVersion: domain.SkillLayoutVersion, ManifestDigest: "sha256:" + strings.Repeat("a", 64), VerifiedAt: now}
	if _, err := service.restoreEnableNetwork(context.Background(), state); err != nil || len(deps.calls) != 1 ||
		deps.calls[0] != "egress.attachment.open" {
		t.Fatalf("verified mount did not open network: err=%v calls=%v", err, deps.calls)
	}
}

func (stub *activeSkillVerifierStub) VerifyActiveSkillSet(_ context.Context, _, _ string, request ports.ActiveSkillSetVerificationRequest) (ports.ActiveSkillSetVerificationReceipt, error) {
	stub.calls++
	stub.request = request
	return stub.receipt, stub.err
}

func TestLegacyMigrationPublishRequiresFreshActiveSkillMount(t *testing.T) {
	now := time.Unix(100, 0).UTC()
	template, model := mustLifecycleTemplate(t), mustLifecycleModel(t)
	base := rebuildLifecycleBase(t, template, model)
	targetRevision := "rtv_22222222222222222222222222222222"
	state := ports.AgentRebuildState{Agent: base.Agent, SourceSpec: base.ConfiguredSpec, SourceExecution: base.SourceExecution,
		TargetSpec: base.ConfiguredSpec, LegacyMigration: &ports.LegacySkillMigrationBinding{ChoiceRequestID: "choice-1", ChoiceSequence: 1},
		Operation: ports.LifecycleOperationRecord{RequestID: "migration-1", RequestFingerprint: "fingerprint-1", AgentID: base.Agent.AgentID,
			Kind: domain.OperationRebuild, Phase: domain.PhasePublish, State: domain.OperationRunning,
			RuntimeResult: &ports.RuntimeOperation{State: "completed", RuntimeRevision: targetRevision}}}
	store := &rebuildLifecycleStoreStub{base: base, state: state, replayed: true}
	intents := &skillIntentStub{intent: ports.SkillPreparationIntent{RequestID: "migration-1", RequestFingerprint: "fingerprint-1",
		Kind: domain.OperationRebuild, AgentID: base.Agent.AgentID, OrganizationID: base.Agent.OrganizationID,
		State: "ready", PreparedReferenceID: "psr_" + "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", TargetSpec: state.TargetSpec.Snapshot}}
	verifier := &activeSkillVerifierStub{err: errors.New("Runtime mount unavailable")}
	service := newTestLifecycleService(lifecycleSpecSourceStub{template: template, model: model}, store,
		&rebuildDependenciesStub{}, &rebuildDependenciesStub{}, fixedClock{now: now},
		WithSkillPreparation(intents, &skillPreparationClientStub{state: "ready"}), WithActiveSkillSetVerifier(verifier))
	if _, err := service.publishAgentRebuild(context.Background(), state); !errors.Is(err, ErrDependencyUnavailable) || store.published.RequestID != "" {
		t.Fatalf("unverified migration published: %v %+v", err, store.published)
	}
	verifier.err = nil
	verifier.receipt = ports.ActiveSkillSetVerificationReceipt{AgentID: base.Agent.AgentID, RuntimeRevision: "wrong-runtime",
		SkillSetDigest: state.TargetSpec.Snapshot.SkillSetDigest, LayoutVersion: domain.SkillLayoutVersion,
		ManifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", VerifiedAt: now}
	if _, err := service.publishAgentRebuild(context.Background(), state); !errors.Is(err, ErrDependencyUnavailable) || store.published.RequestID != "" {
		t.Fatalf("mismatched Runtime mount published: %v %+v", err, store.published)
	}
	verifier.receipt = ports.ActiveSkillSetVerificationReceipt{AgentID: base.Agent.AgentID, RuntimeRevision: targetRevision,
		SkillSetDigest: state.TargetSpec.Snapshot.SkillSetDigest, LayoutVersion: domain.SkillLayoutVersion,
		ManifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", VerifiedAt: now}
	if _, err := service.publishAgentRebuild(context.Background(), state); err != nil || store.published.LegacyVerification == nil ||
		store.published.LegacyVerification.PreparedReferenceID != intents.intent.PreparedReferenceID ||
		verifier.request.ExpectedRuntimeRevision != targetRevision || verifier.request.SystemSkills == nil || verifier.calls != 3 {
		t.Fatalf("verified migration publish=%+v request=%+v err=%v", store.published, verifier.request, err)
	}
}

type proofLossRebuildStore struct {
	*rebuildLifecycleStoreStub
	quarantined ports.QuarantineLifecycleOperation
}

func (store *proofLossRebuildStore) PublishAgentRebuild(context.Context, ports.PublishAgentRebuild) (ports.AgentRebuildState, error) {
	return ports.AgentRebuildState{}, ports.ErrLegacyMigrationProofLost
}

func (store *proofLossRebuildStore) QuarantineLifecycleOperation(_ context.Context, input ports.QuarantineLifecycleOperation) error {
	store.quarantined = input
	store.state.Operation.State, store.state.Operation.ErrorCode = domain.OperationFailed, input.ErrorCode
	store.state.Agent.RuntimeState = domain.RuntimeUnknown
	store.state.Agent.ActiveOperationRequestID = ""
	return nil
}

type proofLossEnableStore struct {
	*enableLifecycleStoreStub
	quarantined ports.QuarantineLifecycleOperation
}

func (store *proofLossEnableStore) PublishAgentEnable(context.Context, ports.PublishAgentEnable) (ports.AgentEnableState, error) {
	return ports.AgentEnableState{}, ports.ErrLegacyMigrationProofLost
}

func (store *proofLossEnableStore) QuarantineLifecycleOperation(_ context.Context, input ports.QuarantineLifecycleOperation) error {
	store.quarantined = input
	store.state.Operation.State, store.state.Operation.ErrorCode = domain.OperationFailed, input.ErrorCode
	store.state.Agent.RuntimeState = domain.RuntimeUnknown
	store.state.Agent.ActiveOperationRequestID = ""
	return nil
}

func TestLegacyProofLossAfterRuntimeEffectClosesNetworkAndSettlesBothPaths(t *testing.T) {
	now := time.Unix(100, 0).UTC()
	runtime := ports.RuntimeOperation{State: "completed", Effect: "completed", RuntimeRevision: "rtv_22222222222222222222222222222222",
		LifecycleState: "provisioned", Health: "unknown"}
	referenceID := "psr_" + strings.Repeat("a", 32)
	receipt := ports.ActiveSkillSetVerificationReceipt{RuntimeRevision: runtime.RuntimeRevision,
		LayoutVersion: domain.SkillLayoutVersion, ManifestDigest: "sha256:" + strings.Repeat("a", 64), VerifiedAt: now}
	t.Run("rebuild", func(t *testing.T) {
		template, model := mustLifecycleTemplate(t), mustLifecycleModel(t)
		base := rebuildLifecycleBase(t, template, model)
		state := ports.AgentRebuildState{Agent: base.Agent, SourceSpec: base.ConfiguredSpec, SourceExecution: base.SourceExecution,
			TargetSpec: base.ConfiguredSpec, LegacyMigration: &ports.LegacySkillMigrationBinding{ChoiceRequestID: "choice-1", ChoiceSequence: 1},
			Operation: ports.LifecycleOperationRecord{RequestID: "migration-rebuild", RequestFingerprint: "fingerprint", AgentID: base.Agent.AgentID,
				Kind: domain.OperationRebuild, Phase: domain.PhasePublish, State: domain.OperationRunning, RuntimeResult: &runtime}}
		store := &proofLossRebuildStore{rebuildLifecycleStoreStub: &rebuildLifecycleStoreStub{base: base, state: state, replayed: true}}
		deps := &rebuildDependenciesStub{network: validLifecycleNetwork()}
		intents := &skillIntentStub{intent: ports.SkillPreparationIntent{RequestID: state.Operation.RequestID,
			RequestFingerprint: state.Operation.RequestFingerprint, AgentID: base.Agent.AgentID, OrganizationID: base.Agent.OrganizationID,
			State: "ready", PreparedReferenceID: referenceID, TargetSpec: state.TargetSpec.Snapshot}}
		verified := receipt
		verified.AgentID, verified.SkillSetDigest = base.Agent.AgentID, state.TargetSpec.Snapshot.SkillSetDigest
		service := newTestLifecycleService(lifecycleSpecSourceStub{template: template, model: model}, store, deps, deps,
			fixedClock{now: now}, WithSkillPreparation(intents, &skillPreparationClientStub{state: "ready"}),
			WithActiveSkillSetVerifier(&activeSkillVerifierStub{receipt: verified}))
		result, err := service.publishAgentRebuild(context.Background(), state)
		if err != nil || result.Operation.State != domain.OperationFailed || result.Operation.ErrorCode != "legacy_migration_proof_lost" ||
			store.quarantined.RequestID != state.Operation.RequestID || !deps.attachmentClosed ||
			!reflect.DeepEqual(deps.calls, []string{"egress.get", "egress.attachment.closed"}) {
			t.Fatalf("proof loss left rebuild live: result=%+v quarantine=%+v calls=%v err=%v", result.Operation, store.quarantined, deps.calls, err)
		}
		store.state = state
		store.quarantined = ports.QuarantineLifecycleOperation{}
		deps.attachmentClosed = false
		deps.fenceErr = errors.New("egress unavailable")
		deps.calls = nil
		if _, err := service.publishAgentRebuild(context.Background(), state); !errors.Is(err, ErrDependencyUnavailable) ||
			store.quarantined.RequestID != "" || deps.attachmentClosed {
			t.Fatalf("failed network fence incorrectly settled proof loss: quarantine=%+v calls=%v err=%v", store.quarantined, deps.calls, err)
		}
	})
	t.Run("enable", func(t *testing.T) {
		base := enableLifecycleBase(t)
		state := ports.AgentEnableState{Agent: base.Agent, Spec: base.Spec, SourceSpec: base.Spec,
			LegacyMigration: &ports.LegacySkillMigrationBinding{ChoiceRequestID: "choice-1", ChoiceSequence: 1},
			Operation: ports.LifecycleOperationRecord{RequestID: "migration-enable", RequestFingerprint: "fingerprint", AgentID: base.Agent.AgentID,
				Kind: domain.OperationEnable, Phase: domain.PhasePublish, State: domain.OperationRunning, RuntimeResult: &runtime}}
		store := &proofLossEnableStore{enableLifecycleStoreStub: &enableLifecycleStoreStub{base: base, state: state, replayed: true}}
		deps := newEnableDependencies(base, runtime)
		deps.attachmentClosed = false
		intents := &skillIntentStub{intent: ports.SkillPreparationIntent{RequestID: state.Operation.RequestID,
			RequestFingerprint: state.Operation.RequestFingerprint, AgentID: base.Agent.AgentID, OrganizationID: base.Agent.OrganizationID,
			State: "ready", PreparedReferenceID: referenceID, TargetSpec: state.Spec.Snapshot}}
		verified := receipt
		verified.AgentID, verified.SkillSetDigest = base.Agent.AgentID, state.Spec.Snapshot.SkillSetDigest
		service := newTestLifecycleService(lifecycleSpecSourceStub{}, store, deps, deps, fixedClock{now: now},
			WithSkillPreparation(intents, &skillPreparationClientStub{state: "ready"}),
			WithActiveSkillSetVerifier(&activeSkillVerifierStub{receipt: verified}))
		result, err := service.publishAgentEnable(context.Background(), state)
		if err != nil || result.Operation.State != domain.OperationFailed || result.Operation.ErrorCode != "legacy_migration_proof_lost" ||
			store.quarantined.RequestID != state.Operation.RequestID || !deps.attachmentClosed ||
			!reflect.DeepEqual(deps.calls, []string{"egress.network.get", "egress.attachment.closed"}) {
			t.Fatalf("proof loss left enable live: result=%+v quarantine=%+v calls=%v err=%v", result.Operation, store.quarantined, deps.calls, err)
		}
	})
}

func (gate *legacySkillGateStub) LegacySystemSkillsMigrationRequired(_ context.Context, agentID string) (bool, error) {
	gate.checked = append(gate.checked, agentID)
	return gate.required, nil
}

func TestLegacySkillMigrationBlocksRebuildBeforeDrain(t *testing.T) {
	template, model := mustLifecycleTemplate(t), mustLifecycleModel(t)
	base := rebuildLifecycleBase(t, template, model)
	store := &rebuildLifecycleStoreStub{base: base}
	gate := &legacySkillGateStub{required: true}
	service := newTestLifecycleService(lifecycleSpecSourceStub{template: template, model: model}, store,
		&rebuildDependenciesStub{}, &rebuildDependenciesStub{}, fixedClock{now: time.Unix(100, 0).UTC()},
		WithLegacySkillMigrationGate(gate))
	_, err := service.RebuildAgent(context.Background(), RebuildAgentInput{RequestID: "legacy-rebuild", AgentID: base.Agent.AgentID,
		TemplateID: template.Snapshot().TemplateID, TemplateRevision: template.Revision()})
	if !errors.Is(err, ErrLegacySystemSkillsMigrationRequired) || store.begin.Operation.RequestID != "" || len(gate.checked) != 1 {
		t.Fatalf("legacy rebuild admitted: %v, %+v, %+v", err, store.begin, gate)
	}
}

func TestLegacySkillMigrationBlocksEnableBeforeNetworkEnsure(t *testing.T) {
	base := enableLifecycleBase(t)
	store := &enableLifecycleStoreStub{base: base}
	dependencies := newEnableDependencies(base, readyEnableRuntime())
	gate := &legacySkillGateStub{required: true}
	service := newTestLifecycleService(lifecycleSpecSourceStub{}, store, dependencies, dependencies,
		fixedClock{now: time.Unix(100, 0).UTC()}, WithIdentityDirectory(activeIdentityDirectory()),
		WithLegacySkillMigrationGate(gate))
	_, err := service.EnableAgent(context.Background(), EnableAgentInput{RequestID: "legacy-enable", AgentID: base.Agent.AgentID})
	if !errors.Is(err, ErrLegacySystemSkillsMigrationRequired) || store.state.Operation.Kind == domain.OperationEnable ||
		len(dependencies.calls) != 0 || len(gate.checked) != 1 {
		t.Fatalf("legacy Enable changed network: %v, %+v, %+v", err, store.state, dependencies.calls)
	}
}
