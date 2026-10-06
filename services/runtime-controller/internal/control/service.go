package control

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/instanceauth"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/platform"
	platformdocker "github.com/tf4fun/antnest-platform/services/runtime-controller/internal/platform/docker"
	repositoryport "github.com/tf4fun/antnest-platform/services/runtime-controller/internal/repository"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/skillset"
)

var (
	ErrInvalidRequest              = errors.New("invalid request")
	ErrRequestConflict             = repositoryport.ErrIdempotencyConflict
	ErrOperationFinalized          = repositoryport.ErrOperationFinalized
	ErrMutationLockLost            = repositoryport.ErrLockLost
	ErrAgentMutationInProgress     = repositoryport.ErrConcurrentMutation
	ErrLifecycleConflict           = repositoryport.ErrTransitionConflict
	ErrRevisionConflict            = repositoryport.ErrRevisionConflict
	ErrDrift                       = repositoryport.ErrInvariantConflict
	ErrNotFound                    = repositoryport.ErrNotFound
	ErrPreparedSkillSetInvalidated = repositoryport.ErrPreparedSkillSetInvalidated
	ErrSkillPreflightUnavailable   = errors.New("prepared Skill volume preflight is unavailable")
)

const operationFinalizeBudget = 5 * time.Second

type mutationDeadlineKey struct{}

type ObservationCursorExpiredError struct {
	ResetSequence uint64
}

func (e *ObservationCursorExpiredError) Error() string {
	return "Runtime observation cursor is outside the retained journal"
}

type ObservationReadiness interface {
	ObservationReady() error
	MonitorReady() bool
}

type RuntimeVerifier interface {
	Verify(context.Context, deployment.Inspection) (deployment.Inspection, error)
}

type SkillVolumeInspector interface {
	InspectPreparedVolume(context.Context, skillset.PreparedMaterialization) error
}

type Service struct {
	instanceCredentials  *instanceauth.Manager
	instanceScope        string
	repository           repositoryport.Store
	locker               repositoryport.MutationLocker
	observations         ObservationReadiness
	platform             platform.Lifecycle
	verifier             RuntimeVerifier
	now                  func() time.Time
	mutationTimeout      time.Duration
	skillScope           string
	skillInspector       SkillVolumeInspector
	maintenanceVerifiers deployment.MaintenanceVerifiers
}

func (s *Service) SetInstanceCredentials(scope string, manager *instanceauth.Manager) error {
	if manager == nil || (instanceauth.Identity{Scope: scope, AgentID: "validation", Generation: 1}).Validate() != nil {
		return fmt.Errorf("instance credential issuer and Controller scope are required")
	}
	s.instanceCredentials, s.instanceScope = manager, scope
	return nil
}

func (s *Service) SetMaintenanceVerifiers(input deployment.MaintenanceVerifiers) error {
	canonical, err := input.Normalize()
	if err != nil {
		return err
	}
	s.maintenanceVerifiers = canonical
	return nil
}

func (s *Service) SetSkillVolumeInspector(inspector SkillVolumeInspector) {
	s.skillInspector = inspector
}

type Readiness struct {
	DatabaseReady    bool
	PlatformReady    bool
	ObservationReady bool
	MonitorReady     bool
}

func (r Readiness) Ready() bool {
	return r.LocalReady() && r.MonitorReady
}

func (r Readiness) LocalReady() bool {
	return r.DatabaseReady && r.PlatformReady && r.ObservationReady
}

func NewService(
	repository repositoryport.Store,
	locker repositoryport.MutationLocker,
	observations ObservationReadiness,
	platform platform.Lifecycle,
	verifier RuntimeVerifier,
	now func() time.Time,
	mutationTimeout time.Duration,
	skillScope ...string,
) (*Service, error) {
	if repository == nil || locker == nil || observations == nil || platform == nil || verifier == nil || now == nil {
		return nil, fmt.Errorf("repository, mutation locker, observation health, platform, Runtime verifier, and clock are required")
	}
	if mutationTimeout <= 0 {
		return nil, fmt.Errorf("positive mutation timeout is required")
	}
	if len(skillScope) > 1 {
		return nil, fmt.Errorf("one Controller scope is allowed")
	}
	service := &Service{
		repository: repository, locker: locker, observations: observations,
		platform: platform, verifier: verifier, now: now, mutationTimeout: mutationTimeout,
	}
	if len(skillScope) == 1 {
		service.skillScope = skillScope[0]
	}
	return service, nil
}

func (s *Service) Status(ctx context.Context) (Readiness, error) {
	var status Readiness
	var result error
	if err := s.repository.Ready(ctx); err != nil {
		result = errors.Join(result, fmt.Errorf("operation store: %w", err))
	} else {
		status.DatabaseReady = true
	}
	if err := s.observations.ObservationReady(); err != nil {
		result = errors.Join(result, fmt.Errorf("observation pipeline: %w", err))
	} else {
		status.ObservationReady = true
	}
	// The public field retains its shape but reports local adapter initialization.
	// Docker/Runtime reachability is observed by actual lifecycle operations.
	status.PlatformReady = s.platform != nil
	status.MonitorReady = s.observations.MonitorReady()
	if ctx.Err() != nil {
		result = errors.Join(result, ctx.Err())
	}
	return status, result
}

func (s *Service) InitializeRuntime(
	ctx context.Context, requestID, agentID string, configuration deployment.Configuration,
) (deployment.Operation, error) {
	return s.lifecycle(ctx, lifecycleRequest{
		RequestID: requestID, AgentID: agentID,
		Kind: deployment.OperationInitializeRuntime, Configuration: &configuration,
	})
}

func (s *Service) ResolveImage(ctx context.Context, reference string) (platform.ImageResolution, error) {
	return s.platform.ResolveImage(ctx, reference)
}

func (s *Service) UpdateRuntime(
	ctx context.Context,
	requestID, agentID string,
	expectedRevision deployment.RuntimeRevision,
	configuration deployment.Configuration,
) (deployment.Operation, error) {
	return s.lifecycle(ctx, lifecycleRequest{
		RequestID: requestID, AgentID: agentID, ExpectedRevision: expectedRevision,
		Kind: deployment.OperationUpdateRuntime, Configuration: &configuration,
	})
}

func (s *Service) DisableRuntime(
	ctx context.Context, requestID, agentID string, expectedRevision deployment.RuntimeRevision,
) (deployment.Operation, error) {
	return s.lifecycle(ctx, lifecycleRequest{
		RequestID: requestID, AgentID: agentID, ExpectedRevision: expectedRevision,
		Kind: deployment.OperationDisableRuntime,
	})
}

func (s *Service) EnableRuntime(
	ctx context.Context,
	requestID, agentID string,
	expectedRevision deployment.RuntimeRevision,
	configuration deployment.Configuration,
) (deployment.Operation, error) {
	return s.lifecycle(ctx, lifecycleRequest{
		RequestID: requestID, AgentID: agentID, ExpectedRevision: expectedRevision,
		Kind: deployment.OperationEnableRuntime, Configuration: &configuration,
	})
}

func (s *Service) DeleteRuntime(
	ctx context.Context, requestID, agentID string, expectedRevision deployment.RuntimeRevision,
) (deployment.Operation, error) {
	return s.lifecycle(ctx, lifecycleRequest{
		RequestID: requestID, AgentID: agentID, ExpectedRevision: expectedRevision,
		Kind: deployment.OperationDeleteRuntime,
	})
}

type lifecycleRequest struct {
	RequestID        string
	AgentID          string
	ExpectedRevision deployment.RuntimeRevision
	Kind             deployment.OperationKind
	Configuration    *deployment.Configuration
}

func (s *Service) lifecycle(ctx context.Context, input lifecycleRequest) (deployment.Operation, error) {
	if input.Configuration != nil && input.Configuration.PreparedSkillSet != nil {
		if s.skillScope == "" {
			return deployment.Operation{}, fmt.Errorf("%w: Controller scope is required for prepared Skills", ErrInvalidRequest)
		}
		input.Configuration.SkillScope = s.skillScope
	}
	requestDigest, err := validateLifecycleRequest(input)
	if err != nil {
		return deployment.Operation{}, err
	}
	return s.withAgentLock(ctx, input.AgentID, func(lockCtx context.Context) (deployment.Operation, error) {
		operation, terminal, prepareErr := s.prepareOperation(lockCtx, input, requestDigest)
		if prepareErr != nil || terminal {
			return operation, prepareErr
		}
		var physical deployment.Deployment
		if operation.CreatesCompute() {
			if input.Configuration == nil {
				return deployment.Operation{}, fmt.Errorf("%w: Runtime configuration is required", ErrInvalidRequest)
			}
			if s.instanceCredentials != nil {
				if _, authErr := s.instanceCredentials.Receiver(instanceauth.Identity{Scope: s.instanceScope, AgentID: operation.AgentID, Generation: operation.Generation}, operation.InstanceAuthentication); authErr != nil {
					return deployment.Operation{}, fmt.Errorf("%w: accepted instance authority is unavailable", ErrRequestConflict)
				}
			}
			physical, err = deploymentForOperation(*input.Configuration, operation)
			if err != nil {
				return deployment.Operation{}, fmt.Errorf("%w: %v", ErrInvalidRequest, err)
			}
			digest, digestErr := s.platform.DeploymentDigest(physical)
			if digestErr != nil {
				return deployment.Operation{}, digestErr
			}
			if digest != operation.SpecDigest {
				return deployment.Operation{}, ErrRequestConflict
			}
		}
		return s.executeOperation(lockCtx, operation, physical)
	})
}

func validateLifecycleRequest(input lifecycleRequest) (string, error) {
	if err := validateRequestID(input.RequestID); err != nil {
		return "", err
	}
	if err := (deployment.Key{AgentID: input.AgentID, Generation: 1}).Validate(); err != nil {
		return "", fmt.Errorf("%w: %v", ErrInvalidRequest, err)
	}
	needsConfiguration := input.Kind == deployment.OperationInitializeRuntime ||
		input.Kind == deployment.OperationUpdateRuntime || input.Kind == deployment.OperationEnableRuntime
	if needsConfiguration {
		if input.Configuration == nil {
			return "", fmt.Errorf("%w: Runtime configuration is required", ErrInvalidRequest)
		}
		if err := input.Configuration.Validate(); err != nil {
			return "", fmt.Errorf("%w: %v", ErrInvalidRequest, err)
		}
	} else if input.Configuration != nil {
		return "", fmt.Errorf("%w: Runtime configuration is not valid for %s", ErrInvalidRequest, input.Kind)
	}
	if input.Kind == deployment.OperationInitializeRuntime {
		if input.ExpectedRevision != "" {
			return "", fmt.Errorf("%w: Initialize must not carry expected_revision", ErrInvalidRequest)
		}
	} else if err := deployment.ValidateRevision(input.ExpectedRevision); err != nil {
		return "", fmt.Errorf("%w: %v", ErrInvalidRequest, err)
	}
	requestDigest, err := deployment.DigestValue(struct {
		Kind             deployment.OperationKind   `json:"kind"`
		AgentID          string                     `json:"agent_id"`
		ExpectedRevision deployment.RuntimeRevision `json:"expected_revision,omitempty"`
		Configuration    *deployment.Configuration  `json:"configuration,omitempty"`
	}{input.Kind, input.AgentID, input.ExpectedRevision, input.Configuration})
	if err != nil {
		return "", err
	}
	return requestDigest, nil
}

func (s *Service) prepareOperation(
	ctx context.Context, input lifecycleRequest, requestDigest string,
) (deployment.Operation, bool, error) {
	stored, err := s.repository.GetOperation(ctx, input.RequestID)
	if err == nil {
		if stored.RequestDigest != requestDigest || stored.Kind != input.Kind || stored.AgentID != input.AgentID {
			return deployment.Operation{}, false, ErrRequestConflict
		}
		if operationIsTerminal(stored) {
			return stored, true, nil
		}
		stored.UpdatedAt = s.now().UTC()
		resumed, _, beginErr := s.repository.BeginTransition(ctx, stored)
		return resumed, false, beginErr
	}
	if !errors.Is(err, ErrNotFound) {
		return deployment.Operation{}, false, err
	}

	source, sourceErr := s.repository.GetEnvironment(ctx, input.AgentID)
	if errors.Is(sourceErr, ErrNotFound) {
		source = deployment.Environment{
			AgentID: input.AgentID, LifecycleState: deployment.LifecycleUninitialized,
			Health: deployment.HealthAbsent, ObservedAt: s.now().UTC(),
		}
	} else if sourceErr != nil {
		return deployment.Operation{}, false, sourceErr
	}
	if source.OperationID != "" {
		return deployment.Operation{}, false, ErrAgentMutationInProgress
	}
	transition, _, transitionErr := deployment.LifecycleTransition(input.Kind, source.LifecycleState)
	if transitionErr != nil {
		return deployment.Operation{}, false, ErrLifecycleConflict
	}
	if input.Kind != deployment.OperationInitializeRuntime && source.RuntimeRevision != input.ExpectedRevision {
		return deployment.Operation{}, false, ErrRevisionConflict
	}

	generation := source.Generation
	if input.Kind == deployment.OperationInitializeRuntime || input.Kind == deployment.OperationUpdateRuntime ||
		input.Kind == deployment.OperationEnableRuntime {
		claimed, err := s.repository.MaxClaimedGeneration(ctx, input.AgentID)
		if err != nil {
			return deployment.Operation{}, false, err
		}
		if claimed > generation {
			generation = claimed
		}
		generation++
		if err := (deployment.Key{AgentID: input.AgentID, Generation: generation}).Validate(); err != nil {
			return deployment.Operation{}, false, fmt.Errorf("%w: %v", ErrInvalidRequest, err)
		}
	}
	revision := deployment.RevisionFor(input.RequestID, requestDigest)
	now := s.now().UTC()
	candidate := deployment.Operation{
		RequestID: input.RequestID, RequestDigest: requestDigest, Kind: input.Kind,
		AgentID: input.AgentID, RuntimeRevision: revision,
		Attempt: 1, State: deployment.OperationRunning, Effect: deployment.EffectUnknown,
		ExpectedRevision: input.ExpectedRevision,
		SourceState:      source.LifecycleState, SourceRevision: source.RuntimeRevision,
		SourceGeneration: source.Generation, SourceSpecDigest: source.SpecDigest,
		Generation: generation, SpecDigest: source.SpecDigest, Transition: transition,
		CreatedAt: now, UpdatedAt: now,
	}
	if input.Configuration != nil {
		verifiers := s.maintenanceVerifiers.Clone()
		candidate.MaintenanceVerifiers = &verifiers
		if err := s.prepareBuildImage(ctx, &candidate, *input.Configuration); err != nil {
			return deployment.Operation{}, false, err
		}
		if input.Configuration.PreparedSkillSet != nil {
			physical, err := input.Configuration.Resolve(input.AgentID, generation)
			if err != nil {
				return deployment.Operation{}, false, fmt.Errorf("%w: %v", ErrInvalidRequest, err)
			}
			candidate.PreparedReference = physical.PreparedSkills
			store, ok := s.repository.(repositoryport.PreparedSkillReferenceStore)
			if !ok {
				return deployment.Operation{}, false, ErrPreparedSkillSetInvalidated
			}
			prepared, err := store.ResolvePreparedSkillSet(ctx, *candidate.PreparedReference)
			if err != nil {
				return deployment.Operation{}, false, err
			}
			if s.skillInspector == nil {
				return deployment.Operation{}, false, ErrSkillPreflightUnavailable
			}
			if err := s.skillInspector.InspectPreparedVolume(ctx, prepared); err != nil {
				if errors.Is(err, platformdocker.ErrSkillVolumeMissing) || errors.Is(err, platformdocker.ErrConflict) {
					return deployment.Operation{}, false, ErrPreparedSkillSetInvalidated
				}
				return deployment.Operation{}, false, fmt.Errorf("%w: %v", ErrSkillPreflightUnavailable, err)
			}
		}
		if s.instanceCredentials != nil {
			candidate.InstanceAuthentication, err = s.instanceCredentials.Issue(instanceauth.Identity{Scope: s.instanceScope, AgentID: input.AgentID, Generation: generation})
			if err != nil {
				return deployment.Operation{}, false, err
			}
			physical, err := deploymentForOperation(*input.Configuration, candidate)
			if err != nil {
				return deployment.Operation{}, false, err
			}
			candidate.SpecDigest, err = s.platform.DeploymentDigest(physical)
			if err != nil {
				return deployment.Operation{}, false, err
			}
		}
	}
	operation, replay, beginErr := s.repository.BeginTransition(ctx, candidate)
	if beginErr != nil {
		return deployment.Operation{}, false, beginErr
	}
	if replay {
		if operation.RequestDigest != candidate.RequestDigest || operation.Kind != candidate.Kind ||
			operation.AgentID != candidate.AgentID {
			return deployment.Operation{}, false, ErrRequestConflict
		}
		if operationIsTerminal(operation) {
			return operation, true, nil
		}
	}
	return operation, false, nil
}

func (s *Service) executeOperation(
	ctx context.Context, operation deployment.Operation, physical deployment.Deployment,
) (deployment.Operation, error) {
	switch operation.Kind {
	case deployment.OperationInitializeRuntime:
		if outcome := s.platform.EnsureStorage(ctx, operation.AgentID); outcome.State != deployment.EffectCompleted {
			return s.finishFromEffect(ctx, operation, outcome, false, false)
		}
		return s.createRuntime(ctx, operation, physical, false)
	case deployment.OperationUpdateRuntime:
		return s.updateRuntime(ctx, operation, physical)
	case deployment.OperationDisableRuntime:
		if outcome := s.deleteSource(ctx, operation); outcome.State != deployment.EffectCompleted {
			return s.finishFromEffect(ctx, operation, outcome, false, false)
		}
		return s.finishWithoutCompute(ctx, operation)
	case deployment.OperationEnableRuntime:
		return s.createRuntime(ctx, operation, physical, false)
	case deployment.OperationDeleteRuntime:
		destructive := false
		if operation.SourceState == deployment.LifecycleProvisioned || operation.SourceState == deployment.LifecycleFailed {
			if outcome := s.deleteSource(ctx, operation); outcome.State != deployment.EffectCompleted {
				return s.finishFromEffect(ctx, operation, outcome, false, false)
			}
			destructive = true
		}
		if outcome := s.platform.DeleteStorage(ctx, operation.AgentID); outcome.State != deployment.EffectCompleted {
			return s.finishFromEffect(ctx, operation, outcome, destructive, false)
		}
		return s.finishWithoutCompute(ctx, operation)
	default:
		return deployment.Operation{}, fmt.Errorf("unsupported Runtime operation %q", operation.Kind)
	}
}

func (s *Service) deleteSource(ctx context.Context, operation deployment.Operation) deployment.EffectOutcome {
	key, ok := operation.SourceKey()
	if !ok || deployment.ValidateDigest(operation.SourceSpecDigest) != nil {
		return deployment.EffectOutcome{
			State: deployment.EffectNotStarted, Code: "runtime_drift",
			Detail: "current Runtime has no valid private deployment identity",
		}
	}
	return s.platform.Delete(ctx, key, operation.SourceSpecDigest)
}

func (s *Service) createRuntime(
	ctx context.Context, operation deployment.Operation, physical deployment.Deployment, destructive bool,
) (deployment.Operation, error) {
	outcome := s.platform.Create(ctx, physical, operation.SpecDigest)
	if outcome.State != deployment.EffectCompleted {
		return s.finishFromEffect(ctx, operation, outcome, destructive, false)
	}
	environment := operationEnvironment(operation, deployment.LifecycleProvisioned, s.now().UTC())
	operation.State = deployment.OperationCompleted
	operation.Effect = deployment.EffectCompleted
	operation.Inspection = &environment
	operation.ErrorCode = ""
	operation.ErrorDetail = ""
	operation.UpdatedAt = s.now().UTC()
	observation := lifecycleObservation(operation, environment)
	return s.persistOperation(ctx, operation, &observation)
}

func (s *Service) finishWithoutCompute(
	ctx context.Context, operation deployment.Operation,
) (deployment.Operation, error) {
	state, err := operation.SuccessState()
	if err != nil {
		return deployment.Operation{}, err
	}
	environment := operationEnvironment(operation, state, s.now().UTC())
	environment.Health = deployment.HealthAbsent
	operation.State = deployment.OperationCompleted
	operation.Effect = deployment.EffectCompleted
	operation.Inspection = &environment
	operation.ErrorCode = ""
	operation.ErrorDetail = ""
	operation.UpdatedAt = s.now().UTC()
	observation := lifecycleObservation(operation, environment)
	return s.persistOperation(ctx, operation, &observation)
}

func (s *Service) finishFromEffect(
	ctx context.Context,
	operation deployment.Operation,
	outcome deployment.EffectOutcome,
	destructive, priorUnknownResolved bool,
) (deployment.Operation, error) {
	if err := outcome.Validate(); err != nil {
		return deployment.Operation{}, fmt.Errorf("platform returned invalid outcome: %w", err)
	}
	operation.ErrorCode = outcome.Code
	operation.ErrorDetail = sanitizedDetail(outcome)
	operation.UpdatedAt = s.now().UTC()
	// A later not_started response only describes this attempt. It cannot
	// erase an earlier accepted attempt unless the source was positively
	// re-proven and no destructive step began.
	if destructive || outcome.State == deployment.EffectUnknown || operation.State == deployment.OperationUnknown && !priorUnknownResolved {
		operation.State = deployment.OperationUnknown
		operation.Effect = deployment.EffectUnknown
		environment := operationEnvironment(operation, deployment.LifecycleUnknown, operation.UpdatedAt)
		operation.Inspection = &environment
	} else {
		operation.State = deployment.OperationFailed
		operation.Effect = deployment.EffectNotStarted
		if operation.Kind == deployment.OperationInitializeRuntime {
			environment := operationEnvironment(operation, deployment.LifecycleFailed, operation.UpdatedAt)
			operation.Inspection = &environment
		}
	}
	return s.persistOperation(ctx, operation, nil)
}

func operationEnvironment(
	operation deployment.Operation, state deployment.LifecycleState, observedAt time.Time,
) deployment.Environment {
	return deployment.Environment{
		AgentID: operation.AgentID, RuntimeRevision: operation.RuntimeRevision,
		LifecycleState: state, Health: deployment.HealthUnknown,
		Phase:      deployment.PhaseUnknown,
		Generation: operation.Generation, SpecDigest: operation.SpecDigest,
		OperationID: operation.RequestID, ObservedAt: observedAt,
	}
}

func lifecycleObservation(
	operation deployment.Operation, environment deployment.Environment,
) deployment.Observation {
	kind := deployment.ObservationInitialized
	switch operation.Kind {
	case deployment.OperationUpdateRuntime:
		kind = deployment.ObservationUpdated
	case deployment.OperationDisableRuntime:
		kind = deployment.ObservationDisabled
	case deployment.OperationEnableRuntime:
		kind = deployment.ObservationEnabled
	case deployment.OperationDeleteRuntime:
		kind = deployment.ObservationDeleted
	}
	return deployment.Observation{
		AgentID: operation.AgentID, RuntimeRevision: operation.RuntimeRevision,
		Kind: kind, Source: "lifecycle_operation", ObservedAt: environment.ObservedAt,
	}
}

func (s *Service) InspectRuntime(ctx context.Context, agentID string) (deployment.Environment, error) {
	if err := (deployment.Key{AgentID: agentID, Generation: 1}).Validate(); err != nil {
		return deployment.Environment{}, fmt.Errorf("%w: %v", ErrInvalidRequest, err)
	}
	environment, err := s.repository.GetEnvironment(ctx, agentID)
	if err != nil {
		return deployment.Environment{}, err
	}
	return s.inspectEnvironment(ctx, environment)
}

func (s *Service) inspectEnvironment(
	ctx context.Context, environment deployment.Environment,
) (deployment.Environment, error) {
	environment.ObservedAt = s.now().UTC()
	environment.Phase = deployment.PhaseUnknown
	environment.RuntimeEndpoint = ""
	switch environment.LifecycleState {
	case deployment.LifecycleFailed:
		environment.Health = deployment.HealthUnhealthy
		return environment, nil
	case deployment.LifecycleDisabled:
		environment.Phase = deployment.PhaseAbsent
		outcome := s.platform.VerifyStorage(ctx, environment.AgentID)
		if err := outcome.Validate(); err != nil {
			return deployment.Environment{}, fmt.Errorf("verify retained workspace: %w", err)
		}
		switch outcome.Code {
		case "":
			environment.Health = deployment.HealthAbsent
			return environment, nil
		case "storage_not_found", "storage_ownership_conflict":
			environment.Health = deployment.HealthUnhealthy
			environment.Reason, environment.DiagnosticSummary = outcome.Code, sanitizedDetail(outcome)
			return environment, nil
		default:
			return deployment.Environment{}, fmt.Errorf("verify retained workspace: %s", sanitizedDetail(outcome))
		}
	case deployment.LifecycleDeleted:
		environment.Health = deployment.HealthAbsent
		environment.Phase = deployment.PhaseAbsent
		return environment, nil
	case deployment.LifecycleProvisioned:
		return s.inspectProvisionedEnvironment(ctx, environment)
	default:
		environment.Health = deployment.HealthUnknown
		return environment, nil
	}
}

// ReconcileExpectedRuntimes compares the private logical heads with one
// complete platform inventory. It records missing compute instead of silently
// declaring a one-sided platform List converged.
func (s *Service) ReconcileExpectedRuntimes(
	ctx context.Context, inspections []deployment.Inspection,
) error {
	present := make(map[deployment.Key]struct{}, len(inspections))
	for _, inspection := range inspections {
		if inspection.PlatformPhase == deployment.PhaseAbsent {
			continue
		}
		key := inspection.RuntimeKey()
		if err := key.Validate(); err == nil {
			present[key] = struct{}{}
		}
	}
	environments, err := s.repository.ListEnvironments(ctx)
	if err != nil {
		return fmt.Errorf("list expected Runtime environments: %w", err)
	}
	for _, environment := range environments {
		if environment.LifecycleState != deployment.LifecycleProvisioned {
			continue
		}
		key, ok := environment.RuntimeKey()
		if !ok || deployment.ValidateDigest(environment.SpecDigest) != nil {
			return ErrDrift
		}
		if _, ok := present[key]; ok {
			continue
		}
		// Logical heads may have been created after the platform inventory snapshot.
		inspection, err := s.inspectExpectedRuntime(ctx, environment)
		if err != nil {
			return fmt.Errorf("recheck missing Runtime for Agent %q: %w", environment.AgentID, err)
		}
		if inspection.Health != deployment.HealthAbsent {
			continue
		}
		_, err = s.RecordPlatformObservation(ctx, deployment.Observation{
			AgentID: environment.AgentID, RuntimeRevision: environment.RuntimeRevision,
			Generation: environment.Generation, SpecDigest: environment.SpecDigest,
			Kind: deployment.ObservationRuntimeMissing, Source: "platform_reconciliation",
			DiagnosticSummary: "Expected Runtime compute is absent after exact-key platform inspection",
			ObservedAt:        inspection.ObservedAt,
		})
		if err != nil {
			return fmt.Errorf("record missing Runtime compute for Agent %q: %w", environment.AgentID, err)
		}
	}
	return nil
}

func (s *Service) ListRuntimes(ctx context.Context) ([]deployment.Environment, error) {
	environments, err := s.repository.ListEnvironments(ctx)
	if err != nil {
		return nil, err
	}
	result := make([]deployment.Environment, 0, len(environments))
	for _, environment := range environments {
		value, inspectErr := s.inspectEnvironment(ctx, environment)
		if inspectErr != nil {
			return nil, inspectErr
		}
		result = append(result, value)
	}
	return result, nil
}

// ReconcileRetainedStorage verifies the workspace owned by every disabled
// Runtime. Ready Runtime storage is verified with its compute inspection, while
// deleted Runtime storage is intentionally absent.
func (s *Service) ReconcileRetainedStorage(ctx context.Context) error {
	environments, err := s.repository.ListEnvironments(ctx)
	if err != nil {
		return fmt.Errorf("list Runtime environments for storage reconciliation: %w", err)
	}
	for _, environment := range environments {
		if environment.LifecycleState != deployment.LifecycleDisabled {
			continue
		}
		outcome := s.platform.VerifyStorage(ctx, environment.AgentID)
		if err := outcome.Validate(); err != nil {
			return fmt.Errorf("verify retained workspace for Agent %q: invalid platform outcome: %w",
				environment.AgentID, err)
		}
		if outcome.State == deployment.EffectCompleted {
			continue
		}
		kind, summary, ok := storageObservation(outcome.Code)
		if !ok {
			return fmt.Errorf("verify retained workspace for Agent %q: %s",
				environment.AgentID, sanitizedDetail(outcome))
		}
		_, err = s.RecordPlatformObservation(ctx, deployment.Observation{
			AgentID: environment.AgentID, RuntimeRevision: environment.RuntimeRevision,
			Kind: kind, Source: "platform_reconciliation",
			DiagnosticSummary: summary, ObservedAt: s.now().UTC(),
		})
		if err != nil {
			return fmt.Errorf("record retained workspace observation for Agent %q: %w",
				environment.AgentID, err)
		}
	}
	return nil
}

func storageObservation(code string) (deployment.ObservationKind, string, bool) {
	switch code {
	case "storage_not_found":
		return deployment.ObservationStorageMissing, "Retained Agent workspace is missing", true
	case "storage_ownership_conflict":
		return deployment.ObservationStorageDrift, "Retained Agent workspace has conflicting ownership", true
	default:
		return "", "", false
	}
}

func (s *Service) GetOperation(ctx context.Context, requestID string) (deployment.Operation, error) {
	if err := validateRequestID(requestID); err != nil {
		return deployment.Operation{}, err
	}
	return s.repository.GetOperation(ctx, requestID)
}

func (s *Service) ListObservations(
	ctx context.Context, after uint64, limit int,
) (deployment.ObservationWindow, error) {
	if limit < 1 || limit > 500 {
		return deployment.ObservationWindow{}, fmt.Errorf(
			"%w: observation limit must be between 1 and 500", ErrInvalidRequest,
		)
	}
	window, err := s.repository.ListObservations(ctx, after, limit)
	if err != nil {
		return deployment.ObservationWindow{}, err
	}
	if after == 0 {
		return window, nil
	}
	if window.LatestSequence == 0 || cursorPrecedesWindow(after, window.OldestSequence) {
		return deployment.ObservationWindow{}, &ObservationCursorExpiredError{
			ResetSequence: window.LatestSequence,
		}
	}
	if after > window.LatestSequence {
		return deployment.ObservationWindow{}, fmt.Errorf(
			"%w: after_sequence is newer than the retained journal", ErrInvalidRequest,
		)
	}
	return window, nil
}

func cursorPrecedesWindow(after, oldest uint64) bool {
	return oldest > 1 && after < oldest-1
}

func (s *Service) ValidateRuntimeInspection(
	ctx context.Context, inspection deployment.Inspection,
) error {
	key := inspection.RuntimeKey()
	if err := key.Validate(); err != nil || inspection.PlatformPhase == deployment.PhaseAbsent {
		return ErrDrift
	}
	claim, err := s.repository.GenerationClaim(ctx, key)
	if errors.Is(err, ErrNotFound) {
		return ErrDrift
	}
	if err != nil {
		return err
	}
	if inspection.SpecDigest != claim.SpecDigest {
		return ErrDrift
	}
	return nil
}

// InspectPlatformRuntime verifies a physical Runtime for the observation
// pipeline. It is deliberately not part of the logical control RPC surface.
func (s *Service) InspectPlatformRuntime(
	ctx context.Context, key deployment.Key,
) (deployment.Inspection, error) {
	inspection, err := s.platform.Inspect(ctx, key)
	if err != nil {
		return deployment.Inspection{}, err
	}
	if err := s.ValidateRuntimeInspection(ctx, inspection); err != nil {
		return deployment.Inspection{}, err
	}
	if inspection.Health != deployment.HealthHealthy {
		return inspection, nil
	}
	verified, err := s.verifier.Verify(ctx, inspection)
	if err != nil {
		return deployment.Inspection{}, errors.Join(deployment.ErrStatusUnverified, err)
	}
	return verified, nil
}

func (s *Service) RecordPlatformObservation(
	ctx context.Context, observation deployment.Observation,
) (deployment.Observation, error) {
	if observation.ObservedAt.IsZero() {
		observation.ObservedAt = s.now().UTC()
	}
	if key, ok := observation.RuntimeKey(); ok {
		claim, err := s.repository.GenerationClaim(ctx, key)
		if err != nil {
			if errors.Is(err, ErrNotFound) {
				return deployment.Observation{}, ErrDrift
			}
			return deployment.Observation{}, err
		}
		if observation.SpecDigest != claim.SpecDigest {
			return deployment.Observation{}, ErrDrift
		}
		observation.RuntimeRevision = claim.RuntimeRevision
	}
	return s.repository.AppendObservation(ctx, observation)
}

func (s *Service) persistOperation(
	ctx context.Context,
	operation deployment.Operation,
	observation *deployment.Observation,
) (deployment.Operation, error) {
	deadline, ok := ctx.Value(mutationDeadlineKey{}).(time.Time)
	if !ok {
		deadline, ok = ctx.Deadline()
	}
	finalizeDeadline := time.Now().Add(operationFinalizeBudget)
	if ok && deadline.Before(finalizeDeadline) {
		finalizeDeadline = deadline
	}
	persistCtx, cancel := context.WithDeadline(context.WithoutCancel(ctx), finalizeDeadline)
	defer cancel()
	if _, err := s.repository.CompleteOperation(persistCtx, operation, observation); err != nil {
		return deployment.Operation{}, err
	}
	return operation, nil
}

func (s *Service) withAgentLock(
	ctx context.Context,
	agentID string,
	execute func(context.Context) (deployment.Operation, error),
) (deployment.Operation, error) {
	operationCtx, cancel := context.WithTimeout(ctx, s.mutationTimeout)
	defer cancel()
	deadline, _ := operationCtx.Deadline()
	operationCtx = context.WithValue(operationCtx, mutationDeadlineKey{}, deadline)
	var operation deployment.Operation
	err := s.locker.WithAgentLock(operationCtx, agentID, func(lockCtx context.Context) error {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return context.DeadlineExceeded
		}
		reserve := operationFinalizeBudget
		if quarter := remaining / 4; quarter < reserve {
			reserve = quarter
		}
		executionCtx, executionCancel := context.WithDeadline(lockCtx, deadline.Add(-reserve))
		defer executionCancel()
		var executeErr error
		operation, executeErr = execute(executionCtx)
		return executeErr
	})
	return operation, err
}

func operationIsTerminal(operation deployment.Operation) bool {
	return operation.State == deployment.OperationCompleted || operation.State == deployment.OperationFailed
}

func validateRequestID(value string) error {
	if value == "" || len(value) > 200 {
		return fmt.Errorf("%w: request ID must contain 1-200 deployment-safe ASCII bytes", ErrInvalidRequest)
	}
	for index, character := range []byte(value) {
		letter := character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z'
		digit := character >= '0' && character <= '9'
		if letter || digit || index > 0 && (character == '_' || character == '.' || character == '-') {
			continue
		}
		return fmt.Errorf("%w: request ID must start with an alphanumeric byte and contain only alphanumeric, '_', '.', or '-'", ErrInvalidRequest)
	}
	return nil
}

func sanitizedDetail(outcome deployment.EffectOutcome) string {
	switch outcome.Code {
	case "runtime_drift":
		return "managed Runtime has a different private identity"
	case "storage_in_use":
		return "Agent storage is still used by a managed Runtime"
	case "storage_ownership_conflict":
		return "workspace volume is not owned by this Agent"
	case "storage_not_found":
		return "Agent workspace is not available"
	case "platform_unavailable":
		return "deployment platform did not return a conclusive result"
	default:
		if outcome.State == deployment.EffectCompleted {
			return ""
		}
		return "deployment operation did not complete"
	}
}
