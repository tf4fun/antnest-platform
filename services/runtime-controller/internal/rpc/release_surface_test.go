package rpc

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestReleasedHandlerDoesNotExposeLegacySkillMigration(t *testing.T) {
	handler := newTestHandler(t, &fakeService{})
	for _, path := range []string{
		"/internal/legacy-system-skills/inventory",
		"/internal/legacy-system-skills/backups",
		"/internal/legacy-system-skills/backups/backup-1",
		"/internal/runtimes/agent-1/skill-sets/verify-active",
	} {
		for _, method := range []string{http.MethodGet, http.MethodPost, http.MethodHead, http.MethodDelete} {
			t.Run(method+path, func(t *testing.T) {
				request := httptest.NewRequest(method, path, strings.NewReader(`{}`))
				request.Header.Set("Idempotency-Key", "retired-route")
				response := httptest.NewRecorder()
				handler.ServeHTTP(response, request)
				if response.Code != http.StatusNotFound {
					t.Fatalf("retired route returned %d, want 404: %s", response.Code, response.Body.String())
				}
			})
		}
	}
}
