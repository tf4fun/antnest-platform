package registry

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestLegacySharedBearerCannotPublish(t *testing.T) {
	handler := newTestHandler(t, NewService(&memoryStore{}))
	req := publishRequest(t, map[string]any{"request_id": "legacy-supply-chain", "organization_id": testOrg, "actor_id": testActor},
		skillZIP(t, "---\nname: code-review\ndescription: Review code\n---\n"))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, req)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("legacy shared bearer can still publish: status=%d", response.Code)
	}
}

func TestResolveRequiresJSONMediaBeforeEffects(t *testing.T) {
	handler := newTestHandler(t, NewService(&memoryStore{}))
	req := httptest.NewRequest(http.MethodPost, "/internal/skill-versions/resolve", strings.NewReader(`{"organization_id":"`+testOrg+`","refs":[]}`))
	handler.Authorize(req, "agent-controller")
	req.Header.Set("Content-Type", "text/plain")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, req)
	if response.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("non-JSON resolve admitted: status=%d", response.Code)
	}
}
