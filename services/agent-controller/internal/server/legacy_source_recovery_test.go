package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"soft/antnest-platform/services/agent-controller/internal/application"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

type sourceRecoveryServiceStub struct {
	input  application.LegacySourceRecoveryInput
	record ports.LegacySourceRecoveryRecord
}

func (s *sourceRecoveryServiceStub) RecoverLegacySource(_ context.Context, input application.LegacySourceRecoveryInput) (ports.LegacySourceRecoveryRecord, error) {
	s.input = input
	s.record = ports.LegacySourceRecoveryRecord{RequestID: input.RequestID, AgentID: input.AgentID, OrganizationID: input.OrganizationID,
		State: "running", Phase: "drain", SourceRuntimeRevision: "rtv_22222222222222222222222222222222", ObservedRuntimeExecutionID: "process-1"}
	return s.record, nil
}

func (s *sourceRecoveryServiceStub) GetLegacySourceRecovery(_ context.Context, org, requestID string) (ports.LegacySourceRecoveryRecord, error) {
	if s.record.OrganizationID != org || s.record.RequestID != requestID {
		return ports.LegacySourceRecoveryRecord{}, ports.ErrNotFound
	}
	return s.record, nil
}

func TestLegacySourceRecoveryRouteUsesHeaderIdentityAndScopedReceipt(t *testing.T) {
	stub := &sourceRecoveryServiceStub{}
	h, err := NewHandlerWithRecoveries(&catalogServiceStub{}, &proofLossLifecycleStub{}, &agentConfigurationServiceStub{}, &agentQueryServiceStub{},
		&agentEventServiceStub{}, &networkPolicyServiceStub{}, func(context.Context) error { return nil }, &proofLossRecoveryServiceStub{}, stub)
	if err != nil {
		t.Fatal(err)
	}
	post := httptest.NewRequest(http.MethodPost, "/internal/agents/agent_11111111111111111111111111111111/legacy-system-skills-migration/source-recovery",
		strings.NewReader(`{"organization_id":"org_11111111111111111111111111111111","actor_principal_id":"admin-1"}`))
	post.Header.Set("Idempotency-Key", "recover-source-1")
	response := httptest.NewRecorder()
	h.ServeHTTP(response, post)
	if response.Code != http.StatusAccepted || stub.input.RequestID != "recover-source-1" || stub.input.AgentID != "agent_11111111111111111111111111111111" ||
		!strings.Contains(response.Body.String(), `"source_runtime_revision":"rtv_22222222222222222222222222222222"`) {
		t.Fatalf("post=%d %s input=%+v", response.Code, response.Body.String(), stub.input)
	}
	query := httptest.NewRequest(http.MethodGet, "/internal/agent-operations/recover-source-1?organization_id=org_11111111111111111111111111111111", nil)
	response = httptest.NewRecorder()
	h.ServeHTTP(response, query)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"phase":"drain"`) {
		t.Fatalf("get=%d %s", response.Code, response.Body.String())
	}
	query = httptest.NewRequest(http.MethodGet, "/internal/agent-operations/recover-source-1?organization_id=org_22222222222222222222222222222222", nil)
	response = httptest.NewRecorder()
	h.ServeHTTP(response, query)
	if response.Code != http.StatusNotFound {
		t.Fatalf("foreign receipt=%d", response.Code)
	}
}
