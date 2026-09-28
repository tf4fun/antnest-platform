package rpc

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"soft/antnest-platform/services/runtime-controller/internal/control"
	"soft/antnest-platform/services/runtime-controller/internal/deployment"
	"soft/antnest-platform/services/runtime-controller/internal/observation"
	"soft/antnest-platform/services/runtime-controller/internal/skillset"
)

type preparationStub struct {
	received skillset.PrepareRequest
	released bool
}

type activeSkillVerificationStub struct {
	input  control.ActiveSkillSetVerificationRequest
	called bool
}

func (stub *activeSkillVerificationStub) VerifyActiveSkillSet(_ context.Context, agentID string, input control.ActiveSkillSetVerificationRequest) (control.ActiveSkillSetVerificationReceipt, error) {
	stub.called, stub.input = true, input
	return control.ActiveSkillSetVerificationReceipt{AgentID: agentID, RuntimeRevision: input.ExpectedRuntimeRevision,
		SkillSetDigest: input.PreparedSkillSet.SkillSetDigest, LayoutVersion: input.PreparedSkillSet.LayoutVersion,
		ManifestDigest: "sha256:" + strings.Repeat("b", 64), VerifiedAt: time.Date(2026, 9, 28, 0, 0, 0, 0, time.UTC)}, nil
}

func TestActiveSkillVerificationRoute(t *testing.T) {
	handler, err := NewHandler(&fakeService{}, observation.NewHub(), time.Second, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	stub := &activeSkillVerificationStub{}
	handler.SetActiveSkillVerifier(stub)
	body := `{"organization_id":"org_00000000000000000000000000000000","expected_runtime_revision":"rtv_0123456789abcdef0123456789abcdef","prepared_reference_id":"psr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","prepared_skill_set":{"skill_set_digest":"sha256:` + strings.Repeat("a", 64) + `","layout_version":1},"system_skills":[]}`
	request := httptest.NewRequest(http.MethodPost, "/internal/runtimes/agent-1/skill-sets/verify-active", strings.NewReader(body))
	request.Header.Set("Idempotency-Key", "verify-active-1")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || !stub.called || stub.input.ExpectedRuntimeRevision != deployment.RuntimeRevision("rtv_0123456789abcdef0123456789abcdef") || !strings.Contains(response.Body.String(), `"manifest_digest"`) {
		t.Fatalf("verify active response=%d body=%s input=%+v", response.Code, response.Body.String(), stub.input)
	}
}

func (s *preparationStub) Prepare(_ context.Context, requestID, agentID string, input skillset.PrepareRequest) (skillset.PreparationReceipt, error) {
	s.received = input
	return skillset.PreparationReceipt{RequestID: requestID, AgentID: agentID, State: skillset.PreparationQueued}, nil
}
func (s *preparationStub) Get(_ context.Context, org, agentID, requestID string) (skillset.PreparationReceipt, error) {
	return skillset.PreparationReceipt{RequestID: requestID, AgentID: agentID, OrganizationID: org, State: skillset.PreparationReady}, nil
}
func (s *preparationStub) Release(context.Context, string, string, string, string) error {
	s.released = true
	return nil
}

func TestSkillPreparationRoutes(t *testing.T) {
	stub := &preparationStub{}
	handler, err := NewHandler(&fakeService{}, observation.NewHub(), time.Second, time.Minute, stub)
	if err != nil {
		t.Fatal(err)
	}
	post := httptest.NewRequest(http.MethodPost, "/internal/runtimes/agent-1/skill-sets/prepare", strings.NewReader(`{"organization_id":"org_00000000000000000000000000000000","owner_operation_id":"build-1","layout_version":1,"skill_set_digest":"sha256:test","system_skills":[]}`))
	post.Header.Set("Idempotency-Key", "prepare-1")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, post)
	if response.Code != http.StatusAccepted || stub.received.OwnerOperationID != "build-1" {
		t.Fatalf("prepare: %d %s", response.Code, response.Body.String())
	}
	get := httptest.NewRequest(http.MethodGet, "/internal/runtimes/agent-1/skill-sets/preparations/prepare-1?organization_id=org_00000000000000000000000000000000", nil)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, get)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"state":"ready"`) {
		t.Fatalf("get: %d %s", response.Code, response.Body.String())
	}
	release := httptest.NewRequest(http.MethodPost, "/internal/runtimes/agent-1/skill-sets/preparations/prepare-1/release", strings.NewReader(`{"organization_id":"org_00000000000000000000000000000000","owner_operation_id":"build-1"}`))
	release.Header.Set("Idempotency-Key", "release-1")
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, release)
	if response.Code != http.StatusNoContent || !stub.released {
		t.Fatalf("release: %d %s", response.Code, response.Body.String())
	}
}
