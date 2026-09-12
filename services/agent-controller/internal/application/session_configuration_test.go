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

func TestSessionConfigurationRequiresCurrentOwnerAndDefaultsPagination(t *testing.T) {
	t.Parallel()
	for name, identities := range map[string]*identityDirectoryStub{
		"active":      activeIdentityDirectory(),
		"inactive":    {principal: ports.IdentityPrincipal{UserID: "user-1", OrganizationID: "org-1", MembershipID: "member"}},
		"unavailable": {err: errors.New("offline")},
	} {
		t.Run(name, func(t *testing.T) {
			store := &runStoreStub{authorization: ports.RunAuthorization{OrganizationID: "org-1", OwnerUserID: "user-1"}}
			service := NewRunService(store, &credentialOpenerStub{}, fixedClock{}, time.Minute, WithRunIdentityDirectory(identities))
			_, err := service.GetSessionConfiguration(context.Background(), SessionConfigurationInput{
				RequestID: "get-config", AgentID: "agent-1", PrincipalID: "user-1", ExpectedAccessRevision: "access-1"})
			if name == "active" {
				if err != nil || store.configurationQuery.Limit != 100 || store.configurationQuery.AgentID != "agent-1" {
					t.Fatalf("query=%+v %v", store.configurationQuery, err)
				}
				return
			}
			if err == nil || store.configurationQuery.AgentID != "" {
				t.Fatalf("unauthorized catalog read: %v", err)
			}
		})
	}
}

func TestAgentAuthorizationUsesExplicitCASWithoutChangingRunAdmission(t *testing.T) {
	t.Parallel()
	store := &runStoreStub{authorization: ports.RunAuthorization{OrganizationID: "org-1", OwnerUserID: "user-1"}}
	service := NewRunService(store, &credentialOpenerStub{}, fixedClock{now: time.Unix(1, 0)}, time.Minute, WithRunIdentityDirectory(activeIdentityDirectory()))
	input := SetAgentAuthorizationInput{RequestID: "set-config", AgentID: "agent-1", PrincipalID: "user-1",
		ExpectedAccessRevision: "access-1", ExpectedAuthorizationRevision: 3,
		Authorization: domain.Authorization{Mode: domain.AuthorizationApprove}}
	revision, err := service.SetAgentAuthorization(context.Background(), input)
	if err != nil || revision != 4 || store.setAuthorization.ExpectedRevision != 3 || store.acquire.AgentID != "" {
		t.Fatalf("update=%+v revision=%d err=%v", store.setAuthorization, revision, err)
	}
	firstEvent := store.setAuthorization.EventID
	input.ExpectedAuthorizationRevision = 4
	if _, err := service.SetAgentAuthorization(context.Background(), input); err != nil {
		t.Fatal(err)
	}
	if store.setAuthorization.EventID == firstEvent {
		t.Fatal("CAS reload retry reused a committed event identity")
	}
	input.Authorization.Mode = "unknown"
	if _, err := service.SetAgentAuthorization(context.Background(), input); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("invalid mode: %v", err)
	}
}

func TestRunConfigurationFingerprintPreservesLegacyRequestsAndIncludesOverrides(t *testing.T) {
	t.Parallel()
	input := AcquireRunInput{RequestID: "run", AgentID: "agent", PrincipalID: "owner", ExpectedAccessRevision: "access", SessionID: "session"}
	legacy := struct{ RequestID, AgentID, PrincipalID, ExpectedAccessRevision, SessionID string }{"run", "agent", "owner", "access", "session"}
	want, err := requestFingerprint(legacy)
	if err != nil {
		t.Fatal(err)
	}
	got, err := requestFingerprint(input)
	if err != nil || got != want {
		t.Fatalf("legacy fingerprint changed: %s %s %v", got, want, err)
	}
	profile := "chosen-profile"
	input.SessionConfiguration = &domain.SessionConfigurationOverrides{ModelProfileID: &profile}
	selected, err := requestFingerprint(input)
	if err != nil || selected == got {
		t.Fatalf("choice not part of request identity: %s %v", selected, err)
	}
	store := &runStoreStub{authorization: ports.RunAuthorization{OrganizationID: "org-1", OwnerUserID: "owner"}}
	identities := &identityDirectoryStub{principal: ports.IdentityPrincipal{UserID: "owner", OrganizationID: "org-1", MembershipID: "member", Active: true}}
	service := NewRunService(store, &credentialOpenerStub{}, fixedClock{}, time.Minute, WithRunIdentityDirectory(identities))
	// The fake deliberately has no admission; inspect what crossed the port.
	_, _ = service.AcquireRun(context.Background(), input)
	if !reflect.DeepEqual(store.acquire.SessionConfiguration, *input.SessionConfiguration) || store.acquire.RequestFingerprint != selected {
		t.Fatalf("override omitted at admission: %+v", store.acquire)
	}
}
