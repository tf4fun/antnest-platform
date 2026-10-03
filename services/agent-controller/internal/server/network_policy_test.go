package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

type networkPolicyServiceStub struct {
	reads  [][2]string
	writes []application.SetAgentNetworkPolicyInput
	err    error
}

func (service *networkPolicyServiceStub) GetAgentNetworkPolicy(_ context.Context, org, agent string) (application.AgentNetworkPolicyView, error) {
	service.reads = append(service.reads, [2]string{org, agent})
	return application.AgentNetworkPolicyView{AgentID: agent,
		Policy: application.DesiredNetworkPolicy{NetworkPolicyRevision: ports.NetworkPolicyRevision{
			NetworkPolicyReference: ports.NetworkPolicyReference{PolicyID: "builtin/deny-all", Revision: 1},
			Spec:                   ports.NetworkPolicySpec{SchemaVersion: 1, Action: "deny_all"}, Digest: "sha256:" + strings.Repeat("a", 64)}, ResourceVersion: 7},
		Attachment: application.NetworkAttachmentView{State: "closed", ResourceVersion: 2}}, service.err
}

func (service *networkPolicyServiceStub) SetAgentNetworkPolicy(_ context.Context, input application.SetAgentNetworkPolicyInput) (ports.NetworkPolicyAssignment, error) {
	service.writes = append(service.writes, input)
	return ports.NetworkPolicyAssignment{AgentID: input.AgentID, NetworkPolicyReference: input.NetworkPolicyReference, ResourceVersion: 8}, service.err
}

const networkMutationJSON = `{"request_id":"request-1","organization_id":"org-1","actor_principal_id":"admin-1","policy_id":"builtin/allow-all","revision":1,"expected_resource_version":7}`

func networkHandler(t *testing.T, service NetworkPolicyService) http.Handler {
	t.Helper()
	h, err := newBusinessHandler(t, &catalogServiceStub{}, &lifecycleServiceStub{}, &agentConfigurationServiceStub{}, &agentQueryServiceStub{}, &agentEventServiceStub{}, service, func(context.Context) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	return h
}

func TestNetworkPolicyHandlerUsesScopedWireContract(t *testing.T) {
	t.Parallel()
	compiler := compileControlSchema(t, filepath.Join(repositoryRoot(t), "contracts/agent-controller/control-api.schema.json"))
	for _, scenario := range []struct{ method, path, body, schema string }{
		{http.MethodGet, "/internal/agents/agent-1/network-policy?organization_id=org-1", "", "agent_network_policy"},
		{http.MethodPut, "/internal/agents/agent-1/network-policy", networkMutationJSON, "network_policy_assignment"},
	} {
		service := &networkPolicyServiceStub{}
		response := httptest.NewRecorder()
		networkHandler(t, service).ServeHTTP(response, httptest.NewRequest(scenario.method, scenario.path, strings.NewReader(scenario.body)))
		if response.Code != 200 || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("response=%d %s", response.Code, response.Body.String())
		}
		var value any
		if err := json.Unmarshal(response.Body.Bytes(), &value); err != nil {
			t.Fatal(err)
		}
		schema, err := compiler.Compile("https://antnest.local/agent-controller/control-api.schema.json#/$defs/" + scenario.schema)
		if err != nil {
			t.Fatal(err)
		}
		if err := schema.Validate(value); err != nil {
			t.Fatal(err)
		}
		if scenario.method == http.MethodGet {
			if len(service.reads) != 1 || service.reads[0] != [2]string{"org-1", "agent-1"} {
				t.Fatalf("reads=%v", service.reads)
			}
		} else if len(service.writes) != 1 || service.writes[0].AgentID != "agent-1" || service.writes[0].ExpectedResourceVersion != 7 {
			t.Fatalf("writes=%+v", service.writes)
		}
	}
}

func TestNetworkPolicyHandlerRejectsMalformedEnvelopeWithoutCallingService(t *testing.T) {
	t.Parallel()
	for _, scenario := range []struct{ method, path, body string }{
		{http.MethodGet, "/internal/agents/agent-1/network-policy", ""},
		{http.MethodGet, "/internal/agents/agent-1/network-policy?organization_id=org-1&organization_id=org-2", ""},
		{http.MethodGet, "/internal/agents/agent-1/network-policy?organization_id=org-1&other=x", ""},
		{http.MethodPut, "/internal/agents/agent-1/network-policy?organization_id=org-2", networkMutationJSON},
		{http.MethodPut, "/internal/agents/agent-1/network-policy", strings.Replace(networkMutationJSON, `"revision":1`, `"revision":1,"agent_id":"other"`, 1)},
		{http.MethodPut, "/internal/agents/agent-1/network-policy", networkMutationJSON + `{}`},
	} {
		service := &networkPolicyServiceStub{}
		response := httptest.NewRecorder()
		networkHandler(t, service).ServeHTTP(response, httptest.NewRequest(scenario.method, scenario.path, strings.NewReader(scenario.body)))
		if response.Code != 400 || len(service.reads)+len(service.writes) != 0 {
			t.Fatalf("response=%d %s calls=%v/%v", response.Code, response.Body.String(), service.reads, service.writes)
		}
	}
}

func TestNetworkPolicyHandlerPreservesErrorsWithoutLeakingDependencyText(t *testing.T) {
	t.Parallel()
	for _, scenario := range []struct {
		err    error
		status int
		code   string
		retry  bool
	}{
		{application.ErrAgentNotFound, 404, "agent_not_found", false},
		{application.ErrInvalidInput, 400, "invalid_request", false},
		{&ports.DependencyError{Service: "runtime-egress", Code: "resource_version_conflict", Retryable: true}, 409, "resource_version_conflict", false},
		{&ports.DependencyError{Service: "runtime-egress", Code: "policy_revision_not_found"}, 404, "policy_revision_not_found", false},
		{&ports.DependencyError{Service: "runtime-egress", Code: "agent_network_not_found"}, 404, "agent_network_not_found", false},
		{&ports.DependencyError{Service: "runtime-egress", Code: "agent_network_unavailable"}, 409, "agent_network_unavailable", false},
		{&ports.DependencyError{Service: "runtime-egress", Code: "cleanup_failed"}, 503, "cleanup_failed", true},
		{&ports.DependencyError{Service: "runtime-egress", Code: "invalid_response"}, 502, "dependency_invalid_response", true},
		{context.DeadlineExceeded, 503, "dependency_unavailable", true},
		{errors.New("private-upstream-data"), 500, "internal_error", true},
	} {
		response := httptest.NewRecorder()
		networkHandler(t, &networkPolicyServiceStub{err: scenario.err}).ServeHTTP(response, httptest.NewRequest(http.MethodPut, "/internal/agents/agent-1/network-policy", strings.NewReader(networkMutationJSON)))
		var result errorResponse
		if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		if response.Code != scenario.status || result.Code != scenario.code || result.Retryable != scenario.retry || strings.Contains(response.Body.String(), "private-upstream-data") {
			t.Fatalf("error=%v response=%d %+v", scenario.err, response.Code, result)
		}
	}
}

func TestNetworkPolicyDependencyIsRequired(t *testing.T) {
	t.Parallel()
	_, err := newBusinessHandler(t, &catalogServiceStub{}, &lifecycleServiceStub{}, &agentConfigurationServiceStub{}, &agentQueryServiceStub{}, &agentEventServiceStub{}, nil, func(context.Context) error { return nil })
	if err == nil {
		t.Fatal("missing network service accepted")
	}
}
