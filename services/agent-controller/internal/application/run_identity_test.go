package application

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestRunIdentityChangesRevalidateWithoutReplacingAgentBinding(t *testing.T) {
	t.Parallel()

	for _, scenario := range []struct {
		name    string
		failure error
		want    error
	}{
		{name: "inactive membership", want: ErrAccessDenied},
		{name: "missing membership", failure: &ports.DependencyError{
			Service: "identity", Code: "not_found",
		}, want: ErrAccessDenied},
		{name: "inactive principal error", failure: &ports.DependencyError{
			Service: "identity", Code: "inactive_principal",
		}, want: ErrAccessDenied},
		{name: "Identity unavailable", failure: &ports.DependencyError{
			Service: "identity", Code: "dependency_unavailable", Retryable: true,
		}, want: ErrDependencyUnavailable},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			t.Parallel()
			store := identityBoundaryRunStore()
			originalBinding := store.access
			identities := activeIdentityDirectory()
			service := NewRunService(store, &credentialOpenerStub{}, fixedClock{}, time.Minute,
				WithRunIdentityDirectory(identities))
			accessInput := ResolveAgentAccessInput{RequestID: "resolve-before", AgentAccessSubject: "subject-1"}
			before, err := service.ResolveAgentAccess(context.Background(), accessInput)
			if err != nil {
				t.Fatalf("resolve active identity: %v", err)
			}

			identities.principal.Active, identities.err = false, scenario.failure
			accessInput.RequestID = "resolve-denied"
			_, err = service.ResolveAgentAccess(context.Background(), accessInput)
			if !errors.Is(err, scenario.want) {
				t.Fatalf("resolve changed identity: %v, want %v", err, scenario.want)
			}
			input := identityBoundaryRunInput("run-denied")
			_, err = service.AcquireRun(context.Background(), input)
			if !errors.Is(err, scenario.want) || store.acquire.AdmissionID != "" {
				t.Fatalf("changed identity admitted a new Run: error=%v acquire=%+v", err, store.acquire)
			}

			// Reprovisioning can replace a Membership without changing the User owner.
			identities.principal.Active, identities.err = true, nil
			identities.principal.MembershipID = "replacement-membership"
			accessInput.RequestID = "resolve-restored"
			after, err := service.ResolveAgentAccess(context.Background(), accessInput)
			if err != nil || !reflect.DeepEqual(before, after) || store.access != originalBinding {
				t.Fatalf("identity recovery replaced the Agent binding: before=%+v after=%+v err=%v", before, after, err)
			}
			input.RequestID = "run-restored"
			admitted, err := service.AcquireRun(context.Background(), input)
			if err != nil || admitted.Runtime != store.admission.Snapshot.Runtime ||
				admitted.ExecutionRevision != store.admission.Snapshot.ExecutionRevisionID || identities.calls != 5 {
				t.Fatalf("recovered Run did not use current identity and existing execution: %+v error=%v calls=%d",
					admitted, err, identities.calls)
			}
		})
	}
}

func TestActiveIdentityCannotOverrideRevokedAgentBinding(t *testing.T) {
	t.Parallel()

	store := identityBoundaryRunStore()
	store.err = ports.ErrRunAccessDenied
	identities := activeIdentityDirectory()
	service := NewRunService(store, &credentialOpenerStub{}, fixedClock{}, time.Minute,
		WithRunIdentityDirectory(identities))
	_, accessErr := service.ResolveAgentAccess(context.Background(), ResolveAgentAccessInput{
		RequestID: "resolve-revoked", AgentAccessSubject: "subject-1",
	})
	_, admissionErr := service.AcquireRun(context.Background(), identityBoundaryRunInput("run-revoked"))
	if !errors.Is(accessErr, ErrAccessDenied) || !errors.Is(admissionErr, ErrAccessDenied) ||
		store.acquire.AdmissionID != "" || identities.calls != 0 {
		t.Fatalf("active identity bypassed Agent authority: access=%v admission=%v calls=%d",
			accessErr, admissionErr, identities.calls)
	}
}

func TestCommittedAdmissionSurvivesIdentityChangeWithoutAdmittingAnotherRun(t *testing.T) {
	t.Parallel()

	store := identityBoundaryRunStore()
	store.replayed = true
	identities := activeIdentityDirectory()
	identities.principal.Active = false
	service := NewRunService(store, &credentialOpenerStub{}, fixedClock{}, time.Minute,
		WithRunIdentityDirectory(identities))
	_, err := service.AcquireRun(context.Background(), identityBoundaryRunInput("original-request"))
	if err != nil || identities.calls != 0 || store.acquire.AdmissionID != "" {
		t.Fatalf("committed admission retry reauthorized or recreated the Run: error=%v calls=%d", err, identities.calls)
	}
	store.replayed = false
	_, err = service.AcquireRun(context.Background(), identityBoundaryRunInput("new-request"))
	if !errors.Is(err, ErrAccessDenied) || identities.calls != 1 || store.acquire.AdmissionID != "" {
		t.Fatalf("new request reused an old authorization: error=%v calls=%d", err, identities.calls)
	}
	store.finished = ports.FinishRunRecord{Status: "finished", AdmissionState: domain.AdmissionReleased}
	identities.err = errors.New("Identity offline")
	result, err := service.FinishRun(context.Background(), FinishRunInput{
		RequestID: "finish-original", AdmissionID: store.admission.AdmissionID,
		TerminalClass: domain.TerminalCompleted, ToolEffectState: domain.ToolEffectNone, StopReason: "end_turn",
	})
	if err != nil || result.AdmissionState != domain.AdmissionReleased || identities.calls != 1 {
		t.Fatalf("Identity state prevented original Run settlement: result=%+v error=%v calls=%d", result, err, identities.calls)
	}
}

func identityBoundaryRunInput(requestID string) AcquireRunInput {
	return AcquireRunInput{
		RequestID: requestID, AgentID: "agent-1", PrincipalID: "user-1",
		ExpectedAccessRevision: "access-1", SessionID: "session-1",
	}
}

func identityBoundaryRunStore() *runStoreStub {
	return &runStoreStub{
		access: ports.AgentAccessResolution{
			PrincipalID: "user-1", AgentID: "agent-1", OrganizationID: "org-1", AccessRevision: "access-1",
		},
		authorization: ports.RunAuthorization{OrganizationID: "org-1", OwnerUserID: "user-1"},
		admission: ports.RunAdmissionRecord{
			AdmissionID: "admission-1", AgentID: "agent-1", PrincipalID: "user-1", AccessRevision: "access-1",
			SessionID: "session-1", State: domain.AdmissionActive, Deadline: time.Unix(1000, 0).UTC(),
			RuntimeRevision: "runtime-1", Snapshot: validRunSnapshot(),
		},
	}
}
