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

type proofLossRecoveryServiceStub struct {
	input  application.LegacyProofLossRecoveryInput
	record ports.LegacyProofLossRecoveryRecord
	calls  int
}

type proofLossLifecycleStub struct{ lifecycleServiceStub }

func (*proofLossLifecycleStub) GetLifecycleOperation(context.Context, string) (application.OperationView, error) {
	return application.OperationView{}, ports.ErrNotFound
}

func (stub *proofLossRecoveryServiceStub) RecoverLegacyProofLoss(_ context.Context, input application.LegacyProofLossRecoveryInput) (ports.LegacyProofLossRecoveryRecord, error) {
	stub.calls++
	stub.input = input
	if stub.record.RequestID == "" {
		stub.record = ports.LegacyProofLossRecoveryRecord{RequestID: input.RequestID, AgentID: input.AgentID, OrganizationID: input.OrganizationID,
			FailedMigrationRequestID: input.FailedMigrationRequestID, TargetRuntimeRevision: "rtv_22222222222222222222222222222222", ChildRequestID: "acr_11111111111111111111111111111111", State: "running", Phase: "disable_runtime"}
	}
	return stub.record, nil
}
func (stub *proofLossRecoveryServiceStub) GetLegacyProofLossRecovery(_ context.Context, org, requestID string) (ports.LegacyProofLossRecoveryRecord, error) {
	if stub.record.RequestID != requestID || stub.record.OrganizationID != org {
		return ports.LegacyProofLossRecoveryRecord{}, ports.ErrNotFound
	}
	return stub.record, nil
}

func TestLegacyProofLossRecoveryRouteUsesHeaderIdentityAndScopedReceipt(t *testing.T) {
	stub := &proofLossRecoveryServiceStub{}
	handler, err := NewHandlerWithRecovery(&catalogServiceStub{}, &proofLossLifecycleStub{}, &agentConfigurationServiceStub{}, &agentQueryServiceStub{}, &agentEventServiceStub{}, &networkPolicyServiceStub{}, func(context.Context) error { return nil }, stub)
	if err != nil {
		t.Fatal(err)
	}
	post := httptest.NewRequest(http.MethodPost, "/internal/agents/agent_11111111111111111111111111111111/legacy-system-skills-migration/proof-loss-recovery",
		strings.NewReader(`{"organization_id":"org_11111111111111111111111111111111","actor_principal_id":"admin-1","failed_migration_request_id":"failed-1"}`))
	post.Header.Set("Idempotency-Key", "recover-1")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, post)
	if response.Code != http.StatusAccepted || stub.calls != 1 || stub.input.RequestID != "recover-1" || stub.input.AgentID != "agent_11111111111111111111111111111111" || !strings.Contains(response.Body.String(), `"target_runtime_revision":"rtv_22222222222222222222222222222222"`) {
		t.Fatalf("recovery POST=%d %s input=%+v", response.Code, response.Body.String(), stub.input)
	}
	query := httptest.NewRequest(http.MethodGet, "/internal/agent-operations/recover-1?organization_id=org_11111111111111111111111111111111", nil)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, query)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"phase":"disable_runtime"`) {
		t.Fatalf("recovery GET=%d %s", response.Code, response.Body.String())
	}
	query = httptest.NewRequest(http.MethodGet, "/internal/agent-operations/recover-1?organization_id=org_22222222222222222222222222222222", nil)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, query)
	if response.Code != http.StatusNotFound {
		t.Fatalf("foreign recovery GET=%d %s", response.Code, response.Body.String())
	}
	stub.record.State = "manual_recovery_required"
	stub.record.ErrorCode = "legacy_migration_manual_recovery_required"
	stub.record.ManualReason = "runtime_disable_rejected"
	post = httptest.NewRequest(http.MethodPost, "/internal/agents/agent_11111111111111111111111111111111/legacy-system-skills-migration/proof-loss-recovery",
		strings.NewReader(`{"organization_id":"org_11111111111111111111111111111111","actor_principal_id":"admin-1","failed_migration_request_id":"failed-1"}`))
	post.Header.Set("Idempotency-Key", "recover-1")
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, post)
	if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), `"manual_reason":"runtime_disable_rejected"`) {
		t.Fatalf("manual replay=%d %s", response.Code, response.Body.String())
	}
	post = httptest.NewRequest(http.MethodPost, "/internal/agents/agent_11111111111111111111111111111111/legacy-system-skills-migration/proof-loss-recovery", strings.NewReader(`{"organization_id":"org_11111111111111111111111111111111","actor_principal_id":"admin-1","failed_migration_request_id":"failed-1","agent_id":"injected"}`))
	post.Header.Set("Idempotency-Key", "recover-2")
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, post)
	if response.Code != http.StatusBadRequest || stub.calls != 2 {
		t.Fatalf("extra command field accepted: %d %s", response.Code, response.Body.String())
	}
}
