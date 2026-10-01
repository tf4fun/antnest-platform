package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/egressclient"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

type policyFlowAgent struct{ record ports.AgentRecord }

func (source *policyFlowAgent) GetAgent(context.Context, string) (ports.AgentRecord, error) {
	return source.record, nil
}

func policyFlowHandler(t *testing.T, upstream http.HandlerFunc) (http.Handler, *policyFlowAgent) {
	t.Helper()
	egress := httptest.NewServer(upstream)
	t.Cleanup(egress.Close)
	client, err := egressclient.New(egress.URL, time.Second, egress.Client())
	if err != nil {
		t.Fatal(err)
	}
	source := &policyFlowAgent{record: ports.AgentRecord{
		AgentID: "agent-1", OrganizationID: "org-1", OwnerUserID: "user-1",
		LifecycleState: domain.AgentCreated, ActivationState: domain.ActivationDisabled, RuntimeState: domain.RuntimeAbsent, DesiredState: domain.DesiredDisabled,
		AgentSpecRevisionID: "spec-1", RuntimeRevision: "runtime-1", AggregateSequence: 7,
	}}
	return networkHandler(t, application.NewNetworkPolicyService(source, client)), source
}

const policyFlowAssignment = `{"agent_id":"agent-1","policy_id":"builtin/allow-all","revision":1,"resource_version":8}`
const policyFlowAttachment = `{"agent_id":"agent-1","tunnel_ipv4":"10.90.0.2","resolver_ipv4":"10.90.0.1","egress_endpoint":{"ipv4":"172.20.0.5","port":9000},"packet_contract_revision":1,"state":"active","network_resource_version":1,"attachment_state":"closed","attachment_resource_version":4}`

func policyFlowReadBody(path string) string {
	switch path {
	case "/internal/agent-policy-assignments/agent-1":
		return policyFlowAssignment
	case "/internal/policies/builtin%2Fallow-all/revisions/1":
		return `{"policy_id":"builtin/allow-all","revision":1,"spec":{"schema_version":1,"action":"allow_all"},"digest":"sha256:` + strings.Repeat("a", 64) + `"}`
	case "/internal/agent-networks/agent-1":
		return policyFlowAttachment
	default:
		return `{}`
	}
}

type policyFlowRequest struct{ method, path, body, traceparent string }

func recordPolicyFlowRequest(t *testing.T, r *http.Request, requests chan<- policyFlowRequest) {
	t.Helper()
	body, err := io.ReadAll(r.Body)
	if err != nil {
		t.Error(err)
	}
	requests <- policyFlowRequest{r.Method, r.URL.EscapedPath(), string(body), r.Header.Get("traceparent")}
}

func writePolicyFlowBody(t *testing.T, w http.ResponseWriter, body string) {
	t.Helper()
	w.Header().Set("Content-Type", "application/json")
	if _, err := io.WriteString(w, body); err != nil {
		t.Error(err)
	}
}

func TestNetworkPolicyFlowScopeAndReadCannotChangeRuntime(t *testing.T) {
	t.Parallel()
	requests := make(chan policyFlowRequest, 8)
	handler, source := policyFlowHandler(t, func(w http.ResponseWriter, r *http.Request) {
		recordPolicyFlowRequest(t, r, requests)
		writePolicyFlowBody(t, w, policyFlowReadBody(r.URL.EscapedPath()))
	})
	before := source.record
	for _, method := range []string{http.MethodGet, http.MethodPut} {
		path := "/internal/agents/agent-1/network-policy"
		if method == http.MethodGet {
			path += "?organization_id=foreign"
		}
		body := strings.Replace(networkMutationJSON, `"org-1"`, `"foreign"`, 1)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(method, path, strings.NewReader(body)))
		if response.Code != http.StatusNotFound || len(requests) != 0 {
			t.Fatalf("foreign request: %d calls=%d", response.Code, len(requests))
		}
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/internal/agents/agent-1/network-policy?organization_id=org-1", nil))
	var view application.AgentNetworkPolicyView
	if err := json.Unmarshal(response.Body.Bytes(), &view); err != nil {
		t.Fatal(err)
	}
	if response.Code != 200 || view.Policy.Spec.Action != "allow_all" || view.Policy.ResourceVersion != 8 || view.Attachment.State != "closed" || view.Attachment.ResourceVersion != 4 {
		t.Fatalf("read=%d %+v", response.Code, view)
	}
	if len(requests) != 3 || !reflect.DeepEqual(before, source.record) {
		t.Fatalf("read changed Agent or extra calls: %d %+v", len(requests), source.record)
	}
	for _, path := range []string{"/internal/agent-policy-assignments/agent-1", "/internal/policies/builtin%2Fallow-all/revisions/1", "/internal/agent-networks/agent-1"} {
		request := <-requests
		if request.method != http.MethodGet || request.path != path {
			t.Fatalf("unexpected dependency call: %+v", request)
		}
	}
}

func TestNetworkPolicyFlowLostAcknowledgementNeedsOriginalCASReplay(t *testing.T) {
	t.Parallel()
	requests := make(chan policyFlowRequest, 8)
	firstWrite := true
	handler, source := policyFlowHandler(t, func(w http.ResponseWriter, r *http.Request) {
		recordPolicyFlowRequest(t, r, requests)
		if r.Method == http.MethodPut && firstWrite {
			firstWrite = false
			// Simulate a committed assignment whose response is truncated in transit.
			w.Header().Set("Content-Length", "100")
			writePolicyFlowBody(t, w, `{}`)
			return
		}
		writePolicyFlowBody(t, w, policyFlowReadBody(r.URL.EscapedPath()))
	})
	before := source.record
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPut, "/internal/agents/agent-1/network-policy", strings.NewReader(networkMutationJSON)))
	if response.Code != 502 || len(requests) != 1 {
		t.Fatalf("unacknowledged command=%d %s calls=%d", response.Code, response.Body.String(), len(requests))
	}
	original := <-requests
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/internal/agents/agent-1/network-policy?organization_id=org-1", nil))
	if response.Code != 200 || len(requests) != 3 {
		t.Fatalf("read after lost acknowledgement=%d calls=%d", response.Code, len(requests))
	}
	for range 3 {
		if request := <-requests; request.method != http.MethodGet {
			t.Fatalf("read repaired a mutation: %+v", request)
		}
	}
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPut, "/internal/agents/agent-1/network-policy", strings.NewReader(networkMutationJSON)))
	if response.Code != 200 || len(requests) != 1 || !reflect.DeepEqual(before, source.record) {
		t.Fatalf("explicit replay=%d calls=%d Agent=%+v", response.Code, len(requests), source.record)
	}
	replay := <-requests
	if original.method != replay.method || original.path != replay.path || original.body != replay.body {
		t.Fatalf("CAS tuple changed: %+v -> %+v", original, replay)
	}
}

func TestNetworkPolicyFlowConflictNeverRebasesVersion(t *testing.T) {
	t.Parallel()
	requests := make(chan policyFlowRequest, 4)
	handler, _ := policyFlowHandler(t, func(w http.ResponseWriter, r *http.Request) {
		recordPolicyFlowRequest(t, r, requests)
		w.WriteHeader(http.StatusConflict)
		writePolicyFlowBody(t, w, `{"code":"resource_version_conflict","retryable":false}`)
	})
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPut, "/internal/agents/agent-1/network-policy", strings.NewReader(networkMutationJSON)))
	if response.Code != 409 || len(requests) != 1 {
		t.Fatalf("conflict=%d calls=%d", response.Code, len(requests))
	}
	var mutation ports.SetNetworkPolicy
	if err := json.Unmarshal([]byte((<-requests).body), &mutation); err != nil {
		t.Fatal(err)
	}
	if mutation.ExpectedResourceVersion != 7 {
		t.Fatalf("rebased version: %+v", mutation)
	}
}
