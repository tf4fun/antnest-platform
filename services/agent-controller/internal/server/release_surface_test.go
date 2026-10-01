package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestReleasedHandlerDoesNotExposeLegacySkillMigration(t *testing.T) {
	handler, err := NewHandler(&catalogServiceStub{}, &lifecycleServiceStub{}, &agentConfigurationServiceStub{}, &agentQueryServiceStub{}, &agentEventServiceStub{}, &networkPolicyServiceStub{}, func(context.Context) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	for _, suffix := range []string{"", "/choices", "/operations", "/proof-loss-recovery", "/source-recovery"} {
		path := "/internal/agents/agent-1/legacy-system-skills-migration" + suffix
		for _, method := range []string{http.MethodGet, http.MethodPost, http.MethodHead, http.MethodDelete} {
			t.Run(method+" "+path, func(t *testing.T) {
				response := httptest.NewRecorder()
				handler.ServeHTTP(response, httptest.NewRequest(method, path, nil))
				if response.Code != http.StatusNotFound {
					t.Fatalf("retired route returned %d, want 404", response.Code)
				}
			})
		}
	}
}
