package rpc

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
)

func TestLifecycleRPCCarriesManagedMCPWithoutReturningBootstrapValues(t *testing.T) {
	for _, action := range []string{"initialize", "update", "enable"} {
		t.Run(action, func(t *testing.T) {
			service := &fakeService{operation: deployment.Operation{State: deployment.OperationCompleted}}
			revision := ""
			if action != "initialize" {
				revision = `"expected_revision":"` + string(testRuntimeRevision) + `",`
			}
			body := `{` + revision + `"configuration":{"mcp_servers":[{"id":"docs","command":"private-command","args":["private-argument"],"env":{"TOKEN":"private-token"}}]}}`
			request := httptest.NewRequest(http.MethodPost, "/internal/runtimes/agent-1/"+action, strings.NewReader(body))
			request.Header.Set("Idempotency-Key", "request-1")
			response := httptest.NewRecorder()
			newTestHandler(t, service).ServeHTTP(response, request)
			if response.Code != http.StatusOK {
				t.Fatalf("status=%d body=%s", response.Code, response.Body)
			}
			servers := service.configuration.MCPServers
			if len(servers) != 1 || servers[0].Command != "private-command" || servers[0].Args[0] != "private-argument" || servers[0].Env["TOKEN"] != "private-token" {
				t.Fatal("configuration lost at RPC boundary")
			}
			if strings.Contains(response.Body.String(), "private-") {
				t.Fatal("bootstrap configuration leaked in operation response")
			}
		})
	}
}

func TestManagedMCPRPCRejectsUnknownConnectionFields(t *testing.T) {
	service := &fakeService{}
	request := httptest.NewRequest(http.MethodPost, "/internal/runtimes/agent-1/initialize", strings.NewReader(`{"configuration":{"mcp_servers":[{"id":"docs","command":"node","url":"http://child"}]}}`))
	request.Header.Set("Idempotency-Key", "request-1")
	response := httptest.NewRecorder()
	newTestHandler(t, service).ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest || service.initializeCalls != 0 {
		t.Fatal("unknown child endpoint field accepted")
	}
}

func TestLifecycleRPCPinsManagedSecretSourceAndRejectsInlineWrites(t *testing.T) {
	for _, action := range []string{"initialize", "update", "enable"} {
		service := &fakeService{operation: deployment.Operation{State: deployment.OperationCompleted}}
		revision := ""
		if action != "initialize" {
			revision = `"expected_revision":"` + string(testRuntimeRevision) + `",`
		}
		body := `{` + revision + `"configuration":{"managed_mcp_template":{"organization_id":"org","template_id":"template","revision":3},"mcp_servers":[{"id":"docs","command":"node","secret_env":{"API_KEY":{"set":true,"fingerprint":"sha256:1234abcd"}}}]}}`
		r := httptest.NewRequest(http.MethodPost, "/internal/runtimes/agent-1/"+action, strings.NewReader(body))
		r.Header.Set("Idempotency-Key", "secret-request")
		w := httptest.NewRecorder()
		newTestHandler(t, service).ServeHTTP(w, r)
		if w.Code != 200 || service.configuration.ManagedMCPTemplate == nil || service.configuration.ManagedMCPTemplate.Revision != 3 || service.configuration.MCPServers[0].SecretEnv["API_KEY"].Fingerprint != "sha256:1234abcd" {
			t.Fatal("frozen secret metadata lost at RPC boundary", w.Code)
		}
		bad := strings.Replace(body, `{"set":true,"fingerprint":"sha256:1234abcd"}`, `{"value":"private-value"}`, 1)
		r = httptest.NewRequest(http.MethodPost, "/internal/runtimes/agent-1/"+action, strings.NewReader(bad))
		r.Header.Set("Idempotency-Key", "secret-invalid")
		w = httptest.NewRecorder()
		newTestHandler(t, service).ServeHTTP(w, r)
		if w.Code != 400 || strings.Contains(w.Body.String(), "private-value") {
			t.Fatal("inline value accepted or echoed")
		}
	}
}
