package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/application"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

type legacyMigrationServiceStub struct {
	input  application.RecordLegacySkillChoiceInput
	called int
	err    error
}

func (stub *legacyMigrationServiceStub) GetLegacySkillMigration(_ context.Context, org, agent string) (application.LegacySkillMigrationReview, error) {
	if stub.err != nil {
		return application.LegacySkillMigrationReview{}, stub.err
	}
	return application.LegacySkillMigrationReview{Migration: ports.LegacySkillMigrationRecord{AgentID: agent, OrganizationID: org, State: "pending"}, Inventory: ports.LegacySkillInventory{VolumeName: "legacy", InventoryDigest: "sha256:" + strings.Repeat("a", 64), Entries: []ports.LegacySkillInventoryEntry{}, References: []ports.LegacySkillInventoryReference{}}}, nil
}
func (stub *legacyMigrationServiceStub) RecordLegacySkillChoice(_ context.Context, input application.RecordLegacySkillChoiceInput) (ports.LegacySkillChoice, error) {
	stub.called++
	stub.input = input
	if stub.err != nil {
		return ports.LegacySkillChoice{}, stub.err
	}
	return ports.LegacySkillChoice{RequestID: input.RequestID, AgentID: input.AgentID, OrganizationID: input.OrganizationID, ActorPrincipalID: input.ActorPrincipalID, Kind: input.Kind, Sequence: 1, VolumeName: input.VolumeName, InventoryDigest: input.InventoryDigest, BackupRef: input.BackupRef, BackupDigest: input.BackupDigest, CreatedAt: time.Date(2026, 9, 28, 0, 0, 0, 0, time.UTC)}, nil
}

func TestLegacyMigrationRoutesKeepChoiceSeparateFromResolution(t *testing.T) {
	stub := &legacyMigrationServiceStub{}
	lifecycle := &lifecycleServiceStub{}
	handler, err := NewHandler(&catalogServiceStub{}, lifecycle, &agentConfigurationServiceStub{}, &agentQueryServiceStub{}, &agentEventServiceStub{}, &networkPolicyServiceStub{}, func(context.Context) error { return nil }, stub)
	if err != nil {
		t.Fatal(err)
	}
	get := httptest.NewRequest(http.MethodGet, "/internal/agents/agent-1/legacy-system-skills-migration?organization_id=org-1", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, get)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"state":"pending"`) || !strings.Contains(response.Body.String(), `"inventory_digest"`) {
		t.Fatalf("legacy review=%d %s", response.Code, response.Body.String())
	}
	post := httptest.NewRequest(http.MethodPost, "/internal/agents/agent-1/legacy-system-skills-migration/choices", strings.NewReader(`{"organization_id":"org-1","actor_principal_id":"admin-1","kind":"empty","volume_name":"legacy","inventory_digest":"sha256:`+strings.Repeat("a", 64)+`","backup_ref":"backup-1","backup_digest":"sha256:`+strings.Repeat("b", 64)+`"}`))
	post.Header.Set("Idempotency-Key", "choice-1")
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, post)
	if response.Code != http.StatusCreated || stub.called != 1 || stub.input.RequestID != "choice-1" || stub.input.AgentID != "agent-1" || !strings.Contains(response.Body.String(), `"kind":"empty"`) {
		t.Fatalf("legacy choice=%d %s input=%+v", response.Code, response.Body.String(), stub.input)
	}
	post = httptest.NewRequest(http.MethodPost, "/internal/agents/agent-1/legacy-system-skills-migration/choices", strings.NewReader(`{}`))
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, post)
	if response.Code != http.StatusBadRequest || stub.called != 1 {
		t.Fatalf("missing request identity accepted: %d", response.Code)
	}
	operation := httptest.NewRequest(http.MethodPost, "/internal/agents/agent-1/legacy-system-skills-migration/operations", strings.NewReader(`{"organization_id":"org-1","actor_principal_id":"admin-1","choice_sequence":2,"attestation":{"version":1,"key_id":"verifier-key"}}`))
	operation.Header.Set("Idempotency-Key", "migration-1")
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, operation)
	if response.Code != http.StatusAccepted || lifecycle.legacyMigrationInput.RequestID != "migration-1" ||
		lifecycle.legacyMigrationInput.AgentID != "agent-1" || lifecycle.legacyMigrationInput.ChoiceSequence != 2 {
		t.Fatalf("migration operation=%d %s input=%+v", response.Code, response.Body.String(), lifecycle.legacyMigrationInput)
	}
	operation = httptest.NewRequest(http.MethodPost, "/internal/agents/agent-1/legacy-system-skills-migration/operations", strings.NewReader(`{}`))
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, operation)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("migration without identity accepted: %d", response.Code)
	}
}
