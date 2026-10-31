package server

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

const networkPolicyV2SpecJSON = `{"schema_version":2,"default":"deny","rules":[{"action":"allow","domains":["api.github.com"],"ports":[443]},{"action":"allow","cidrs":["10.20.0.15/32"],"ports":[443]}]}`

const networkPolicyV2MutationJSON = `{"request_id":"request-v2","organization_id":"org-1","actor_principal_id":"admin-1","expected_resource_version":7,"spec":` + networkPolicyV2SpecJSON + `}`

func TestNetworkPolicySpecOnlyPutPublishesV2RevisionAndAssigns(t *testing.T) {
	requests := make(chan policyFlowRequest, 4)
	var policyID string
	handler, source := policyFlowHandler(t, func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
		}
		path := r.URL.EscapedPath()
		requests <- policyFlowRequest{r.Method, path, string(body), r.Header.Get("traceparent")}
		var payload map[string]json.RawMessage
		if err := json.Unmarshal(body, &payload); err != nil {
			t.Error(err)
			return
		}
		switch {
		case r.Method == http.MethodPut && strings.HasPrefix(path, "/internal/policies/") && strings.HasSuffix(path, "/revisions/1"):
			escaped := strings.TrimSuffix(strings.TrimPrefix(path, "/internal/policies/"), "/revisions/1")
			policyID, err = url.PathUnescape(escaped)
			if err != nil {
				t.Error(err)
				return
			}
			sum := sha256.Sum256(payload["spec"])
			var specDoc struct {
				SchemaVersion int `json:"schema_version"`
			}
			if err := json.Unmarshal(payload["spec"], &specDoc); err != nil {
				t.Error(err)
				return
			}
			writePolicyFlowBody(t, w, `{"policy_id":"`+policyID+`","revision":1,"schema_version":`+strconv.Itoa(specDoc.SchemaVersion)+`,"digest":"sha256:`+hex.EncodeToString(sum[:])+`"}`)
		case r.Method == http.MethodPut && path == "/internal/agent-policy-assignments/agent-1":
			var assignment map[string]json.RawMessage
			if err := json.Unmarshal(body, &assignment); err != nil {
				t.Error(err)
				return
			}
			writePolicyFlowBody(t, w, `{"agent_id":"agent-1","policy_id":`+string(assignment["policy_id"])+`,"revision":1,"resource_version":8}`)
		default:
			t.Errorf("unexpected Egress call %s %s", r.Method, path)
			w.WriteHeader(http.StatusNotFound)
		}
	})
	before := source.record
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPut, "/internal/agents/agent-1/network-policy", strings.NewReader(networkPolicyV2MutationJSON)))
	if response.Code != http.StatusOK {
		t.Fatalf("spec-only policy write=%d %s", response.Code, response.Body.String())
	}
	var result map[string]json.RawMessage
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if len(requests) != 2 {
		t.Fatalf("expected exactly 2 Egress calls, got %d", len(requests))
	}
	revisionCall := <-requests
	assignmentCall := <-requests
	if revisionCall.method != http.MethodPut {
		t.Fatalf("revision publish must be PUT: %+v", revisionCall)
	}
	escapedID := strings.TrimSuffix(strings.TrimPrefix(revisionCall.path, "/internal/policies/"), "/revisions/1")
	if policyID == "" || escapedID == "" {
		t.Fatalf("spec-only write must derive a policy revision identity: %+v", revisionCall)
	}
	var specBody map[string]json.RawMessage
	if err := json.Unmarshal([]byte(revisionCall.body), &specBody); err != nil {
		t.Fatal(err)
	}
	if len(specBody) != 1 || specBody["spec"] == nil {
		t.Fatalf("revision PUT must carry only the spec document: %s", revisionCall.body)
	}
	var expectedSpec, actualSpec any
	if err := json.Unmarshal([]byte(networkPolicyV2SpecJSON), &expectedSpec); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(specBody["spec"], &actualSpec); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(expectedSpec, actualSpec) {
		t.Fatalf("spec not carried verbatim: %s", revisionCall.body)
	}
	var assignment map[string]json.RawMessage
	if assignmentCall.method != http.MethodPut || assignmentCall.path != "/internal/agent-policy-assignments/agent-1" {
		t.Fatalf("assignment call: %+v", assignmentCall)
	}
	if err := json.Unmarshal([]byte(assignmentCall.body), &assignment); err != nil {
		t.Fatal(err)
	}
	if string(assignment["policy_id"]) != `"`+policyID+`"` || string(assignment["revision"]) != "1" || string(assignment["expected_resource_version"]) != "7" {
		t.Fatalf("assignment must reference the derived revision at expected version 7: %s", assignmentCall.body)
	}
	if string(result["policy_id"]) != `"`+policyID+`"` || string(result["revision"]) != "1" || string(result["resource_version"]) != "8" {
		t.Fatalf("response must echo derived ref at assignment version 8: %s", response.Body.String())
	}
	if !reflect.DeepEqual(before, source.record) {
		t.Fatalf("spec-only write changed Agent: %+v", source.record)
	}
}

func TestNetworkPolicyReadRoundTripsV2SpecVerbatim(t *testing.T) {
	requests := make(chan policyFlowRequest, 8)
	handler, source := policyFlowHandler(t, func(w http.ResponseWriter, r *http.Request) {
		recordPolicyFlowRequest(t, r, requests)
		switch r.URL.EscapedPath() {
		case "/internal/policies/builtin%2Fallow-all/revisions/1":
			writePolicyFlowBody(t, w, `{"policy_id":"builtin/allow-all","revision":1,"spec":`+networkPolicyV2SpecJSON+`,"digest":"sha256:`+strings.Repeat("b", 64)+`"}`)
		default:
			writePolicyFlowBody(t, w, policyFlowReadBody(r.URL.EscapedPath()))
		}
	})
	before := source.record
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/internal/agents/agent-1/network-policy?organization_id=org-1", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("v2 spec read=%d %s", response.Code, response.Body.String())
	}
	var view map[string]json.RawMessage
	if err := json.Unmarshal(response.Body.Bytes(), &view); err != nil {
		t.Fatal(err)
	}
	var policy map[string]json.RawMessage
	if err := json.Unmarshal(view["policy"], &policy); err != nil {
		t.Fatal(err)
	}
	var expectedSpec, actualSpec any
	if err := json.Unmarshal([]byte(networkPolicyV2SpecJSON), &expectedSpec); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(policy["spec"], &actualSpec); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(expectedSpec, actualSpec) {
		t.Fatalf("v2 spec not round-tripped verbatim: %s", policy["spec"])
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

func TestNetworkPolicySpecOnlyRejectsMalformedBodiesBeforeEgress(t *testing.T) {
	base := `"request_id":"r","organization_id":"org-1","actor_principal_id":"a","expected_resource_version":7`
	spec := `"spec":{"schema_version":2,"default":"deny","rules":[]}`
	invalid := []string{
		`{` + base + `,"policy_id":"","revision":0,` + spec + `}`,
		`{` + base + `,"policy_id":"builtin/allow-all",` + spec + `}`,
		`{` + base + `,"revision":1,` + spec + `}`,
		`{` + base + `,"spec":null}`,
		`{` + base + `,"spec":null,"spec":null}`,
		`{` + base + `,"spec":{"schema_version":2,"default":"deny","rules":[],"action":"deny_all"}}`,
		`{` + base + `,"spec":{"schema_version":2,"default":"deny","rules":[{"action":"allow","cidrs":["10.0.0.1/24"]}]}}`,
		`{` + base + `,"spec":{"schema_version":2,"default":"deny","rules":[{"action":"allow","protocol":""}]}}`,
		`{` + base + `,"spec":{"schema_version":3,"default":"deny","rules":[]}}`,
		`{` + base + `,"spec":{"schema_version":2,"default":"deny","rules":[],"extra":1}}`,
	}
	for index, document := range invalid {
		requests := make(chan policyFlowRequest, 2)
		handler, _ := policyFlowHandler(t, func(w http.ResponseWriter, r *http.Request) {
			recordPolicyFlowRequest(t, r, requests)
			writePolicyFlowBody(t, w, `{}`)
		})
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodPut, "/internal/agents/agent-1/network-policy", strings.NewReader(document)))
		if response.Code != http.StatusBadRequest || len(requests) != 0 {
			t.Fatalf("malformed body %d: %d %s calls=%d", index, response.Code, response.Body.String(), len(requests))
		}
	}
}

func TestNetworkPolicySpecOnlyForeignScopeNeverPublishes(t *testing.T) {
	requests := make(chan policyFlowRequest, 2)
	handler, _ := policyFlowHandler(t, func(w http.ResponseWriter, r *http.Request) {
		recordPolicyFlowRequest(t, r, requests)
		writePolicyFlowBody(t, w, `{}`)
	})
	foreign := strings.Replace(networkPolicyV2MutationJSON, `"org-1"`, `"foreign"`, 1)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPut, "/internal/agents/agent-1/network-policy", strings.NewReader(foreign)))
	if response.Code != http.StatusNotFound || len(requests) != 0 {
		t.Fatalf("cross-org spec write=%d calls=%d", response.Code, len(requests))
	}
}

func TestNetworkPolicySpecOnlyPutPreservesPortShapesAtHTTPBoundary(t *testing.T) {
	for name, ports := range map[string]string{
		"scalar": `"ports":[443]`,
		"range":  `"ports":[{"from":400,"to":450}]`,
		"equal":  `"ports":[{"from":443,"to":443}]`,
	} {
		t.Run(name, func(t *testing.T) {
			requests := make(chan policyFlowRequest, 4)
			var policyID string
			handler, _ := policyFlowHandler(t, func(w http.ResponseWriter, r *http.Request) {
				payload, err := io.ReadAll(r.Body)
				if err != nil {
					t.Error(err)
				}
				path := r.URL.EscapedPath()
				requests <- policyFlowRequest{r.Method, path, string(payload), r.Header.Get("traceparent")}
				if strings.HasPrefix(path, "/internal/policies/") {
					escaped := strings.TrimSuffix(strings.TrimPrefix(path, "/internal/policies/"), "/revisions/1")
					policyID, err = url.PathUnescape(escaped)
					if err != nil {
						t.Error(err)
						return
					}
					var object map[string]json.RawMessage
					if err := json.Unmarshal(payload, &object); err != nil {
						t.Error(err)
						return
					}
					sum := sha256.Sum256(object["spec"])
					var specDoc struct {
						SchemaVersion int `json:"schema_version"`
					}
					if err := json.Unmarshal(object["spec"], &specDoc); err != nil {
						t.Error(err)
						return
					}
					writePolicyFlowBody(t, w, `{"policy_id":"`+policyID+`","revision":1,"schema_version":`+strconv.Itoa(specDoc.SchemaVersion)+`,"digest":"sha256:`+hex.EncodeToString(sum[:])+`"}`)
					return
				}
				writePolicyFlowBody(t, w, `{"agent_id":"agent-1","policy_id":"`+policyID+`","revision":1,"resource_version":8}`)
			})
			body := `{"request_id":"r","organization_id":"org-1","actor_principal_id":"a","expected_resource_version":7,"spec":{"schema_version":2,"default":"deny","rules":[{"action":"allow","cidrs":["93.184.216.0/24"],` + ports + `}]}}`
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, httptest.NewRequest(http.MethodPut, "/internal/agents/agent-1/network-policy", strings.NewReader(body)))
			if response.Code != http.StatusOK {
				t.Fatalf("port shape %s rejected: %d %s", name, response.Code, response.Body.String())
			}
			call := <-requests
			if !strings.Contains(call.body, ports) {
				t.Fatalf("port shape not preserved upstream: %s", call.body)
			}
		})
	}
}

func TestNetworkPolicySpecOnlyStopsCASOnWrongDigestAck(t *testing.T) {
	requests := make(chan policyFlowRequest, 4)
	var policyID string
	handler, _ := policyFlowHandler(t, func(w http.ResponseWriter, r *http.Request) {
		payload, err := io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
		}
		path := r.URL.EscapedPath()
		requests <- policyFlowRequest{r.Method, path, string(payload), r.Header.Get("traceparent")}
		if strings.HasPrefix(path, "/internal/policies/") {
			escaped := strings.TrimSuffix(strings.TrimPrefix(path, "/internal/policies/"), "/revisions/1")
			policyID, err = url.PathUnescape(escaped)
			if err != nil {
				t.Error(err)
				return
			}
			writePolicyFlowBody(t, w, `{"policy_id":"`+policyID+`","revision":1,"schema_version":2,"digest":"sha256:`+strings.Repeat("f", 64)+`"}`)
			return
		}
		t.Errorf("unexpected downstream call: %s %s", r.Method, path)
	})
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPut, "/internal/agents/agent-1/network-policy", strings.NewReader(networkPolicyV2MutationJSON)))
	if response.Code != http.StatusBadGateway || len(requests) != 1 {
		t.Fatalf("wrong digest must stop before CAS: %d %s calls=%d", response.Code, response.Body.String(), len(requests))
	}
	call := <-requests
	if call.method != http.MethodPut || !strings.HasPrefix(call.path, "/internal/policies/") {
		t.Fatalf("unexpected call: %+v", call)
	}
}
