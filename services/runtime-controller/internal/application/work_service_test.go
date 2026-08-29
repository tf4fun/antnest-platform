package application

import (
	"context"
	"errors"
	"testing"

	"soft/antnest-platform/services/runtime-controller/internal/domain"
	runtimecontracts "soft/antnest-platform/services/runtime-controller/internal/runtimeprotocol"
)

func TestWorkServiceTargetsCurrentReadyGeneration(t *testing.T) {
	repository := newMemoryRepository()
	repository.runtime = &domain.Runtime{
		AgentID: "agent-1", DesiredState: domain.DesiredActive, Status: domain.RuntimeReady,
		DesiredGeneration: 3, ObservedGeneration: 3,
	}
	repository.generations["agent-1/3"] = domain.RuntimeGeneration{
		AgentID: "agent-1", Number: 3, RuntimeInstanceID: "rt-agent-1-3",
		Status: domain.GenerationReady,
	}
	executor := &recordingWorkExecutor{
		execResult: runtimecontracts.ExecResult{
			Outcome:  runtimecontracts.Outcome{Disposition: runtimecontracts.EffectCompleted},
			ExitCode: int32Pointer(0), ProcessReaped: true,
		},
	}
	service, err := NewWorkService(repository, executor)
	if err != nil {
		t.Fatalf("new work service: %v", err)
	}

	result, err := service.Exec(context.Background(), "agent-1", validExecInput())
	if err != nil {
		t.Fatalf("exec: %v", err)
	}
	if result.ExitCode == nil || *result.ExitCode != 0 {
		t.Fatalf("unexpected result: %+v", result)
	}
	if executor.target.RuntimeInstanceID != "rt-agent-1-3" || executor.target.Generation != 3 {
		t.Fatalf("wrong execution target: %+v", executor.target)
	}
}

func TestWorkServiceRejectsRuntimeThatIsNotReady(t *testing.T) {
	repository := newMemoryRepository()
	repository.runtime = &domain.Runtime{
		AgentID: "agent-1", DesiredState: domain.DesiredActive, Status: domain.RuntimeStarting,
		DesiredGeneration: 3, ObservedGeneration: 2,
	}
	service, err := NewWorkService(repository, &recordingWorkExecutor{})
	if err != nil {
		t.Fatalf("new work service: %v", err)
	}

	_, err = service.Exec(context.Background(), "agent-1", validExecInput())
	if !errors.Is(err, ErrRuntimeUnavailable) {
		t.Fatalf("expected runtime unavailable, got %v", err)
	}
}

func TestBeginWorkReservesEpochBeforeDispatchAndRejectsReplayAfterAdvance(t *testing.T) {
	repository := newMemoryRepository()
	repository.runtime = &domain.Runtime{
		AgentID: "agent-1", DesiredState: domain.DesiredActive, Status: domain.RuntimeReady,
		DesiredGeneration: 3, ObservedGeneration: 3,
	}
	repository.generations["agent-1/3"] = domain.RuntimeGeneration{
		AgentID: "agent-1", Number: 3, RuntimeInstanceID: "rt-agent-1-3",
		Status: domain.GenerationReady, WorkEpochFloor: 1, ResourceVersion: 1,
	}
	executor := &recordingWorkExecutor{
		beginResult: runtimecontracts.BeginWorkResult{
			Outcome: runtimecontracts.Outcome{
				Disposition: runtimecontracts.EffectCompleted, Reason: "accepted",
			},
			Accepted: true,
		},
	}
	service, err := NewWorkService(repository, executor)
	if err != nil {
		t.Fatalf("new work service: %v", err)
	}
	work := runtimecontracts.BeginWorkInput{
		WorkRef: runtimecontracts.WorkRef{
			WorkID: "run-7", WorkEpoch: 7, WorkSessionID: "session-7",
		},
		Kind: runtimecontracts.WorkKindRun,
	}
	result, err := service.BeginWork(context.Background(), "agent-1", work)
	if err != nil || !result.Accepted {
		t.Fatalf("begin work: result=%+v err=%v", result, err)
	}
	generation := repository.generations["agent-1/3"]
	if generation.WorkEpochFloor != 8 || generation.LastWorkID != "run-7" {
		t.Fatalf("work reservation was not persisted before dispatch: %+v", generation)
	}

	if _, err := service.BeginWork(context.Background(), "agent-1", work); err != nil {
		t.Fatalf("repeat same work: %v", err)
	}
	stale := work
	stale.WorkID = "different-run"
	stale.WorkSessionID = "different-session"
	if _, err := service.BeginWork(context.Background(), "agent-1", stale); !errors.Is(err, ErrWorkEpochStale) {
		t.Fatalf("stale work epoch error = %v", err)
	}
}

func TestBeginWorkReleasesUndispatchedEpochForSafeRetry(t *testing.T) {
	repository, executor, service := readyWorkService(t)
	executor.beginResult = runtimecontracts.BeginWorkResult{Outcome: runtimecontracts.Outcome{
		Disposition: runtimecontracts.EffectNotStarted, Reason: "runtime_unavailable",
	}}
	work := runtimecontracts.BeginWorkInput{
		WorkRef: runtimecontracts.WorkRef{
			WorkID: "run-7", WorkEpoch: 7, WorkSessionID: "session-7",
		},
		Kind: runtimecontracts.WorkKindRun,
	}
	result, err := service.BeginWork(context.Background(), "agent-1", work)
	if err != nil || result.Reason != "runtime_unavailable" {
		t.Fatalf("undispatched begin: result=%+v err=%v", result, err)
	}
	generation := repository.generations["agent-1/3"]
	if generation.WorkEpochFloor != 7 || generation.LastWorkID != "" || generation.LastWorkEpoch != 0 {
		t.Fatalf("undispatched epoch remained reserved: %+v", generation)
	}

	executor.beginResult = runtimecontracts.BeginWorkResult{
		Outcome: runtimecontracts.Outcome{
			Disposition: runtimecontracts.EffectCompleted, Reason: "accepted",
		},
		Accepted: true,
	}
	result, err = service.BeginWork(context.Background(), "agent-1", work)
	if err != nil || !result.Accepted {
		t.Fatalf("retry begin: result=%+v err=%v", result, err)
	}
	generation = repository.generations["agent-1/3"]
	if generation.WorkEpochFloor != 8 || generation.LastWorkID != "run-7" {
		t.Fatalf("successful retry was not fenced: %+v", generation)
	}
}

func TestBeginWorkRetainsEpochForAmbiguousDispatch(t *testing.T) {
	repository, executor, service := readyWorkService(t)
	executor.beginResult = runtimecontracts.BeginWorkResult{Outcome: runtimecontracts.Outcome{
		Disposition: runtimecontracts.EffectUnknown, Reason: "transport_lost",
	}}
	work := runtimecontracts.BeginWorkInput{
		WorkRef: runtimecontracts.WorkRef{
			WorkID: "run-7", WorkEpoch: 7, WorkSessionID: "session-7",
		},
		Kind: runtimecontracts.WorkKindRun,
	}
	if _, err := service.BeginWork(context.Background(), "agent-1", work); err != nil {
		t.Fatal(err)
	}
	generation := repository.generations["agent-1/3"]
	if generation.WorkEpochFloor != 8 || generation.LastWorkID != "run-7" {
		t.Fatalf("ambiguous dispatch lost its fence: %+v", generation)
	}
}

func readyWorkService(t *testing.T) (*memoryRepository, *recordingWorkExecutor, *WorkService) {
	t.Helper()
	repository := newMemoryRepository()
	repository.runtime = &domain.Runtime{
		AgentID: "agent-1", DesiredState: domain.DesiredActive, Status: domain.RuntimeReady,
		DesiredGeneration: 3, ObservedGeneration: 3,
	}
	repository.generations["agent-1/3"] = domain.RuntimeGeneration{
		AgentID: "agent-1", Number: 3, RuntimeInstanceID: "rt-agent-1-3",
		Status: domain.GenerationReady, WorkEpochFloor: 1, ResourceVersion: 1,
	}
	executor := &recordingWorkExecutor{}
	service, err := NewWorkService(repository, executor)
	if err != nil {
		t.Fatal(err)
	}
	return repository, executor, service
}

type recordingWorkExecutor struct {
	target      runtimecontracts.GenerationKey
	execResult  runtimecontracts.ExecResult
	beginResult runtimecontracts.BeginWorkResult
}

func (e *recordingWorkExecutor) BeginWork(
	_ context.Context, target runtimecontracts.GenerationKey, _ runtimecontracts.BeginWorkInput,
) runtimecontracts.BeginWorkResult {
	e.target = target
	return e.beginResult
}

func (e *recordingWorkExecutor) EndWork(
	context.Context, runtimecontracts.GenerationKey, runtimecontracts.EndWorkInput,
) runtimecontracts.EndWorkResult {
	return runtimecontracts.EndWorkResult{}
}

func (e *recordingWorkExecutor) Exec(
	_ context.Context, target runtimecontracts.GenerationKey, _ runtimecontracts.ExecInput,
) runtimecontracts.ExecResult {
	e.target = target
	return e.execResult
}

func (e *recordingWorkExecutor) ReadFile(
	context.Context, runtimecontracts.GenerationKey, runtimecontracts.ReadFileInput,
) runtimecontracts.ReadFileResult {
	return runtimecontracts.ReadFileResult{}
}

func (e *recordingWorkExecutor) WriteFile(
	context.Context, runtimecontracts.GenerationKey, runtimecontracts.WriteFileInput,
) runtimecontracts.WriteFileResult {
	return runtimecontracts.WriteFileResult{}
}

func (e *recordingWorkExecutor) EditFile(
	context.Context, runtimecontracts.GenerationKey, runtimecontracts.EditFileInput,
) runtimecontracts.EditFileResult {
	return runtimecontracts.EditFileResult{}
}

func (e *recordingWorkExecutor) ListDir(
	context.Context, runtimecontracts.GenerationKey, runtimecontracts.ListDirInput,
) runtimecontracts.ListDirResult {
	return runtimecontracts.ListDirResult{}
}

func (e *recordingWorkExecutor) CancelOperation(
	context.Context, runtimecontracts.GenerationKey, runtimecontracts.CancelOperationInput,
) runtimecontracts.CancelOperationResult {
	return runtimecontracts.CancelOperationResult{}
}

func validExecInput() runtimecontracts.ExecInput {
	return runtimecontracts.ExecInput{
		OperationRef: runtimecontracts.OperationRef{
			WorkRef: runtimecontracts.WorkRef{
				WorkID: "run-1", WorkEpoch: 1, WorkSessionID: "session-1",
			},
			OperationID:   "operation-1",
			RequestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		},
		Argv:       []string{"true"},
		WorkingDir: runtimecontracts.RootPath{Root: runtimecontracts.RootWorkspace, Path: "."},
		Timeout:    5,
	}
}

func int32Pointer(value int32) *int32 { return &value }
