package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

const handoffFixturePath = "policy-v2-handoff.json"

func handoffFixture(t *testing.T) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "tests", "integration", "runtime-egress", handoffFixturePath))
	if err != nil {
		t.Fatal(err)
	}
	var fixture map[string]any
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	return fixture
}

func TestNetworkPolicySpecWriteConsumesTheSharedHandoffFixture(t *testing.T) {
	fixture := handoffFixture(t)
	spec, _ := json.Marshal(fixture["spec"])
	ack, _ := json.Marshal(fixture["egress_put_ack"])
	assignment, _ := json.Marshal(fixture["assignment"])
	requests := make(chan policyFlowRequest, 4)
	handler, _ := policyFlowHandler(t, func(w http.ResponseWriter, r *http.Request) {
		payload, err := io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
		}
		path := r.URL.EscapedPath()
		requests <- policyFlowRequest{r.Method, path, string(payload), r.Header.Get("traceparent")}
		switch {
		case r.Method == http.MethodPut && strings.HasPrefix(path, "/internal/policies/"):
			writePolicyFlowBody(t, w, string(ack))
		case r.Method == http.MethodPut && path == "/internal/agent-policy-assignments/agent-1":
			writePolicyFlowBody(t, w, string(assignment))
		default:
			t.Errorf("unexpected Egress call %s %s", r.Method, path)
			w.WriteHeader(http.StatusNotFound)
		}
	})
	body := `{"request_id":"request-handoff-1","organization_id":"` +
		fixture["organization_id"].(string) + `","actor_principal_id":"` +
		fixture["actor_principal_id"].(string) + `","expected_resource_version":1,"spec":` + string(spec) + `}`
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPut, "/internal/agents/agent-1/network-policy", strings.NewReader(body)))
	if response.Code != http.StatusOK || len(requests) != 2 {
		t.Fatalf("handoff write=%d %s calls=%d", response.Code, response.Body.String(), len(requests))
	}
	revisionCall := <-requests
	if revisionCall.method != http.MethodPut {
		t.Fatalf("publication must be PUT: %+v", revisionCall)
	}
	escaped := strings.TrimSuffix(strings.TrimPrefix(revisionCall.path, "/internal/policies/"), "/revisions/1")
	derived, err := url.PathUnescape(escaped)
	if err != nil || derived != fixture["policy_id"] {
		t.Fatalf("derived reference=%q fixture=%v", derived, fixture["policy_id"])
	}
	var publication map[string]json.RawMessage
	if err := json.Unmarshal([]byte(revisionCall.body), &publication); err != nil {
		t.Fatal(err)
	}
	if len(publication) != 1 || string(publication["spec"]) == "" {
		t.Fatalf("publication must carry only the spec: %s", revisionCall.body)
	}
	var sentSpec, fixtureSpec any
	if err := json.Unmarshal(publication["spec"], &sentSpec); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(spec, &fixtureSpec); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(sentSpec, fixtureSpec) {
		t.Fatalf("spec drifted in transit: %s", revisionCall.body)
	}
	casCall := <-requests
	if casCall.method != http.MethodPut || casCall.path != "/internal/agent-policy-assignments/agent-1" {
		t.Fatalf("assignment call: %+v", casCall)
	}
	var cas map[string]any
	if err := json.Unmarshal([]byte(casCall.body), &cas); err != nil {
		t.Fatal(err)
	}
	if len(cas) != 3 || cas["policy_id"] != fixture["policy_id"] || cas["revision"] != float64(1) ||
		cas["expected_resource_version"] != fixture["expected_resource_version"] {
		t.Fatalf("CAS=%v fixture=%v", cas, fixture)
	}
	var result map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(result, fixture["assignment"]) {
		t.Fatalf("ack=%s fixture=%v", response.Body.String(), fixture["assignment"])
	}
}
