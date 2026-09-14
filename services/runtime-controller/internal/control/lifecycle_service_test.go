package control

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"soft/antnest-platform/services/runtime-controller/internal/deployment"
	"soft/antnest-platform/services/runtime-controller/internal/platform"
	repositoryport "soft/antnest-platform/services/runtime-controller/internal/repository"
)

func TestRuntimeLifecycleCommandsHidePhysicalResourceSteps(t *testing.T) {
	t.Parallel()
	repository := newLifecycleRepository()
	platform := newLifecyclePlatform()
	service := newLifecycleService(t, repository, platform)
	configuration := lifecycleConfiguration()

	initialized, err := service.InitializeRuntime(context.Background(), "initialize-1", "agent-1", configuration)
	if err != nil || initialized.State != deployment.OperationCompleted {
		t.Fatalf("initialize: operation=%+v err=%v", initialized, err)
	}
	ready := requireLifecycleEnvironment(t, repository, "agent-1", deployment.LifecycleProvisioned)
	if ready.Generation != 1 || ready.RuntimeRevision == "" {
		t.Fatalf("initialize did not allocate private identity: %+v", ready)
	}

	updated, err := service.UpdateRuntime(
		context.Background(), "update-1", "agent-1", ready.RuntimeRevision, configuration,
	)
	if err != nil || updated.State != deployment.OperationCompleted {
		t.Fatalf("update: operation=%+v err=%v", updated, err)
	}
	ready = requireLifecycleEnvironment(t, repository, "agent-1", deployment.LifecycleProvisioned)
	if ready.Generation != 2 || ready.RuntimeRevision == initialized.RuntimeRevision {
		t.Fatalf("update did not replace private compute: %+v", ready)
	}

	disabled, err := service.DisableRuntime(
		context.Background(), "disable-1", "agent-1", ready.RuntimeRevision,
	)
	if err != nil || disabled.State != deployment.OperationCompleted {
		t.Fatalf("disable: operation=%+v err=%v", disabled, err)
	}
	disabledEnvironment := requireLifecycleEnvironment(t, repository, "agent-1", deployment.LifecycleDisabled)
	if platform.deleteStorageCalls != 0 {
		t.Fatalf("disable deleted persistent workspace")
	}

	enabled, err := service.EnableRuntime(
		context.Background(), "enable-1", "agent-1", disabledEnvironment.RuntimeRevision, configuration,
	)
	if err != nil || enabled.State != deployment.OperationCompleted {
		t.Fatalf("enable: operation=%+v err=%v", enabled, err)
	}
	ready = requireLifecycleEnvironment(t, repository, "agent-1", deployment.LifecycleProvisioned)
	if ready.Generation != 3 || platform.verifyStorageCalls != 0 {
		t.Fatalf("enable did not reuse workspace with a new private generation: env=%+v verify=%d",
			ready, platform.verifyStorageCalls)
	}

	deleted, err := service.DeleteRuntime(
		context.Background(), "delete-1", "agent-1", ready.RuntimeRevision,
	)
	if err != nil || deleted.State != deployment.OperationCompleted {
		t.Fatalf("delete: operation=%+v err=%v", deleted, err)
	}
	requireLifecycleEnvironment(t, repository, "agent-1", deployment.LifecycleDeleted)
	if platform.ensureStorageCalls != 1 || platform.deleteStorageCalls != 1 {
		t.Fatalf("workspace lifecycle leaked or repeated: ensure=%d delete=%d",
			platform.ensureStorageCalls, platform.deleteStorageCalls)
	}
}

func TestLifecycleRejectsStaleRevisionBeforePlatformMutation(t *testing.T) {
	t.Parallel()
	repository := newLifecycleRepository()
	repository.environments["agent-1"] = deployment.Environment{
		AgentID: "agent-1", RuntimeRevision: deployment.RevisionFor("old", lifecycleDigest),
		LifecycleState: deployment.LifecycleProvisioned, Health: deployment.HealthHealthy,
		Generation: 4, SpecDigest: lifecycleDigest, ObservedAt: lifecycleNow,
	}
	platform := newLifecyclePlatform()
	service := newLifecycleService(t, repository, platform)

	_, err := service.UpdateRuntime(
		context.Background(), "update-1", "agent-1",
		deployment.RevisionFor("stale", lifecycleDigest), lifecycleConfiguration(),
	)
	if !errors.Is(err, ErrRevisionConflict) {
		t.Fatalf("stale revision error=%v", err)
	}
	if platform.mutationCalls() != 0 {
		t.Fatalf("stale update reached platform: %d calls", platform.mutationCalls())
	}
}

func TestLifecycleReportsExistingTransitionBeforeStateConflict(t *testing.T) {
	t.Parallel()
	repository := newLifecycleRepository()
	repository.environments["agent-1"] = deployment.Environment{
		AgentID: "agent-1", RuntimeRevision: deployment.RevisionFor("active", lifecycleDigest),
		LifecycleState: deployment.LifecycleUpdating, Health: deployment.HealthUnknown,
		Generation: 4, SpecDigest: lifecycleDigest, OperationID: "active-update",
		ObservedAt: lifecycleNow,
	}
	platform := newLifecyclePlatform()
	service := newLifecycleService(t, repository, platform)

	_, err := service.DisableRuntime(
		context.Background(), "disable-1", "agent-1",
		deployment.RevisionFor("active", lifecycleDigest),
	)
	if !errors.Is(err, ErrAgentMutationInProgress) {
		t.Fatalf("concurrent transition error=%v", err)
	}
	if platform.mutationCalls() != 0 {
		t.Fatalf("concurrent transition reached platform: %d calls", platform.mutationCalls())
	}
}

func TestUpdateRetainsRecoverySlotAfterOldComputeWasRemoved(t *testing.T) {
	t.Parallel()
	repository := newLifecycleRepository()
	currentRevision := deployment.RevisionFor("old", lifecycleDigest)
	repository.environments["agent-1"] = deployment.Environment{
		AgentID: "agent-1", RuntimeRevision: currentRevision,
		LifecycleState: deployment.LifecycleProvisioned, Health: deployment.HealthHealthy,
		Generation: 4, SpecDigest: lifecycleDigest, ObservedAt: lifecycleNow,
	}
	platform := newLifecyclePlatform()
	platform.createOutcome = deployment.EffectOutcome{
		State: deployment.EffectNotStarted, Code: "platform_unavailable", Detail: "image unavailable",
	}
	service := newLifecycleService(t, repository, platform)

	operation, err := service.UpdateRuntime(
		context.Background(), "update-1", "agent-1", currentRevision, lifecycleConfiguration(),
	)
	if err != nil || operation.State != deployment.OperationUnknown {
		t.Fatalf("destructive update did not remain recoverable: operation=%+v err=%v", operation, err)
	}
	environment := requireLifecycleEnvironment(t, repository, "agent-1", deployment.LifecycleUnknown)
	if environment.OperationID != "update-1" {
		t.Fatalf("unknown update released mutation ownership: %+v", environment)
	}
}

func TestInitializeFailureRetainsWorkspaceAndLogicalEnvironment(t *testing.T) {
	t.Parallel()
	repository := newLifecycleRepository()
	platform := newLifecyclePlatform()
	platform.createOutcome = deployment.EffectOutcome{
		State: deployment.EffectNotStarted, Code: "platform_unavailable", Detail: "image unavailable",
	}
	service := newLifecycleService(t, repository, platform)

	operation, err := service.InitializeRuntime(
		context.Background(), "initialize-failed", "agent-1", lifecycleConfiguration(),
	)
	if err != nil || operation.State != deployment.OperationFailed {
		t.Fatalf("failed initialize: operation=%+v err=%v", operation, err)
	}
	if environment, err := repository.GetEnvironment(context.Background(), "agent-1"); err != nil || environment.LifecycleState != deployment.LifecycleFailed || environment.OperationID != "" {
		t.Fatalf("failed initialize lost resource ownership: %+v %v", environment, err)
	}
	if platform.ensureStorageCalls != 1 || platform.deleteStorageCalls != 0 {
		t.Fatalf("failed initialize workspace lifecycle: ensure=%d delete=%d",
			platform.ensureStorageCalls, platform.deleteStorageCalls)
	}
}

func TestDeleteDisabledRuntimeRemovesOnlyRetainedWorkspace(t *testing.T) {
	t.Parallel()
	repository := newLifecycleRepository()
	platform := newLifecyclePlatform()
	service := newLifecycleService(t, repository, platform)
	initialized, err := service.InitializeRuntime(
		context.Background(), "initialize-1", "agent-1", lifecycleConfiguration(),
	)
	if err != nil {
		t.Fatal(err)
	}
	disabled, err := service.DisableRuntime(
		context.Background(), "disable-1", "agent-1", initialized.RuntimeRevision,
	)
	if err != nil {
		t.Fatal(err)
	}
	deleteCalls := platform.deleteCalls
	deleted, err := service.DeleteRuntime(
		context.Background(), "delete-1", "agent-1", disabled.RuntimeRevision,
	)
	if err != nil || deleted.State != deployment.OperationCompleted {
		t.Fatalf("delete disabled Runtime: operation=%+v err=%v", deleted, err)
	}
	if platform.deleteCalls != deleteCalls || platform.deleteStorageCalls != 1 {
		t.Fatalf("delete disabled Runtime repeated compute deletion: compute=%d want=%d storage=%d",
			platform.deleteCalls, deleteCalls, platform.deleteStorageCalls)
	}
}

func TestTerminalLifecycleRequestReplayDoesNotRepeatPlatformMutation(t *testing.T) {
	t.Parallel()
	repository := newLifecycleRepository()
	platform := newLifecyclePlatform()
	service := newLifecycleService(t, repository, platform)
	configuration := lifecycleConfiguration()
	first, err := service.InitializeRuntime(
		context.Background(), "initialize-1", "agent-1", configuration,
	)
	if err != nil {
		t.Fatal(err)
	}
	calls := platform.mutationCalls()
	replayed, err := service.InitializeRuntime(
		context.Background(), "initialize-1", "agent-1", configuration,
	)
	if err != nil || replayed.RuntimeRevision != first.RuntimeRevision {
		t.Fatalf("terminal replay: operation=%+v err=%v", replayed, err)
	}
	if platform.mutationCalls() != calls {
		t.Fatalf("terminal replay repeated platform mutation: calls=%d want=%d",
			platform.mutationCalls(), calls)
	}
}

func TestObservationCursorExpiryRequiresProjectionReset(t *testing.T) {
	t.Parallel()
	repository := newLifecycleRepository()
	repository.observations = []deployment.Observation{
		{Sequence: 10, Kind: deployment.ObservationReconciled},
		{Sequence: 11, Kind: deployment.ObservationReconciled},
	}
	service := newLifecycleService(t, repository, newLifecyclePlatform())

	_, err := service.ListObservations(context.Background(), 4, 10)
	var expired *ObservationCursorExpiredError
	if !errors.As(err, &expired) || expired.ResetSequence != 11 {
		t.Fatalf("expired cursor: error=%v reset=%d", err, expiredReset(expired))
	}
	window, err := service.ListObservations(context.Background(), 0, 10)
	if err != nil || window.OldestSequence != 10 || window.LatestSequence != 11 ||
		len(window.Observations) != 2 {
		t.Fatalf("bootstrap observation window: window=%+v err=%v", window, err)
	}
}

func TestReconcileRetainedStorageRecordsDisabledWorkspaceDrift(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		name   string
		code   string
		kind   deployment.ObservationKind
		detail string
	}{
		{
			name: "missing", code: "storage_not_found",
			kind:   deployment.ObservationStorageMissing,
			detail: "Retained Agent workspace is missing",
		},
		{
			name: "foreign ownership", code: "storage_ownership_conflict",
			kind:   deployment.ObservationStorageDrift,
			detail: "Retained Agent workspace has conflicting ownership",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			repository := newLifecycleRepository()
			repository.environments["agent-1"] = disabledLifecycleEnvironment("agent-1")
			repository.claims[deployment.Key{AgentID: "agent-1", Generation: 7}] = repositoryport.GenerationClaim{
				RuntimeRevision: lifecycleRevision, SpecDigest: lifecycleDigest,
			}
			platform := newLifecyclePlatform()
			platform.verifyStorageOutcome = deployment.EffectOutcome{
				State: deployment.EffectNotStarted, Code: test.code,
			}
			service := newLifecycleService(t, repository, platform)

			if err := service.ReconcileRetainedStorage(context.Background()); err != nil {
				t.Fatal(err)
			}
			if len(repository.observations) != 1 || repository.observations[0].Kind != test.kind ||
				repository.observations[0].DiagnosticSummary != test.detail ||
				repository.observations[0].RuntimeRevision != lifecycleRevision ||
				repository.observations[0].Generation != 0 ||
				repository.observations[0].SpecDigest != "" {
				t.Fatalf("workspace observation = %+v", repository.observations)
			}
		})
	}
}

func TestDisabledRuntimeInspectionSurfacesWorkspaceDriftWithoutBreakingLogicalList(t *testing.T) {
	t.Parallel()
	repository := newLifecycleRepository()
	repository.environments["agent-1"] = disabledLifecycleEnvironment("agent-1")
	platform := newLifecyclePlatform()
	platform.verifyStorageOutcome = deployment.EffectOutcome{
		State: deployment.EffectNotStarted, Code: "storage_not_found",
	}
	service := newLifecycleService(t, repository, platform)

	values, err := service.ListRuntimes(context.Background())
	if err != nil || len(values) != 1 || values[0].LifecycleState != deployment.LifecycleDisabled ||
		values[0].Health != deployment.HealthUnhealthy {
		t.Fatalf("disabled Runtime list = %+v, err=%v", values, err)
	}
}

func TestReconcileExpectedRuntimeInventoryRecordsMissingReadyCompute(t *testing.T) {
	t.Parallel()
	repository := newLifecycleRepository()
	repository.environments["missing-agent"] = deployment.Environment{
		AgentID: "missing-agent", RuntimeRevision: lifecycleRevision,
		LifecycleState: deployment.LifecycleProvisioned, Generation: 7, SpecDigest: lifecycleDigest,
		ObservedAt: lifecycleNow,
	}
	repository.claims[deployment.Key{AgentID: "missing-agent", Generation: 7}] = repositoryport.GenerationClaim{
		RuntimeRevision: lifecycleRevision, SpecDigest: lifecycleDigest,
	}
	repository.environments["present-agent"] = deployment.Environment{
		AgentID: "present-agent", RuntimeRevision: lifecycleRevision,
		LifecycleState: deployment.LifecycleProvisioned, Generation: 8, SpecDigest: lifecycleDigest,
		ObservedAt: lifecycleNow,
	}
	service := newLifecycleService(t, repository, newLifecyclePlatform())

	err := service.ReconcileExpectedRuntimes(context.Background(), []deployment.Inspection{{
		AgentID: "present-agent", Generation: 8, SpecDigest: lifecycleDigest,
		PlatformPhase: deployment.PhaseRunning, Health: deployment.HealthHealthy,
	}})
	if err != nil {
		t.Fatal(err)
	}
	if len(repository.observations) != 1 {
		t.Fatalf("missing compute observations = %+v", repository.observations)
	}
	observation := repository.observations[0]
	if observation.Kind != deployment.ObservationRuntimeMissing || observation.AgentID != "missing-agent" ||
		observation.Generation != 7 || observation.RuntimeRevision != lifecycleRevision {
		t.Fatalf("missing compute observation = %+v", observation)
	}
}

func TestReconcileRetainedStorageSkipsReadyAndFailsOnUnknownPlatformOutcome(t *testing.T) {
	t.Parallel()
	repository := newLifecycleRepository()
	repository.environments["ready-agent"] = deployment.Environment{
		AgentID: "ready-agent", RuntimeRevision: lifecycleRevision,
		LifecycleState: deployment.LifecycleProvisioned, Generation: 7, SpecDigest: lifecycleDigest,
	}
	repository.environments["disabled-agent"] = disabledLifecycleEnvironment("disabled-agent")
	platform := newLifecyclePlatform()
	platform.verifyStorageOutcome = deployment.EffectOutcome{
		State: deployment.EffectUnknown, Code: "platform_unavailable",
	}
	service := newLifecycleService(t, repository, platform)

	if err := service.ReconcileRetainedStorage(context.Background()); err == nil {
		t.Fatal("inconclusive workspace verification was accepted")
	}
	if platform.verifyStorageCalls != 1 || len(repository.observations) != 0 {
		t.Fatalf("unexpected reconciliation side effects: verify=%d observations=%+v",
			platform.verifyStorageCalls, repository.observations)
	}
}

func disabledLifecycleEnvironment(agentID string) deployment.Environment {
	return deployment.Environment{
		AgentID: agentID, RuntimeRevision: lifecycleRevision,
		LifecycleState: deployment.LifecycleDisabled, Health: deployment.HealthAbsent,
		Generation: 7, SpecDigest: lifecycleDigest, ObservedAt: lifecycleNow,
	}
}

func expiredReset(value *ObservationCursorExpiredError) uint64 {
	if value == nil {
		return 0
	}
	return value.ResetSequence
}

func newLifecycleService(t *testing.T, repository *lifecycleRepository, platform *lifecyclePlatform) *Service {
	t.Helper()
	service, err := NewService(
		repository, repository, lifecycleObservationReadiness{}, platform, lifecycleVerifier{},
		func() time.Time { return lifecycleNow }, time.Minute,
	)
	if err != nil {
		t.Fatalf("new service: %v", err)
	}
	return service
}

func requireLifecycleEnvironment(
	t *testing.T, repository *lifecycleRepository, agentID string, state deployment.LifecycleState,
) deployment.Environment {
	t.Helper()
	value, err := repository.GetEnvironment(context.Background(), agentID)
	if err != nil || value.LifecycleState != state {
		t.Fatalf("environment state=%q err=%v value=%+v", state, err, value)
	}
	return value
}

const lifecycleDigest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

const lifecycleRevision = deployment.RuntimeRevision("rtv_0123456789abcdef0123456789abcdef")

var lifecycleNow = time.Date(2026, 8, 31, 12, 0, 0, 0, time.UTC)

func lifecycleConfiguration() deployment.Configuration {
	return deployment.Configuration{
		ImageRef: "antnest/runtime@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		Network: deployment.NetworkSpec{
			PacketContractRevision: 1,
			EgressEndpoint:         deployment.IPv4Endpoint{IPv4: "10.20.0.8", Port: 8092},
			TunnelIPv4:             "100.64.0.2",
			ResolverIPv4:           "100.64.0.1",
		},
		Resources: deployment.ResourceLimits{MemoryBytes: 2 << 30, PidsLimit: 512, TmpfsBytes: 512 << 20},
	}
}

type lifecycleRepository struct {
	mu           sync.Mutex
	operations   map[string]deployment.Operation
	environments map[string]deployment.Environment
	claims       map[deployment.Key]repositoryport.GenerationClaim
	observations []deployment.Observation
}

func newLifecycleRepository() *lifecycleRepository {
	return &lifecycleRepository{
		operations:   make(map[string]deployment.Operation),
		environments: make(map[string]deployment.Environment),
		claims:       make(map[deployment.Key]repositoryport.GenerationClaim),
	}
}

func (r *lifecycleRepository) Ready(context.Context) error { return nil }

func (r *lifecycleRepository) WithAgentLock(
	ctx context.Context, _ string, execute func(context.Context) error,
) error {
	return execute(ctx)
}

func (r *lifecycleRepository) BeginTransition(
	_ context.Context, candidate deployment.Operation,
) (deployment.Operation, bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if stored, ok := r.operations[candidate.RequestID]; ok {
		if stored.RequestDigest != candidate.RequestDigest || stored.Kind != candidate.Kind || stored.AgentID != candidate.AgentID {
			return deployment.Operation{}, false, ErrRequestConflict
		}
		if stored.State == deployment.OperationRunning || stored.State == deployment.OperationUnknown {
			stored.Attempt++
			r.operations[stored.RequestID] = stored
			current := r.environments[stored.AgentID]
			current.OperationID = stored.RequestID
			r.environments[stored.AgentID] = current
		}
		return stored, true, nil
	}
	for _, stored := range r.operations {
		if stored.AgentID == candidate.AgentID &&
			(stored.State == deployment.OperationRunning || stored.State == deployment.OperationUnknown) {
			return deployment.Operation{}, false, ErrAgentMutationInProgress
		}
	}
	transition := candidate.Transition
	r.operations[candidate.RequestID] = candidate
	r.environments[candidate.AgentID] = deployment.Environment{
		AgentID: candidate.AgentID, RuntimeRevision: candidate.RuntimeRevision,
		LifecycleState: transition, Health: deployment.HealthUnknown,
		Generation: candidate.Generation, SpecDigest: candidate.SpecDigest,
		OperationID: candidate.RequestID, ObservedAt: lifecycleNow,
	}
	if candidate.CreatesCompute() {
		r.claims[candidate.RuntimeKey()] = repositoryport.GenerationClaim{
			RuntimeRevision: candidate.RuntimeRevision, SpecDigest: candidate.SpecDigest,
		}
	}
	return candidate, false, nil
}

func (r *lifecycleRepository) CompleteOperation(
	_ context.Context, operation deployment.Operation, observation *deployment.Observation,
) (*deployment.Observation, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.operations[operation.RequestID] = operation
	if operation.State == deployment.OperationUnknown {
		current := r.environments[operation.AgentID]
		current.LifecycleState = deployment.LifecycleUnknown
		r.environments[operation.AgentID] = current
	} else if operation.State == deployment.OperationCompleted {
		state, _ := operation.SuccessState()
		current := r.environments[operation.AgentID]
		current.LifecycleState = state
		current.OperationID = ""
		current.Health = deployment.HealthAbsent
		if operation.Inspection != nil {
			current = *operation.Inspection
			current.OperationID = ""
		}
		r.environments[operation.AgentID] = current
	} else if operation.SourceState == deployment.LifecycleUninitialized {
		if operation.Inspection == nil {
			return nil, errors.New("failed Initialize has no environment")
		}
		environment := *operation.Inspection
		environment.OperationID = ""
		r.environments[operation.AgentID] = environment
	} else {
		r.environments[operation.AgentID] = deployment.Environment{
			AgentID: operation.AgentID, RuntimeRevision: operation.SourceRevision,
			LifecycleState: operation.SourceState, Health: deployment.HealthUnknown,
			Generation: operation.SourceGeneration, SpecDigest: operation.SourceSpecDigest,
			ObservedAt: lifecycleNow,
		}
	}
	if observation != nil {
		value := *observation
		value.Sequence = uint64(len(r.observations) + 1)
		r.observations = append(r.observations, value)
		return &value, nil
	}
	return nil, nil
}

func (r *lifecycleRepository) GetOperation(_ context.Context, requestID string) (deployment.Operation, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	value, ok := r.operations[requestID]
	if !ok {
		return deployment.Operation{}, ErrNotFound
	}
	return value, nil
}

func (r *lifecycleRepository) GetEnvironment(_ context.Context, agentID string) (deployment.Environment, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	value, ok := r.environments[agentID]
	if !ok {
		return deployment.Environment{}, ErrNotFound
	}
	return value, nil
}

func (r *lifecycleRepository) ListEnvironments(context.Context) ([]deployment.Environment, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	result := make([]deployment.Environment, 0, len(r.environments))
	for _, value := range r.environments {
		if value.LifecycleState != deployment.LifecycleDeleted {
			result = append(result, value)
		}
	}
	return result, nil
}

func (r *lifecycleRepository) GenerationClaim(
	_ context.Context, key deployment.Key,
) (repositoryport.GenerationClaim, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	value, ok := r.claims[key]
	if !ok {
		return repositoryport.GenerationClaim{}, ErrNotFound
	}
	return value, nil
}

func (r *lifecycleRepository) AppendObservation(
	_ context.Context, value deployment.Observation,
) (deployment.Observation, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	value.Sequence = uint64(len(r.observations) + 1)
	r.observations = append(r.observations, value)
	return value, nil
}

func (r *lifecycleRepository) ListObservations(
	_ context.Context, after uint64, limit int,
) (deployment.ObservationWindow, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	window := deployment.ObservationWindow{Observations: make([]deployment.Observation, 0, limit)}
	if len(r.observations) > 0 {
		window.OldestSequence = r.observations[0].Sequence
		window.LatestSequence = r.observations[len(r.observations)-1].Sequence
	}
	for _, value := range r.observations {
		if value.Sequence > after && len(window.Observations) < limit {
			window.Observations = append(window.Observations, value)
		}
	}
	return window, nil
}

type lifecyclePlatform struct {
	imageID              string
	resolveCalls         int
	resolveError         error
	deployments          []deployment.Deployment
	ensureStorageCalls   int
	verifyStorageCalls   int
	createCalls          int
	deleteCalls          int
	deleteStorageCalls   int
	createOutcome        deployment.EffectOutcome
	deleteOutcome        deployment.EffectOutcome
	verifyStorageOutcome deployment.EffectOutcome
	containers           map[string]deployment.Inspection
}

func newLifecyclePlatform() *lifecyclePlatform {
	return &lifecyclePlatform{
		imageID:              lifecycleDigest,
		createOutcome:        deployment.EffectOutcome{State: deployment.EffectCompleted},
		deleteOutcome:        deployment.EffectOutcome{State: deployment.EffectCompleted},
		verifyStorageOutcome: deployment.EffectOutcome{State: deployment.EffectCompleted},
		containers:           make(map[string]deployment.Inspection),
	}
}

func (*lifecyclePlatform) Ready(context.Context) error { return nil }
func (p *lifecyclePlatform) ResolveImage(_ context.Context, reference string) (platform.ImageResolution, error) {
	p.resolveCalls++
	return platform.ImageResolution{Reference: reference, ImageRef: p.imageID}, p.resolveError
}
func (*lifecyclePlatform) DeploymentDigest(value deployment.Deployment) (string, error) {
	return deployment.DigestValue(struct {
		MappingRevision uint32
		Deployment      deployment.Deployment
	}{MappingRevision: 1, Deployment: value})
}
func (p *lifecyclePlatform) EnsureStorage(context.Context, string) deployment.EffectOutcome {
	p.ensureStorageCalls++
	return deployment.EffectOutcome{State: deployment.EffectCompleted}
}
func (p *lifecyclePlatform) VerifyStorage(context.Context, string) deployment.EffectOutcome {
	p.verifyStorageCalls++
	return p.verifyStorageOutcome
}
func (p *lifecyclePlatform) DeleteStorage(context.Context, string) deployment.EffectOutcome {
	p.deleteStorageCalls++
	return deployment.EffectOutcome{State: deployment.EffectCompleted}
}
func (p *lifecyclePlatform) Create(
	_ context.Context, value deployment.Deployment, digest string,
) deployment.EffectOutcome {
	p.createCalls++
	p.deployments = append(p.deployments, value)
	if p.createOutcome.State == deployment.EffectCompleted {
		p.containers[value.RuntimeSpec.AgentID] = deployment.Inspection{
			AgentID: value.RuntimeSpec.AgentID, Generation: value.RuntimeSpec.Generation,
			SpecDigest: digest, PlatformPhase: deployment.PhaseRunning,
			Health: deployment.HealthHealthy, MCPEndpoint: "http://runtime/mcp",
			StatusEndpoint: "http://runtime/status", ObservedAt: lifecycleNow,
		}
	}
	return p.createOutcome
}
func (p *lifecyclePlatform) Inspect(_ context.Context, key deployment.Key) (deployment.Inspection, error) {
	value, ok := p.containers[key.AgentID]
	if !ok {
		return deployment.Inspection{
			AgentID: key.AgentID, Generation: key.Generation,
			PlatformPhase: deployment.PhaseAbsent, Health: deployment.HealthAbsent,
			ObservedAt: lifecycleNow,
		}, nil
	}
	return value, nil
}
func (p *lifecyclePlatform) Delete(
	_ context.Context, key deployment.Key, _ string,
) deployment.EffectOutcome {
	p.deleteCalls++
	if p.deleteOutcome.State == deployment.EffectCompleted {
		delete(p.containers, key.AgentID)
	}
	return p.deleteOutcome
}
func (p *lifecyclePlatform) List(context.Context) ([]deployment.Inspection, error) {
	result := make([]deployment.Inspection, 0, len(p.containers))
	for _, value := range p.containers {
		result = append(result, value)
	}
	return result, nil
}
func (p *lifecyclePlatform) mutationCalls() int {
	return p.ensureStorageCalls + p.createCalls + p.deleteCalls + p.deleteStorageCalls
}

type lifecycleVerifier struct{}

func (lifecycleVerifier) Verify(_ context.Context, value deployment.Inspection) (deployment.Inspection, error) {
	value.RuntimeExecutionID = "execution-1"
	return value, nil
}

type lifecycleObservationReadiness struct{}

func (lifecycleObservationReadiness) ObservationReady() error { return nil }
