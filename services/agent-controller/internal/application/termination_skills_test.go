package application

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

type terminationSkillClient struct {
	ports.SkillPreparationClient
	release func(string) error
}

func (client *terminationSkillClient) ReleaseSkillPreparation(_ context.Context, requestID, _, _, _, _ string) error {
	return client.release(requestID)
}

func TestTerminateLifecycleReleasesPreparedSkillsAfterCommit(t *testing.T) {
	for _, kind := range []domain.OperationKind{domain.OperationCreate, domain.OperationRebuild, domain.OperationEnable} {
		for _, code := range []string{"phase_deadline_exceeded", "lifecycle_cancelled"} {
			t.Run(string(kind)+"/"+code, func(t *testing.T) {
				plan, err := domain.OperationPlan(kind)
				require.NoError(t, err)
				running := reliabilityOperation("request-skills", kind, plan[0], domain.OperationRunning)
				failed := running
				failed.State, failed.ErrorCode = domain.OperationFailed, code
				store := &reliabilityStoreStub{operation: running, terminateResult: failed}
				intent := &skillIntentStub{intent: ports.SkillPreparationIntent{
					RequestID: running.RequestID, RequestFingerprint: running.RequestFingerprint,
					AgentID: running.AgentID, OrganizationID: "org-1", State: "ready", PreparedReferenceID: "prepared-reference",
				}}
				releases := 0
				service := reliabilityService(store, nil)
				service.skillIntents = intent
				service.skillClient = &terminationSkillClient{release: func(string) error {
					require.Equal(t, 1, store.terminateCalls, "commit termination before releasing its preparation")
					require.Equal(t, "ready", intent.intent.State, "record release only after RC confirms it")
					releases++
					return nil
				}}
				input := LifecycleTermination{RequestID: running.RequestID, Phase: running.Phase, Code: code}
				view, err := service.TerminateLifecycle(t.Context(), input)
				require.NoError(t, err)
				require.Equal(t, domain.OperationFailed, view.State)
				require.Equal(t, 1, releases)
				require.Equal(t, "released", intent.intent.State)
				store.operation = failed
				_, err = service.TerminateLifecycle(t.Context(), input)
				require.NoError(t, err)
				require.Equal(t, 1, releases, "replaying termination must not repeat a confirmed release")
				require.Equal(t, 1, store.terminateCalls)
			})
		}
	}
}

func TestTerminateLifecycleRetriesUnconfirmedSkillRelease(t *testing.T) {
	running := reliabilityOperation("request-skills", domain.OperationCreate, domain.PhaseNetworkEnsure, domain.OperationRunning)
	failed := running
	failed.State, failed.ErrorCode = domain.OperationFailed, "phase_deadline_exceeded"
	store := &reliabilityStoreStub{operation: running, terminateResult: failed}
	intent := &skillIntentStub{intent: ports.SkillPreparationIntent{RequestID: running.RequestID,
		RequestFingerprint: running.RequestFingerprint, State: "ready", PreparedReferenceID: "prepared-reference"}}
	var ids []string
	service := reliabilityService(store, nil)
	service.skillIntents = intent
	service.skillClient = &terminationSkillClient{release: func(id string) error {
		ids = append(ids, id)
		if len(ids) == 1 {
			return errors.New("release confirmation lost")
		}
		return nil
	}}
	input := LifecycleTermination{RequestID: running.RequestID, Phase: running.Phase, Code: failed.ErrorCode}
	_, err := service.TerminateLifecycle(t.Context(), input)
	require.ErrorIs(t, err, ErrDependencyUnavailable)
	require.Equal(t, "ready", intent.intent.State)
	store.operation = failed
	_, err = service.TerminateLifecycle(t.Context(), input)
	require.NoError(t, err)
	require.Len(t, ids, 2)
	require.Equal(t, ids[0], ids[1], "retry must release the same original preparation idempotently")
	require.Equal(t, "released", intent.intent.State)
	require.Equal(t, 1, store.terminateCalls, "retry cleanup without repeating the terminal mutation")
}

func TestTerminateLifecycleDoesNotReleaseCompletedOrOtherFailures(t *testing.T) {
	for _, state := range []domain.OperationState{domain.OperationCompleted, domain.OperationFailed} {
		operation := reliabilityOperation("request-skills", domain.OperationCreate, domain.PhasePublish, state)
		operation.ErrorCode = "another_failure"
		store := &reliabilityStoreStub{operation: operation}
		service := reliabilityService(store, nil)
		service.skillIntents = &skillIntentStub{intent: ports.SkillPreparationIntent{RequestID: operation.RequestID, State: "ready"}}
		service.skillClient = &terminationSkillClient{release: func(string) error { t.Fatal("unrelated preparation released"); return nil }}
		view, err := service.TerminateLifecycle(t.Context(), LifecycleTermination{RequestID: operation.RequestID, Phase: operation.Phase, Code: "phase_deadline_exceeded"})
		require.NoError(t, err)
		require.Equal(t, state, view.State)
		require.Zero(t, store.terminateCalls)
	}
}
