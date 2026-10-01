package application

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

type skillIntentStub struct {
	intent          ports.SkillPreparationIntent
	reserved        int
	ready           int
	released        int
	abandoned       int
	invalidated     int
	advanced        int
	advanceFailures int
}

func (stub *skillIntentStub) MarkSkillPreparationInvalidated(_ context.Context, requestID, fingerprint string, at time.Time) (ports.SkillPreparationIntent, error) {
	if stub.intent.RequestID != requestID || stub.intent.RequestFingerprint != fingerprint {
		return ports.SkillPreparationIntent{}, ports.ErrRequestConflict
	}
	stub.invalidated++
	stub.intent.State, stub.intent.UpdatedAt = "invalidated", at
	return stub.intent, nil
}
func (stub *skillIntentStub) AdvanceSkillPreparationAttempt(_ context.Context, requestID, fingerprint string, expected uint32, at time.Time) (ports.SkillPreparationIntent, error) {
	if stub.advanceFailures > 0 {
		stub.advanceFailures--
		return ports.SkillPreparationIntent{}, errors.New("simulated commit failure")
	}
	if stub.intent.RequestID != requestID || stub.intent.RequestFingerprint != fingerprint || stub.intent.State != "invalidated" || stub.intent.PreparationAttempt != expected {
		return ports.SkillPreparationIntent{}, ports.ErrRequestConflict
	}
	stub.advanced++
	stub.intent.PreparationAttempt++
	stub.intent.State, stub.intent.PreparedReferenceID, stub.intent.UpdatedAt = "preparing", "", at
	return stub.intent, nil
}

func TestInvalidatedPreparationRetriesAfterReleaseBeforeAttemptCommit(t *testing.T) {
	candidate := ports.SkillPreparationIntent{RequestID: "request-release-crash", RequestFingerprint: strings.Repeat("a", 64),
		Kind: domain.OperationRebuild, AgentID: "agent-1", OrganizationID: "org-1",
		TargetSpec: domain.AgentSpecSnapshot{SkillSetDigest: "sha256:" + strings.Repeat("b", 64), SystemSkills: []domain.FrozenSkill{{SkillID: "skill_11111111111111111111111111111111"}}}}
	intent := &skillIntentStub{intent: candidate, advanceFailures: 1}
	intent.intent.State, intent.intent.PreparedReferenceID = "invalidated", "psr_11111111111111111111111111111111"
	client := &skillPreparationClientStub{state: "ready"}
	service := &LifecycleService{skillIntents: intent, skillClient: client, clock: fixedClock{now: time.Unix(10, 0).UTC()}}
	if _, err := service.prepareAgentSkills(context.Background(), candidate); err == nil || client.releases != 1 || intent.intent.PreparationAttempt != 0 {
		t.Fatalf("release/commit interruption not preserved: %v, %+v, %+v", err, intent, client)
	}
	ready, err := service.prepareAgentSkills(context.Background(), candidate)
	if err != nil || ready.PreparationAttempt != 1 || client.releases != 2 || client.calls != 1 {
		t.Fatalf("release/commit recovery = %+v, %v, %+v", ready, err, client)
	}
}

func TestInvalidatedQueuedPreparationReleasesOldRequestWithoutReadyReference(t *testing.T) {
	candidate := ports.SkillPreparationIntent{RequestID: "request-queued-invalidated", RequestFingerprint: strings.Repeat("a", 64),
		Kind: domain.OperationCreate, AgentID: "agent-1", OrganizationID: "org-1",
		TargetSpec: domain.AgentSpecSnapshot{SkillSetDigest: "sha256:" + strings.Repeat("b", 64), SystemSkills: []domain.FrozenSkill{{SkillID: "skill_11111111111111111111111111111111"}}}}
	intent := &skillIntentStub{intent: candidate}
	intent.intent.State = "invalidated"
	client := &skillPreparationClientStub{state: "preparing"}
	service := &LifecycleService{skillIntents: intent, skillClient: client, clock: fixedClock{now: time.Unix(10, 0).UTC()}}
	_, err := service.prepareAgentSkills(context.Background(), candidate)
	if !errors.Is(err, ErrDependencyUnavailable) || client.releases != 1 || intent.intent.PreparationAttempt != 1 ||
		client.releaseRequestIDs[0] == client.requestIDs[0] {
		t.Fatalf("queued invalidation did not release old request: %v, %+v, %+v", err, intent, client)
	}
}

func (stub *skillIntentStub) MarkSkillPreparationAbandoned(_ context.Context, requestID, fingerprint string, at time.Time) (ports.SkillPreparationIntent, error) {
	if stub.intent.RequestID != requestID || stub.intent.RequestFingerprint != fingerprint {
		return ports.SkillPreparationIntent{}, ports.ErrRequestConflict
	}
	stub.abandoned++
	stub.intent.State, stub.intent.UpdatedAt = "abandoned", at
	return stub.intent, nil
}

func (stub *skillIntentStub) MarkSkillPreparationReleased(_ context.Context, requestID, fingerprint string, at time.Time) (ports.SkillPreparationIntent, error) {
	if stub.intent.RequestID != requestID || stub.intent.RequestFingerprint != fingerprint {
		return ports.SkillPreparationIntent{}, ports.ErrRequestConflict
	}
	stub.released++
	stub.intent.State, stub.intent.UpdatedAt = "released", at
	return stub.intent, nil
}

func (stub *skillIntentStub) ReserveSkillPreparation(_ context.Context, candidate ports.SkillPreparationIntent) (ports.SkillPreparationIntent, error) {
	stub.reserved++
	if stub.intent.RequestID == "" {
		candidate.State = "preparing"
		stub.intent = candidate
	}
	if stub.intent.RequestFingerprint != candidate.RequestFingerprint {
		return ports.SkillPreparationIntent{}, ports.ErrRequestConflict
	}
	return stub.intent, nil
}
func (stub *skillIntentStub) GetSkillPreparationIntent(_ context.Context, requestID string) (ports.SkillPreparationIntent, error) {
	if stub.intent.RequestID != requestID {
		return ports.SkillPreparationIntent{}, ports.ErrNotFound
	}
	return stub.intent, nil
}
func (stub *skillIntentStub) MarkSkillPreparationReady(_ context.Context, requestID, fingerprint, referenceID string, at time.Time) (ports.SkillPreparationIntent, error) {
	if stub.intent.RequestID != requestID || stub.intent.RequestFingerprint != fingerprint {
		return ports.SkillPreparationIntent{}, ports.ErrRequestConflict
	}
	stub.ready++
	stub.intent.State, stub.intent.PreparedReferenceID, stub.intent.UpdatedAt = "ready", referenceID, at
	return stub.intent, nil
}

type skillPreparationClientStub struct {
	state             string
	states            []string
	calls             int
	releases          int
	requestIDs        []string
	releaseRequestIDs []string
	request           ports.SkillPreparationRequest
}

type unavailableAfterFirstSkillSource struct {
	lifecycleSpecSourceStub
	unavailable bool
}

func (source *unavailableAfterFirstSkillSource) GetTemplateRevision(ctx context.Context, id string, revision int64) (domain.TemplateRevision, error) {
	if source.unavailable {
		return domain.TemplateRevision{}, errors.New("catalog unavailable")
	}
	return source.lifecycleSpecSourceStub.GetTemplateRevision(ctx, id, revision)
}
func (source *unavailableAfterFirstSkillSource) GetCurrentModelProfileRevision(ctx context.Context, id string) (domain.ModelProfileRevision, error) {
	if source.unavailable {
		return domain.ModelProfileRevision{}, errors.New("catalog unavailable")
	}
	return source.lifecycleSpecSourceStub.GetCurrentModelProfileRevision(ctx, id)
}

func (stub *skillPreparationClientStub) PrepareSkillSet(_ context.Context, requestID, agentID string, request ports.SkillPreparationRequest) (ports.SkillPreparationReceipt, error) {
	stub.calls++
	stub.requestIDs = append(stub.requestIDs, requestID)
	stub.request = request
	state := stub.state
	if len(stub.states) >= stub.calls {
		state = stub.states[stub.calls-1]
	}
	receipt := ports.SkillPreparationReceipt{RequestID: requestID, AgentID: agentID, OrganizationID: request.OrganizationID, OwnerOperationID: request.OwnerOperationID, State: state}
	if state == "ready" {
		receipt.PreparedSkillSet = &ports.PreparedSkillSet{SkillSetDigest: request.SkillSetDigest, LayoutVersion: request.LayoutVersion}
		receipt.PreparedReferenceID = "psr_11111111111111111111111111111111"
	}
	return receipt, nil
}
func (stub *skillPreparationClientStub) GetSkillPreparation(context.Context, string, string, string) (ports.SkillPreparationReceipt, error) {
	return ports.SkillPreparationReceipt{}, errors.New("unexpected query")
}
func (stub *skillPreparationClientStub) ReleaseSkillPreparation(_ context.Context, _, _, _, requestID, _ string) error {
	stub.releases++
	stub.releaseRequestIDs = append(stub.releaseRequestIDs, requestID)
	return nil
}

func TestInvalidatedPreparationUsesNewRequestAfterReleasingOldReference(t *testing.T) {
	candidate := ports.SkillPreparationIntent{RequestID: "request-invalidated", RequestFingerprint: strings.Repeat("a", 64),
		Kind: domain.OperationRebuild, AgentID: "agent-1", OrganizationID: "org-1",
		TargetSpec: domain.AgentSpecSnapshot{SkillSetDigest: "sha256:" + strings.Repeat("b", 64), SystemSkills: []domain.FrozenSkill{{SkillID: "skill_11111111111111111111111111111111"}}}}
	intent := &skillIntentStub{intent: candidate}
	intent.intent.State = "ready"
	intent.intent.PreparedReferenceID = "psr_11111111111111111111111111111111"
	client := &skillPreparationClientStub{states: []string{"invalidated", "ready"}}
	service := &LifecycleService{skillIntents: intent, skillClient: client, clock: fixedClock{now: time.Unix(10, 0).UTC()}}
	if _, err := service.prepareAgentSkills(context.Background(), candidate); !errors.Is(err, ErrDependencyUnavailable) || intent.intent.State != "invalidated" {
		t.Fatalf("first invalidation = %v, %+v", err, intent)
	}
	ready, err := service.prepareAgentSkills(context.Background(), candidate)
	if err != nil {
		t.Fatal(err)
	}
	if ready.State != "ready" || ready.PreparationAttempt != 1 || client.releases != 1 || client.calls != 2 ||
		client.releaseRequestIDs[0] != client.requestIDs[0] || client.requestIDs[0] == client.requestIDs[1] {
		t.Fatalf("stale reference reused: %+v %+v", intent, client)
	}
	if err := service.releasePreparedSkills(context.Background(), candidate.RequestID, candidate.RequestFingerprint); err != nil {
		t.Fatal(err)
	}
	if client.releases != 2 || client.releaseRequestIDs[1] != client.requestIDs[1] || intent.intent.State != "released" {
		t.Fatalf("final attempt reference not released: %+v %+v", intent, client)
	}
}

func TestFencedRebuildInvalidatedSetRestoresSourceAndReleasesReference(t *testing.T) {
	plain, model := mustLifecycleTemplate(t), mustLifecycleModel(t)
	base := rebuildLifecycleBase(t, plain, model)
	snapshot := plain.Snapshot()
	snapshot.SkillSetDigest = ""
	snapshot.SkillRefs = []domain.FrozenSkill{{SkillID: "skill_11111111111111111111111111111111", Version: 2,
		Name: "code-review", Description: "Review code", ArtifactDigest: "sha256:" + strings.Repeat("a", 64),
		ContentDigest: "sha256:" + strings.Repeat("b", 64), ArtifactSize: 100, UnpackedSize: 200, PackageRulesVersion: 1}}
	target, err := domain.NewTemplateRevision(domain.TemplateRevisionInput(snapshot))
	if err != nil {
		t.Fatal(err)
	}
	store := &rebuildLifecycleStoreStub{base: base}
	network := validLifecycleNetwork()
	network.AgentID = base.Agent.AgentID
	dependencies := &rebuildDependenciesStub{network: network, runtimeErr: &ports.DependencyError{
		Service: "runtime-controller", Code: "prepared_skill_set_invalidated", Retryable: false,
	}, inspection: ports.RuntimeInspection{
		AgentID: base.Agent.AgentID, RuntimeRevision: base.Agent.RuntimeRevision,
		RuntimeExecutionID: base.SourceExecution.RuntimeExecutionID, MCPEndpoint: base.SourceExecution.RuntimeMCPEndpoint,
		LifecycleState: "provisioned", Health: "healthy",
	}}
	intent, client := &skillIntentStub{}, &skillPreparationClientStub{state: "ready"}
	service := newTestLifecycleService(lifecycleSpecSourceStub{template: target, model: model}, store,
		dependencies, dependencies, fixedClock{now: time.Unix(100, 0).UTC()},
		WithLifecycleExecution(testExecutionForStore(store)), WithSkillPreparation(intent, client))
	command := LifecycleCommand{Kind: domain.OperationRebuild, RequestID: "request-fenced-invalidated", AgentID: base.Agent.AgentID,
		TemplateID: target.Snapshot().TemplateID, TemplateRevision: target.Revision()}
	if _, err := service.AdmitLifecycle(context.Background(), command); err != nil {
		t.Fatal(err)
	}
	for _, phase := range []domain.OperationPhase{domain.PhaseDrain, domain.PhaseNetworkFence, domain.PhaseRuntimeUpdate} {
		if _, err := service.AdvanceLifecycle(context.Background(), command, phase); err != nil {
			t.Fatalf("advance %s: %v", phase, err)
		}
	}
	if store.state.Operation.State != domain.OperationFailed || store.failed.Code != "prepared_skill_set_invalidated" ||
		!store.failed.PreserveExecutable || !store.state.Agent.ExecutionReady() || store.state.Agent.ActiveOperationRequestID != "" ||
		dependencies.attachmentClosed || client.releases != 1 || intent.intent.State != "released" {
		t.Fatalf("fenced source not restored: state=%+v failed=%+v dependencies=%+v intent=%+v", store.state, store.failed, dependencies, intent)
	}
}

func TestSkillPreparationReleaseMarksIntentAfterRCConfirmation(t *testing.T) {
	intent := &skillIntentStub{intent: ports.SkillPreparationIntent{RequestID: "request-build", RequestFingerprint: strings.Repeat("a", 64),
		AgentID: "agent-1", OrganizationID: "org-1", State: "ready", PreparedReferenceID: "psr_11111111111111111111111111111111"}}
	client := &skillPreparationClientStub{}
	service := &LifecycleService{skillIntents: intent, skillClient: client, clock: fixedClock{now: time.Unix(10, 0).UTC()}}
	if err := service.releasePreparedSkills(context.Background(), "request-build", intent.intent.RequestFingerprint); err != nil {
		t.Fatal(err)
	}
	if client.releases != 1 || intent.released != 1 || intent.intent.State != "released" {
		t.Fatalf("release not settled: %+v %+v", client, intent)
	}
	if err := service.releasePreparedSkills(context.Background(), "request-build", intent.intent.RequestFingerprint); err != nil {
		t.Fatal(err)
	}
	if client.releases != 1 {
		t.Fatal("released intent called RC twice")
	}
}

func TestEmptySkillCollectionStillRequiresOwnedPreparedReference(t *testing.T) {
	digest, err := domain.SkillSetDigest("org-1", nil)
	if err != nil {
		t.Fatal(err)
	}
	snapshot := domain.AgentSpecSnapshot{SkillSetDigest: digest}
	configuration := ports.RuntimeConfiguration{}
	withoutIntent := &LifecycleService{}
	if err := withoutIntent.attachPreparedSkills(context.Background(), "request-empty", "agent-1", "org-1", snapshot, &configuration); !errors.Is(err, ErrDependencyUnavailable) {
		t.Fatalf("empty collection reused legacy shared volume: %v", err)
	}
	intent := &skillIntentStub{intent: ports.SkillPreparationIntent{RequestID: "request-empty", AgentID: "agent-1", OrganizationID: "org-1", State: "ready", PreparedReferenceID: "psr_11111111111111111111111111111111", TargetSpec: snapshot}}
	service := &LifecycleService{skillIntents: intent}
	if err := service.attachPreparedSkills(context.Background(), "request-empty", "agent-1", "org-1", snapshot, &configuration); err != nil ||
		configuration.PreparedSkillSet == nil || configuration.PreparedSkillSet.SkillSetDigest != digest || configuration.SystemSkills == nil || len(configuration.SystemSkills) != 0 {
		t.Fatalf("empty collection attachment=%+v err=%v", configuration, err)
	}
}

func TestRejectedSkillPreparationAbandonsIntentAndReplaysRejection(t *testing.T) {
	intent := &skillIntentStub{}
	client := &skillPreparationClientStub{state: "rejected"}
	service := &LifecycleService{skillIntents: intent, skillClient: client, clock: fixedClock{now: time.Unix(10, 0).UTC()}}
	candidate := ports.SkillPreparationIntent{RequestID: "request-rejected", RequestFingerprint: strings.Repeat("a", 64),
		Kind: domain.OperationCreate, AgentID: "agent-1", OrganizationID: "org-1",
		TargetSpec: domain.AgentSpecSnapshot{SkillSetDigest: "sha256:" + strings.Repeat("b", 64), SystemSkills: []domain.FrozenSkill{{SkillID: "skill_11111111111111111111111111111111"}}}}
	_, err := service.prepareAgentSkills(context.Background(), candidate)
	if !errors.Is(err, ErrInvalidReference) || intent.intent.State != "abandoned" || intent.abandoned != 1 || client.releases != 1 {
		t.Fatalf("rejection not settled: %v, %+v", err, intent)
	}
	_, err = service.prepareAgentSkills(context.Background(), candidate)
	if !errors.Is(err, ErrInvalidReference) || client.calls != 1 {
		t.Fatalf("rejection replay called RC: %v, %+v", err, client)
	}
}

func TestCreateSkillAgentWaitsForReadyBeforeLifecycleAdmission(t *testing.T) {
	snapshot := mustLifecycleTemplate(t).Snapshot()
	snapshot.SkillSetDigest = ""
	snapshot.SkillRefs = []domain.FrozenSkill{{SkillID: "skill_11111111111111111111111111111111", Version: 2,
		Name: "code-review", Description: "Review code", ArtifactDigest: "sha256:" + strings.Repeat("a", 64),
		ContentDigest: "sha256:" + strings.Repeat("b", 64), ArtifactSize: 100, UnpackedSize: 200, PackageRulesVersion: 1}}
	template, err := domain.NewTemplateRevision(domain.TemplateRevisionInput(snapshot))
	if err != nil {
		t.Fatal(err)
	}
	store := &lifecycleStoreStub{}
	intent := &skillIntentStub{}
	client := &skillPreparationClientStub{state: "preparing"}
	source := &unavailableAfterFirstSkillSource{lifecycleSpecSourceStub: lifecycleSpecSourceStub{template: template, model: mustLifecycleModel(t)}}
	dependencies := &lifecycleDependenciesStub{network: validLifecycleNetwork(), runtime: ports.RuntimeOperation{
		State: "completed", Effect: "completed", RuntimeRevision: "rtv_11111111111111111111111111111111",
		LifecycleState: "provisioned", Health: "unknown",
	}}
	service := newTestLifecycleService(source, store,
		dependencies, dependencies, fixedClock{now: time.Unix(10, 0).UTC()},
		WithIdentityDirectory(activeIdentityDirectory()), WithSkillPreparation(intent, client))
	input := lifecycleCreateInput("request-skill-agent")
	_, err = service.CreateAgent(context.Background(), input)
	if !errors.Is(err, ErrDependencyUnavailable) || store.initial.Operation.RequestID != "" {
		t.Fatalf("preparing admitted Agent: %v, %+v", err, store.initial)
	}
	if intent.reserved != 1 || client.calls != 1 || intent.ready != 0 {
		t.Fatalf("preparation not persisted/started: %+v %+v", intent, client)
	}
	client.state = "ready"
	source.unavailable = true // The retry must read the frozen target from the intent.
	result, err := service.CreateAgent(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	if result.Operation.Phase != domain.PhaseNetworkEnsure || intent.ready != 1 || store.initial.Spec.Snapshot.SkillSetDigest != template.Snapshot().SkillSetDigest {
		t.Fatalf("ready Agent not admitted with frozen Skills: %+v %+v", result, store.initial.Spec.Snapshot)
	}
	if client.request.OwnerOperationID != input.RequestID || len(client.request.SystemSkills) != 1 {
		t.Fatalf("wrong RC request: %+v", client.request)
	}
	for _, phase := range []domain.OperationPhase{domain.PhaseNetworkEnsure, domain.PhaseRuntimeInitialize, domain.PhasePublish} {
		if _, err := service.AdvanceAgentCreate(context.Background(), input, phase); err != nil {
			t.Fatalf("advance %s: %v", phase, err)
		}
	}
	if dependencies.runtimeConfiguration.PreparedReferenceID != intent.intent.PreparedReferenceID ||
		dependencies.runtimeConfiguration.PreparedSkillSet == nil || client.releases != 1 || intent.intent.State != "released" {
		t.Fatalf("Runtime consumption or release missing: %+v, %+v, %+v", dependencies.runtimeConfiguration, client, intent)
	}
}

func TestPreparedRuntimeConfigurationUsesPersistedReference(t *testing.T) {
	intent := &skillIntentStub{intent: ports.SkillPreparationIntent{
		RequestID: "request-build", AgentID: "agent-1", OrganizationID: "org-1",
		State: "ready", PreparedReferenceID: "psr_11111111111111111111111111111111",
	}}
	service := &LifecycleService{skillIntents: intent}
	configuration := ports.RuntimeConfiguration{}
	snapshot := domain.AgentSpecSnapshot{SkillSetDigest: "sha256:" + strings.Repeat("a", 64),
		SystemSkills: []domain.FrozenSkill{{SkillID: "skill_11111111111111111111111111111111"}}}
	intent.intent.TargetSpec = snapshot
	if err := service.attachPreparedSkills(context.Background(), "request-build", "agent-1", "org-1", snapshot, &configuration); err != nil {
		t.Fatal(err)
	}
	if configuration.OrganizationID != "org-1" || configuration.PreparedReferenceID != intent.intent.PreparedReferenceID ||
		configuration.PreparedSkillSet == nil || configuration.PreparedSkillSet.SkillSetDigest != snapshot.SkillSetDigest || len(configuration.SystemSkills) != 1 {
		t.Fatalf("Runtime configuration omitted prepared collection: %+v", configuration)
	}
}

func TestRebuildSkillPreparationPrecedesDrain(t *testing.T) {
	plain := mustLifecycleTemplate(t)
	model := mustLifecycleModel(t)
	base := rebuildLifecycleBase(t, plain, model)
	snapshot := plain.Snapshot()
	snapshot.SkillSetDigest = ""
	snapshot.SkillRefs = []domain.FrozenSkill{{SkillID: "skill_11111111111111111111111111111111", Version: 2,
		Name: "code-review", Description: "Review code", ArtifactDigest: "sha256:" + strings.Repeat("a", 64),
		ContentDigest: "sha256:" + strings.Repeat("b", 64), ArtifactSize: 100, UnpackedSize: 200, PackageRulesVersion: 1}}
	target, err := domain.NewTemplateRevision(domain.TemplateRevisionInput(snapshot))
	if err != nil {
		t.Fatal(err)
	}
	store := &rebuildLifecycleStoreStub{base: base}
	intent, client := &skillIntentStub{}, &skillPreparationClientStub{state: "preparing"}
	service := newTestLifecycleService(lifecycleSpecSourceStub{template: target, model: model}, store,
		&rebuildDependenciesStub{}, &rebuildDependenciesStub{}, fixedClock{now: time.Unix(100, 0).UTC()},
		WithSkillPreparation(intent, client))
	_, err = service.RebuildAgent(context.Background(), RebuildAgentInput{RequestID: "request-skill-rebuild", AgentID: base.Agent.AgentID,
		TemplateID: target.Snapshot().TemplateID, TemplateRevision: target.Revision()})
	if !errors.Is(err, ErrDependencyUnavailable) || store.begin.Operation.RequestID != "" || base.Agent.ActiveOperationRequestID != "" {
		t.Fatalf("rebuild entered Drain before Skills were ready: %v, %+v", err, store.begin)
	}
}

func TestEnableSkillPreparationPrecedesNetworkEnsure(t *testing.T) {
	base := enableLifecycleBase(t)
	base.Spec.Snapshot.SystemSkills = []domain.FrozenSkill{{SkillID: "skill_11111111111111111111111111111111"}}
	base.Spec.Snapshot.SkillSetDigest = "sha256:" + strings.Repeat("a", 64)
	store := &enableLifecycleStoreStub{base: base}
	intent, client := &skillIntentStub{}, &skillPreparationClientStub{state: "preparing"}
	dependencies := newEnableDependencies(base, readyEnableRuntime())
	service := newTestLifecycleService(lifecycleSpecSourceStub{}, store, dependencies, dependencies, fixedClock{now: time.Unix(100, 0).UTC()},
		WithIdentityDirectory(activeIdentityDirectory()), WithSkillPreparation(intent, client))
	_, err := service.EnableAgent(context.Background(), EnableAgentInput{RequestID: "request-skill-enable", AgentID: base.Agent.AgentID})
	if !errors.Is(err, ErrDependencyUnavailable) || store.state.Operation.RequestID != "" || len(dependencies.calls) != 0 {
		t.Fatalf("enable changed network before Skills were ready: %v, %+v, %v", err, store.state, dependencies.calls)
	}
}
