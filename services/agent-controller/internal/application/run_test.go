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

func TestResolveAgentAccessReturnsOnlyActiveBindingFacts(t *testing.T) {
	t.Parallel()

	store := &runStoreStub{access: ports.AgentAccessResolution{
		PrincipalID: "user-1", AgentID: "agent-1", OrganizationID: "org-1",
		AccessRevision:     "access-1",
		PromptCapabilities: ports.PromptCapabilities{Image: true},
	}}
	service := NewRunService(
		store, &credentialOpenerStub{}, fixedClock{}, time.Minute,
		WithRunIdentityDirectory(activeIdentityDirectory()),
	)
	result, err := service.ResolveAgentAccess(context.Background(), ResolveAgentAccessInput{
		RequestID: "request-access-1", AgentAccessSubject: "subject-1",
	})
	if err != nil {
		t.Fatalf("resolve Agent access: %v", err)
	}
	if result.PrincipalID != "user-1" || result.AgentID != "agent-1" ||
		result.AccessRevision != "access-1" || !result.PromptCapabilities.Image {
		t.Fatalf("access result = %+v", result)
	}
	if store.accessSubject != "subject-1" {
		t.Fatalf("resolved subject = %q", store.accessSubject)
	}
}

func TestResolveAgentAccessFailsClosedForInactiveOrUnavailableOwner(t *testing.T) {
	t.Parallel()

	access := ports.AgentAccessResolution{
		PrincipalID: "user-1", AgentID: "agent-1", OrganizationID: "org-1",
		AccessRevision: "access-1",
	}
	for _, test := range []struct {
		name       string
		identities *identityDirectoryStub
		want       error
	}{
		{
			name: "inactive",
			identities: &identityDirectoryStub{principal: ports.IdentityPrincipal{
				UserID: "user-1", OrganizationID: "org-1", MembershipID: "membership-1", Active: false,
			}},
			want: ErrAccessDenied,
		},
		{
			name: "dependency",
			identities: &identityDirectoryStub{err: &ports.DependencyError{
				Service: "identity", Code: "dependency_unavailable", Retryable: true,
			}},
			want: ErrDependencyUnavailable,
		},
		{name: "missing dependency", identities: nil, want: ErrDependencyUnavailable},
	} {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			var options []RunServiceOption
			if test.identities != nil {
				options = append(options, WithRunIdentityDirectory(test.identities))
			}
			service := NewRunService(
				&runStoreStub{access: access}, &credentialOpenerStub{}, fixedClock{}, time.Minute,
				options...,
			)
			_, err := service.ResolveAgentAccess(context.Background(), ResolveAgentAccessInput{
				RequestID: "request-access", AgentAccessSubject: "subject-1",
			})
			if !errors.Is(err, test.want) {
				t.Fatalf("ResolveAgentAccess error = %v, want %v", err, test.want)
			}
		})
	}
}

func TestAcquireRunCreatesBoundedImmutableSnapshotRequest(t *testing.T) {
	t.Parallel()

	now := time.Unix(1000, 0).UTC()
	snapshot := validRunSnapshot()
	store := &runStoreStub{admission: ports.RunAdmissionRecord{
		AdmissionID: "admission-1", AgentID: "agent-1", PrincipalID: "user-1",
		AccessRevision: "access-1", SessionID: "session-1", State: domain.AdmissionActive,
		Deadline: now.Add(30 * time.Minute), RuntimeRevision: "runtime-1", Snapshot: snapshot,
	}, authorization: ports.RunAuthorization{OrganizationID: "org-1", OwnerUserID: "user-1"}}
	identities := activeIdentityDirectory()
	service := NewRunService(
		store, &credentialOpenerStub{}, fixedClock{now: now}, 30*time.Minute,
		WithRunIdentityDirectory(identities),
	)
	result, err := service.AcquireRun(context.Background(), AcquireRunInput{
		RequestID: "request-run-1", AgentID: "agent-1", PrincipalID: "user-1",
		ExpectedAccessRevision: "access-1", SessionID: "session-1",
	})
	if err != nil {
		t.Fatalf("acquire Run: %v", err)
	}
	if store.acquire.AdmissionID == "" || store.acquire.RequestFingerprint == "" ||
		!store.acquire.Deadline.Equal(now.Add(30*time.Minute)) || identities.calls != 1 {
		t.Fatalf("acquire command = %+v", store.acquire)
	}
	if result.AdmissionID != "admission-1" ||
		result.AgentExecutionSpecDigest != snapshot.AgentExecutionSpecDigest ||
		len(result.ExecutionSpec.SkillInstructions) != 0 {
		t.Fatalf("acquire result = %+v", result)
	}
}

func TestAcquireRunRequiresCurrentIdentityOnlyForANewAdmission(t *testing.T) {
	t.Parallel()

	for _, test := range []struct {
		name       string
		identities *identityDirectoryStub
		want       error
	}{
		{
			name: "inactive owner",
			identities: &identityDirectoryStub{principal: ports.IdentityPrincipal{
				UserID: "user-1", OrganizationID: "org-1", MembershipID: "membership-1",
			}},
			want: ErrAccessDenied,
		},
		{
			name: "Identity unavailable",
			identities: &identityDirectoryStub{err: &ports.DependencyError{
				Service: "identity", Code: "internal_error", Retryable: true,
			}},
			want: ErrDependencyUnavailable,
		},
	} {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			store := &runStoreStub{authorization: ports.RunAuthorization{
				OrganizationID: "org-1", OwnerUserID: "user-1",
			}}
			service := NewRunService(
				store, &credentialOpenerStub{}, fixedClock{}, time.Minute,
				WithRunIdentityDirectory(test.identities),
			)
			_, err := service.AcquireRun(context.Background(), AcquireRunInput{
				RequestID: "request-run-denied", AgentID: "agent-1", PrincipalID: "user-1",
				ExpectedAccessRevision: "access-1", SessionID: "session-1",
			})
			if !errors.Is(err, test.want) {
				t.Fatalf("AcquireRun error=%v want=%v", err, test.want)
			}
			if store.acquire.AdmissionID != "" {
				t.Fatalf("denied Run persisted admission: %+v", store.acquire)
			}
		})
	}
}

func TestAcquireRunMapsCoordinationFailures(t *testing.T) {
	t.Parallel()

	testCases := []struct {
		name string
		from error
		want error
	}{
		{name: "access", from: ports.ErrRunAccessDenied, want: ErrAccessDenied},
		{name: "busy", from: ports.ErrAgentBusy, want: ErrAgentBusy},
		{name: "lifecycle", from: ports.ErrAgentRebuilding, want: ErrAgentRebuilding},
		{name: "build", from: ports.ErrAgentBuildFailed, want: ErrAgentBuildFailed},
		{name: "not ready", from: ports.ErrAgentNotReady, want: ErrAgentNotReady},
		{name: "request fingerprint", from: ports.ErrRequestConflict, want: ErrInvalidInput},
	}
	for _, testCase := range testCases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			store := &runStoreStub{err: testCase.from}
			service := NewRunService(store, &credentialOpenerStub{}, fixedClock{}, time.Minute)
			_, err := service.AcquireRun(context.Background(), AcquireRunInput{
				RequestID: "request-run-error", AgentID: "agent-1", PrincipalID: "user-1",
				ExpectedAccessRevision: "access-1", SessionID: "session-1",
			})
			if !errors.Is(err, testCase.want) {
				t.Fatalf("AcquireRun error = %v, want %v", err, testCase.want)
			}
		})
	}
}

func TestAcquireRunReplaysOriginalSnapshotAfterAdmissionRelease(t *testing.T) {
	t.Parallel()

	now := time.Unix(1050, 0).UTC()
	store := &runStoreStub{replayed: true, admission: ports.RunAdmissionRecord{
		AdmissionID: "admission-1", AgentID: "agent-1", PrincipalID: "user-1",
		AccessRevision: "access-1", SessionID: "session-1", State: domain.AdmissionReleased,
		Deadline: now.Add(time.Minute), RuntimeRevision: "runtime-1", Snapshot: validRunSnapshot(),
	}}
	service := NewRunService(store, &credentialOpenerStub{}, fixedClock{now: now}, time.Minute)
	result, err := service.AcquireRun(context.Background(), AcquireRunInput{
		RequestID: "request-run-replay", AgentID: "agent-1", PrincipalID: "user-1",
		ExpectedAccessRevision: "access-1", SessionID: "session-1",
	})
	if err != nil || result.AdmissionID != "admission-1" {
		t.Fatalf("replay released admission: result=%+v err=%v", result, err)
	}
}

func TestAcquireRunReplaysConcurrentAdmissionAfterIdentityFailure(t *testing.T) {
	t.Parallel()

	now := time.Unix(1075, 0).UTC()
	store := &runStoreStub{
		replayOnCall: 2,
		authorization: ports.RunAuthorization{
			OrganizationID: "org-1", OwnerUserID: "user-1",
		},
		admission: ports.RunAdmissionRecord{
			AdmissionID: "admission-1", AgentID: "agent-1", PrincipalID: "user-1",
			AccessRevision: "access-1", SessionID: "session-1", State: domain.AdmissionActive,
			Deadline: now.Add(time.Minute), RuntimeRevision: "runtime-1", Snapshot: validRunSnapshot(),
		},
	}
	identities := &identityDirectoryStub{err: errors.New("identity unavailable")}
	service := NewRunService(
		store, &credentialOpenerStub{}, fixedClock{now: now}, time.Minute,
		WithRunIdentityDirectory(identities),
	)

	result, err := service.AcquireRun(context.Background(), AcquireRunInput{
		RequestID: "request-run-replay", AgentID: "agent-1", PrincipalID: "user-1",
		ExpectedAccessRevision: "access-1", SessionID: "session-1",
	})
	if err != nil {
		t.Fatalf("replay concurrently persisted Run admission: %v", err)
	}
	if result.AdmissionID != "admission-1" || store.replayCalls != 2 {
		t.Fatalf("concurrent admission was not replayed: result=%+v calls=%d", result, store.replayCalls)
	}
	if store.acquire.AdmissionID != "" || identities.calls != 1 {
		t.Fatalf("unexpected second admission or Identity calls: acquire=%+v calls=%d", store.acquire, identities.calls)
	}
}

func TestFinishRunValidatesClosedUnionAndPreservesUnknownEffect(t *testing.T) {
	t.Parallel()

	now := time.Unix(1100, 0).UTC()
	store := &runStoreStub{finished: ports.FinishRunRecord{
		Status: "finished", AdmissionState: domain.AdmissionBlockedUnknownEffect,
	}}
	identities := &identityDirectoryStub{err: errors.New("Identity state changed after admission")}
	service := NewRunService(
		store, &credentialOpenerStub{}, fixedClock{now: now}, time.Minute,
		WithRunIdentityDirectory(identities),
	)
	result, err := service.FinishRun(context.Background(), FinishRunInput{
		RequestID: "request-finish-1", AdmissionID: "admission-1",
		TerminalClass: domain.TerminalUnresolved, ToolEffectState: domain.ToolEffectUnknown,
		UnknownEffectSource: domain.UnknownEffectRuntimeMCP,
		ErrorClass:          "tool_outcome_unknown",
	})
	if err != nil {
		t.Fatalf("finish unresolved Run: %v", err)
	}
	if result.AdmissionState != domain.AdmissionBlockedUnknownEffect ||
		store.finish.Report.Class != domain.TerminalUnresolved ||
		store.finish.Event == nil ||
		store.finish.Event.EventType != ports.EventRunAdmissionUnresolved {
		t.Fatalf("finish result=%+v command=%+v", result, store.finish)
	}
	store.finished = ports.FinishRunRecord{
		Status: "already_finished", AdmissionState: domain.AdmissionReleased,
	}
	result, err = service.FinishRun(context.Background(), FinishRunInput{
		RequestID: "request-finish-replay", AdmissionID: "admission-1",
		TerminalClass: domain.TerminalUnresolved, ToolEffectState: domain.ToolEffectUnknown,
		UnknownEffectSource: domain.UnknownEffectRuntimeMCP,
		ErrorClass:          "tool_outcome_unknown",
	})
	if err != nil || result.AdmissionState != domain.AdmissionReleased {
		t.Fatalf("finish replay after Runtime barrier: result=%+v err=%v", result, err)
	}

	_, err = service.FinishRun(context.Background(), FinishRunInput{
		RequestID: "request-finish-invalid", AdmissionID: "admission-1",
		TerminalClass: domain.TerminalCompleted, ToolEffectState: domain.ToolEffectUnknown,
		StopReason: "end_turn",
	})
	if !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("invalid terminal union error = %v", err)
	}

	store.finished = ports.FinishRunRecord{
		Status: "finished", AdmissionState: domain.AdmissionReleased,
	}
	_, err = service.FinishRun(context.Background(), FinishRunInput{
		RequestID: "request-finish-completed", AdmissionID: "admission-completed",
		TerminalClass: domain.TerminalCompleted, ToolEffectState: domain.ToolEffectSettled,
		StopReason: "end_turn",
	})
	if err != nil || store.finish.Event != nil {
		t.Fatalf("completed Run emitted lifecycle release event: command=%+v err=%v", store.finish, err)
	}
	if identities.calls != 0 {
		t.Fatalf("FinishRun revalidated an already admitted authorization snapshot %d times", identities.calls)
	}
}

func TestResolveCredentialOpensOnlyStoreAuthorizedSecret(t *testing.T) {
	t.Parallel()

	sealed := ports.SealedSecret{Ciphertext: []byte("cipher"), Nonce: []byte("nonce"), KeyVersion: "key-1"}
	credential := ports.AdmissionCredential{
		Identity: ports.CredentialIdentity{
			OrganizationID: "org-1", CredentialRef: "credential-1", CredentialVersion: "version-1",
		},
		SecretType: "bearer", Sealed: sealed,
	}
	store := &runStoreStub{credential: credential}
	opener := &credentialOpenerStub{secret: "secret-value"}
	service := NewRunService(store, opener, fixedClock{}, time.Minute)
	result, err := service.ResolveCredential(context.Background(), ResolveCredentialInput{
		RequestID: "request-credential-1", AdmissionID: "admission-1",
		CredentialRef: "credential-1",
	})
	if err != nil {
		t.Fatalf("resolve credential: %v", err)
	}
	if result.Secret != "secret-value" || result.CredentialVersion != "version-1" ||
		!reflect.DeepEqual(opener.identity, credential.Identity) ||
		!reflect.DeepEqual(opener.sealed, sealed) {
		t.Fatalf("credential result=%+v opener=%+v", result, opener)
	}
}

type runStoreStub struct {
	access        ports.AgentAccessResolution
	accessSubject string
	acquire       ports.AcquireRunRecord
	admission     ports.RunAdmissionRecord
	finish        ports.FinishRunCommand
	finished      ports.FinishRunRecord
	credential    ports.AdmissionCredential
	credentialAt  time.Time
	replayed      bool
	replayCalls   int
	replayOnCall  int
	authorization ports.RunAuthorization
	err           error
}

func (store *runStoreStub) ResolveAgentAccess(
	_ context.Context, subject string,
) (ports.AgentAccessResolution, error) {
	store.accessSubject = subject
	return store.access, store.err
}

func (store *runStoreStub) ReplayRunAdmission(
	_ context.Context, _ string, _ string,
) (ports.RunAdmissionRecord, bool, error) {
	store.replayCalls++
	if store.replayed || store.replayOnCall > 0 && store.replayCalls >= store.replayOnCall {
		return store.admission, true, store.err
	}
	return ports.RunAdmissionRecord{}, false, nil
}

func (store *runStoreStub) ResolveRunAuthorization(
	_ context.Context, _ string, _ string, _ string,
) (ports.RunAuthorization, error) {
	return store.authorization, store.err
}

func (store *runStoreStub) AcquireRun(
	_ context.Context, input ports.AcquireRunRecord,
) (ports.RunAdmissionRecord, bool, error) {
	store.acquire = input
	return store.admission, false, store.err
}

func (store *runStoreStub) FinishRun(
	_ context.Context, input ports.FinishRunCommand,
) (ports.FinishRunRecord, error) {
	store.finish = input
	return store.finished, store.err
}

func (store *runStoreStub) GetAdmissionCredential(
	_ context.Context, _ string, _ string, now time.Time,
) (ports.AdmissionCredential, error) {
	store.credentialAt = now
	return store.credential, store.err
}

type credentialOpenerStub struct {
	identity ports.CredentialIdentity
	sealed   ports.SealedSecret
	secret   string
	err      error
}

func (opener *credentialOpenerStub) Open(
	_ context.Context, identity ports.CredentialIdentity, sealed ports.SealedSecret,
) (string, error) {
	opener.identity = identity
	opener.sealed = sealed
	return opener.secret, opener.err
}

func validRunSnapshot() ports.RunExecutionSnapshot {
	return ports.RunExecutionSnapshot{
		AgentSpecRevisionID: "spec-1", ExecutionRevisionID: "execution-1",
		RuntimeMCPSourceDigest:   strings.Repeat("a", 64),
		AgentExecutionSpecDigest: strings.Repeat("b", 64),
		CredentialVersion:        "version-1",
		Runtime: ports.AdmittedRuntime{
			RuntimeRevision: "runtime-1", RuntimeExecutionID: "runtime-execution-1",
			MCPEndpoint: "http://runtime-1:8091/mcp",
		},
		ExecutionSpec: ports.AdmittedExecutionSpec{
			SystemPrompt: "You are useful.", ContextPolicyVersion: domain.ContextPolicyV1,
			SkillInstructions: []ports.SkillInstruction{}, Model: domain.ModelSpec{
				BaseURL: "https://model.example/v1", Model: "model-1",
				ContextWindow: 32768, MaxOutputTokens: 4096,
			},
			MaxModelRequests: 16, CredentialRef: "credential-1",
		},
	}
}

var _ ports.RunStore = (*runStoreStub)(nil)
var _ ports.CredentialOpener = (*credentialOpenerStub)(nil)
