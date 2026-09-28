package runtimeclient

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestSkillPreparationClientUsesScopedDurableContract(t *testing.T) {
	org := "org_00000000000000000000000000000000"
	digest, err := domain.SkillSetDigest(org, nil)
	if err != nil {
		t.Fatal(err)
	}
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		switch calls {
		case 1:
			if r.Method != http.MethodPost || r.URL.Path != "/internal/runtimes/agent-1/skill-sets/prepare" || r.Header.Get("Idempotency-Key") != "prepare-1" {
				t.Errorf("prepare request: %s %s %s", r.Method, r.URL.Path, r.Header.Get("Idempotency-Key"))
			}
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Error(err)
			}
			if skills, ok := body["system_skills"].([]any); !ok || len(skills) != 0 || body["skill_set_digest"] != digest || body["owner_operation_id"] != "build-1" {
				t.Errorf("prepare body: %+v", body)
			}
			w.WriteHeader(http.StatusAccepted)
		case 2:
			if r.Method != http.MethodGet || r.URL.Path != "/internal/runtimes/agent-1/skill-sets/preparations/prepare-1" || r.URL.Query().Get("organization_id") != org {
				t.Errorf("get request: %s %s", r.Method, r.URL.String())
			}
		case 3:
			if r.Method != http.MethodPost || r.URL.Path != "/internal/runtimes/agent-1/skill-sets/preparations/prepare-1/release" || r.Header.Get("Idempotency-Key") != "release-1" {
				t.Errorf("release request: %s %s", r.Method, r.URL.Path)
			}
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Error(err)
			}
			if body["organization_id"] != org || body["owner_operation_id"] != "build-1" {
				t.Errorf("release body: %+v", body)
			}
			w.WriteHeader(http.StatusNoContent)
			return
		default:
			t.Errorf("unexpected call %d", calls)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(ports.SkillPreparationReceipt{RequestID: "prepare-1", AgentID: "agent-1", OrganizationID: org, OwnerOperationID: "build-1", State: "ready", PreparedSkillSet: &ports.PreparedSkillSet{SkillSetDigest: digest, LayoutVersion: 1}, PreparedReferenceID: "psr_" + strings.Repeat("a", 32)})
	}))
	defer server.Close()
	client, err := New(server.URL, time.Second, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	request := ports.SkillPreparationRequest{OrganizationID: org, OwnerOperationID: "build-1", LayoutVersion: 1, SkillSetDigest: digest, SystemSkills: []domain.FrozenSkill{}}
	ready, err := client.PrepareSkillSet(context.Background(), "prepare-1", "agent-1", request)
	if err != nil || ready.State != "ready" || ready.PreparedReferenceID == "" {
		t.Fatalf("prepare result: %+v %v", ready, err)
	}
	observed, err := client.GetSkillPreparation(context.Background(), org, "agent-1", "prepare-1")
	if err != nil || observed.PreparedReferenceID != ready.PreparedReferenceID {
		t.Fatalf("get result: %+v %v", observed, err)
	}
	if err := client.ReleaseSkillPreparation(context.Background(), "release-1", org, "agent-1", "prepare-1", "build-1"); err != nil {
		t.Fatalf("release: %v", err)
	}
}

func TestSkillPreparationClientPreservesRetryableCleanupError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte(`{"code":"skill_cleanup_in_progress","retryable":true}`))
	}))
	defer server.Close()
	client, err := New(server.URL, time.Second, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	org := "org_00000000000000000000000000000000"
	digest, err := domain.SkillSetDigest(org, nil)
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.PrepareSkillSet(context.Background(), "prepare-1", "agent-1", ports.SkillPreparationRequest{
		OrganizationID: org, OwnerOperationID: "build-1", LayoutVersion: 1, SkillSetDigest: digest, SystemSkills: []domain.FrozenSkill{},
	})
	var failure *ports.DependencyError
	if !errors.As(err, &failure) || failure.Code != "skill_cleanup_in_progress" || !failure.Retryable {
		t.Fatalf("cleanup error: %v", err)
	}
}

func TestSkillPreparationClientRejectsForeignReadyCollection(t *testing.T) {
	org := "org_00000000000000000000000000000000"
	digest, err := domain.SkillSetDigest(org, nil)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(ports.SkillPreparationReceipt{
			RequestID: "prepare-1", AgentID: "agent-1", OrganizationID: org, OwnerOperationID: "build-1", State: "ready",
			PreparedSkillSet:    &ports.PreparedSkillSet{SkillSetDigest: "sha256:" + strings.Repeat("f", 64), LayoutVersion: 1},
			PreparedReferenceID: "psr_" + strings.Repeat("a", 32),
		})
	}))
	defer server.Close()
	client, err := New(server.URL, time.Second, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.PrepareSkillSet(context.Background(), "prepare-1", "agent-1", ports.SkillPreparationRequest{
		OrganizationID: org, OwnerOperationID: "build-1", LayoutVersion: 1, SkillSetDigest: digest, SystemSkills: []domain.FrozenSkill{},
	})
	var failure *ports.DependencyError
	if !errors.As(err, &failure) || failure.Code != "invalid_response" {
		t.Fatalf("foreign ready collection accepted: %v", err)
	}
}

func TestRuntimeConfigurationCarriesEmptyPreparedSkillCollection(t *testing.T) {
	configuration := runtimeConfiguration()
	org := "org_00000000000000000000000000000000"
	digest, err := domain.SkillSetDigest(org, nil)
	if err != nil {
		t.Fatal(err)
	}
	configuration.OrganizationID = org
	configuration.SystemSkills = []domain.FrozenSkill{}
	configuration.PreparedSkillSet = &ports.PreparedSkillSet{SkillSetDigest: digest, LayoutVersion: 1}
	configuration.PreparedReferenceID = "psr_" + strings.Repeat("a", 32)
	encoded, err := json.Marshal(runtimeConfigurationPayload(configuration))
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]any
	if err := json.Unmarshal(encoded, &body); err != nil {
		t.Fatal(err)
	}
	if skills, ok := body["system_skills"].([]any); !ok || len(skills) != 0 || body["prepared_reference_id"] != configuration.PreparedReferenceID || body["organization_id"] != org {
		t.Fatalf("prepared configuration: %s", encoded)
	}
}

func TestRuntimeClientClassifiesInvalidatedSetAsNonRetryable(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"code":"prepared_skill_set_invalidated","retryable":false}`))
	}))
	defer server.Close()
	client, err := New(server.URL, time.Second, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.UpdateRuntime(context.Background(), "update-1", "agent-1", "rtv_11111111111111111111111111111111", runtimeConfiguration())
	var failure *ports.DependencyError
	if !errors.As(err, &failure) || failure.Code != "prepared_skill_set_invalidated" || failure.Retryable {
		t.Fatalf("invalidated set retry classification: %v", err)
	}
}

func TestActiveSkillVerificationClientChecksExactTargetReceipt(t *testing.T) {
	org := "org_00000000000000000000000000000000"
	digest, err := domain.SkillSetDigest(org, nil)
	if err != nil {
		t.Fatal(err)
	}
	request := ports.ActiveSkillSetVerificationRequest{OrganizationID: org,
		ExpectedRuntimeRevision: "rtv_11111111111111111111111111111111",
		PreparedReferenceID:     "psr_" + strings.Repeat("a", 32),
		PreparedSkillSet:        ports.PreparedSkillSet{SkillSetDigest: digest, LayoutVersion: 1},
		SystemSkills:            []domain.FrozenSkill{}}
	wrongReceipt := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/internal/runtimes/agent-1/skill-sets/verify-active" || r.Header.Get("Idempotency-Key") != "verify-1" {
			t.Errorf("verify request: %s %s %s", r.Method, r.URL.Path, r.Header.Get("Idempotency-Key"))
		}
		var body ports.ActiveSkillSetVerificationRequest
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.PreparedSkillSet.SkillSetDigest != digest || body.SystemSkills == nil {
			t.Errorf("verify body: %+v %v", body, err)
		}
		revision := request.ExpectedRuntimeRevision
		if wrongReceipt {
			revision = "rtv_22222222222222222222222222222222"
		}
		_ = json.NewEncoder(w).Encode(ports.ActiveSkillSetVerificationReceipt{AgentID: "agent-1", RuntimeRevision: revision,
			SkillSetDigest: digest, LayoutVersion: 1, ManifestDigest: "sha256:" + strings.Repeat("b", 64), VerifiedAt: time.Now().UTC()})
	}))
	defer server.Close()
	client, err := New(server.URL, time.Second, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := client.VerifyActiveSkillSet(context.Background(), "verify-1", "agent-1", request)
	if err != nil || receipt.RuntimeRevision != request.ExpectedRuntimeRevision || receipt.SkillSetDigest != digest {
		t.Fatalf("valid active receipt: %+v %v", receipt, err)
	}
	wrongReceipt = true
	if _, err := client.VerifyActiveSkillSet(context.Background(), "verify-1", "agent-1", request); err == nil {
		t.Fatal("foreign Runtime revision accepted")
	}
	request.SystemSkills = nil
	if _, err := client.VerifyActiveSkillSet(context.Background(), "verify-1", "agent-1", request); err == nil {
		t.Fatal("implicit empty Skill list accepted")
	}
}
