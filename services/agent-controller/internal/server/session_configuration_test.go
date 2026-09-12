package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestSessionConfigurationRPCForwardsChoicesAndRejectsForeignFields(t *testing.T) {
	t.Parallel()
	runs := &runServiceStub{configuration: ports.SessionConfiguration{Models: []ports.SessionModelOption{},
		DefaultAuthorization: domain.Authorization{Mode: domain.AuthorizationAuto, ToolRules: []domain.ToolRule{}}, AuthorizationRevision: 1}}
	h, err := NewHandler(&catalogServiceStub{}, &lifecycleServiceStub{}, runs, &agentQueryServiceStub{}, &agentEventServiceStub{}, &networkPolicyServiceStub{}, func(context.Context) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	identity := `"request_id":"config","agent_id":"agent","principal_id":"owner","expected_access_revision":"access"`
	assertJSONRequest(t, h, "/rpc/agent-controller/get-session-configuration", "{"+identity+"}", func(payload map[string]any) {
		if payload["authorization_revision"] != float64(1) {
			t.Fatalf("configuration=%v", payload)
		}
	})
	assertJSONRequest(t, h, "/rpc/agent-controller/acquire-run", "{"+identity+`,"session_id":"session","session_configuration":{"model_profile_id":"profile","authorization_mode":"chat"}}`, func(map[string]any) {})
	if runs.acquireIn.SessionConfiguration == nil || *runs.acquireIn.SessionConfiguration.ModelProfileID != "profile" || *runs.acquireIn.SessionConfiguration.AuthorizationMode != domain.AuthorizationChat {
		t.Fatalf("missing overrides: %+v", runs.acquireIn)
	}
	for _, test := range []struct{ path, body string }{
		{"get-session-configuration", "{" + identity + `,"organization_id":"foreign"}`},
		{"acquire-run", "{" + identity + `,"session_id":"session","session_configuration":{"base_url":"http://attacker"}}`},
		{"acquire-run", "{" + identity + `,"session_id":"session","session_configuration":{"pricing":{"currency":"USD","input_per_million":0,"output_per_million":0}}}`},
		{"set-agent-authorization", "{" + identity + `,"expected_authorization_revision":1,"authorization":{"mode":"auto","tool_rules":[],"admin":true}}`},
		{"set-agent-authorization", "{" + identity + `,"expected_authorization_revision":1,"authorization":{"mode":"auto"}}`},
		{"set-agent-authorization", "{" + identity + `,"expected_authorization_revision":1,"authorization":{"mode":"auto","tool_rules":null}}`},
	} {
		r := httptest.NewRecorder()
		h.ServeHTTP(r, httptest.NewRequest(http.MethodPost, "/rpc/agent-controller/"+test.path, strings.NewReader(test.body)))
		if r.Code != http.StatusBadRequest {
			t.Fatalf("unknown field accepted: %s %d", test.path, r.Code)
		}
	}
}
