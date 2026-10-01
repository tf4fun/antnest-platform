package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/tf4fun/antnest-platform/services/admin-console/internal/principal"
	"github.com/tf4fun/antnest-platform/services/admin-console/internal/upstream"
)

func TestAgentSkillPreparationReadUsesTrustedScopeAndAllowlist(t *testing.T) {
	backend := newBackendStub()
	backend.enqueue(http.StatusOK, `{"request_id":"request-1","agent_id":"agent-1","kind":"create","state":"retry_wait","progress":{"verified_packages":1,"verified_bytes":120,"total_packages":2,"total_bytes":240},"retry_after":"2026-09-27T10:00:00Z","error_code":"registry_unavailable","updated_at":"2026-09-27T09:59:00Z","target_spec":{"system_prompt":"private"},"prepared_reference_id":"private"}`)
	h := newTestHandler(t, backend)
	w := requestAdmin(t, h, http.MethodGet, "/api/admin/agent-skill-preparations/request-1", "")
	if w.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	call := backend.singleCall(t)
	if call.Target != upstream.AgentController || call.Method != http.MethodGet || call.Path != "/internal/agent-skill-preparations/request-1" || call.Query != "organization_id=org-1" {
		t.Fatalf("call=%+v", call)
	}
	if !strings.Contains(w.Body.String(), `"total_bytes":240`) || strings.Contains(w.Body.String(), "private") || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("unsafe projection: %s", w.Body.String())
	}
}

func TestAgentSkillPreparationByOriginalKeyDerivesScopedRequest(t *testing.T) {
	backend := newBackendStub()
	backend.enqueue(http.StatusOK, `{"request_id":"request-1","agent_id":"agent-1","kind":"create","state":"preparing","progress":{"verified_packages":0,"verified_bytes":0,"total_packages":1,"total_bytes":100},"updated_at":"2026-09-27T09:59:00Z"}`)
	h := newTestHandler(t, backend)
	r := httptest.NewRequest(http.MethodGet, "/api/admin/agent-skill-preparations/by-idempotency-key", nil)
	r.Header.Set(principal.HeaderUserID, "user-admin")
	r.Header.Set(principal.HeaderOrganizationID, "org-1")
	r.Header.Set(principal.HeaderMembershipID, "membership-1")
	r.Header.Set(principal.HeaderSystemRole, "user")
	r.Header.Set(principal.HeaderOrganizationRole, "admin")
	r.Header.Set("Idempotency-Key", "original-request-key-123")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	requestID, ok := commandRequestID(httptest.NewRecorder(), r, "org-1", "lifecycle")
	if !ok {
		t.Fatal("valid key rejected")
	}
	call := backend.singleCall(t)
	if call.Path != "/internal/agent-skill-preparations/"+requestID || call.Query != "organization_id=org-1" {
		t.Fatalf("call=%+v", call)
	}
}

func TestAgentSkillPreparationByOriginalKeyRejectsMissingKeyAndQuery(t *testing.T) {
	backend := newBackendStub()
	h := newTestHandler(t, backend)
	for _, path := range []string{
		"/api/admin/agent-skill-preparations/by-idempotency-key",
		"/api/admin/agent-skill-preparations/by-idempotency-key?organization_id=org-2",
	} {
		r := httptest.NewRequest(http.MethodGet, path, nil)
		r.Header.Set(principal.HeaderUserID, "user-admin")
		r.Header.Set(principal.HeaderOrganizationID, "org-1")
		r.Header.Set(principal.HeaderMembershipID, "membership-1")
		r.Header.Set(principal.HeaderSystemRole, "user")
		r.Header.Set(principal.HeaderOrganizationRole, "admin")
		if strings.Contains(path, "?") {
			r.Header.Set("Idempotency-Key", "original-request-key-123")
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != http.StatusBadRequest || len(backend.calls) != 0 {
			t.Fatalf("path=%s status=%d calls=%d", path, w.Code, len(backend.calls))
		}
	}
}

func TestAgentSkillPreparationReadRejectsBrowserScopeAndPreservesNotFound(t *testing.T) {
	backend := newBackendStub()
	h := newTestHandler(t, backend)
	w := requestAdmin(t, h, http.MethodGet, "/api/admin/agent-skill-preparations/request-1?organization_id=org-2", "")
	if w.Code != http.StatusBadRequest || len(backend.calls) != 0 {
		t.Fatalf("query accepted: status=%d calls=%d", w.Code, len(backend.calls))
	}
	backend.enqueue(http.StatusNotFound, `{"code":"preparation_not_found","message":"Skill preparation was not found","retryable":false}`)
	w = requestAdmin(t, h, http.MethodGet, "/api/admin/agent-skill-preparations/request-1", "")
	if w.Code != http.StatusNotFound || !strings.Contains(w.Body.String(), "preparation_not_found") {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
}
