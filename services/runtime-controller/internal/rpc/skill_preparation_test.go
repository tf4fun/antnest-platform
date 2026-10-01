package rpc

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"soft/antnest-platform/services/runtime-controller/internal/observation"
	"soft/antnest-platform/services/runtime-controller/internal/skillset"
)

type preparationStub struct {
	received skillset.PrepareRequest
	released bool
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
