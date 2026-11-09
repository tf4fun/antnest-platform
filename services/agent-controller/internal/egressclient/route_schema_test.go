package egressclient

import (
	"context"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/contracttest"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

type schemaTransport func(*http.Request) (*http.Response, error)

func (fn schemaTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	return fn(request)
}

type egressContractRoute struct {
	Method      string `json:"method"`
	Path        string `json:"path"`
	Caller      string `json:"caller"`
	RequestBody string `json:"request_body"`
	Responses   map[string]struct {
		Body string `json:"body"`
	} `json:"responses"`
}

func loadEgressContract(t *testing.T) map[string]egressContractRoute {
	t.Helper()
	payload, err := os.ReadFile(filepath.Join("../../../../contracts/egress/control-contract.json"))
	if err != nil {
		t.Fatal(err)
	}
	var contract struct {
		Routes []egressContractRoute `json:"routes"`
	}
	if err := json.Unmarshal(payload, &contract); err != nil {
		t.Fatal(err)
	}
	routes := map[string]egressContractRoute{}
	for _, route := range contract.Routes {
		routes[route.Method+" "+route.Path] = route
	}
	return routes
}

func goldenBytes(t *testing.T, rel string) []byte {
	t.Helper()
	payload, err := os.ReadFile(filepath.Join("../../../../contracts", rel))
	if err != nil {
		t.Fatalf("read golden %s: %v", rel, err)
	}
	contracttest.ValidateGolden(t, rel, payload)
	return payload
}

func goldenVariant(t *testing.T, rel string, mutate func(map[string]any)) []byte {
	t.Helper()
	payload := goldenBytes(t, rel)
	var document map[string]any
	if err := json.Unmarshal(payload, &document); err != nil {
		t.Fatal(err)
	}
	mutate(document)
	encoded, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

type capturedRequest struct {
	method, path, contentType string
	body                      []byte
}

func exchangeClient(t *testing.T, captured *capturedRequest) (*Client, *[]byte) {
	t.Helper()
	var response []byte
	client, err := New("http://upstream.internal", 5*time.Second, &http.Client{
		Transport: schemaTransport(func(request *http.Request) (*http.Response, error) {
			body, err := io.ReadAll(request.Body)
			if err != nil {
				t.Errorf("read request body: %v", err)
			}
			*captured = capturedRequest{
				method:      request.Method,
				path:        request.URL.EscapedPath(),
				contentType: request.Header.Get("Content-Type"),
				body:        body,
			}
			return &http.Response{
				StatusCode: http.StatusOK,
				Header: http.Header{
					"Content-Type":  []string{"application/json"},
					"Cache-Control": []string{"no-store"},
				},
				Body:    io.NopCloser(strings.NewReader(string(response))),
				Request: request,
			}, nil
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	return client, &response
}

func assertExchange(t *testing.T, route egressContractRoute, captured capturedRequest, expectedPath string, response []byte) {
	t.Helper()
	label := route.Method + " " + route.Path
	if captured.method != route.Method {
		t.Fatalf("%s sent method %s", label, captured.method)
	}
	if captured.path != expectedPath {
		t.Fatalf("%s path %q, want %q", label, captured.path, expectedPath)
	}
	if route.RequestBody != "" && route.RequestBody != "none" {
		if captured.contentType != "application/json" {
			t.Fatalf("%s content type %q", label, captured.contentType)
		}
		contracttest.Validate(t, "egress/"+route.RequestBody, captured.body)
	} else if len(captured.body) != 0 {
		t.Fatalf("%s declared no request body but sent %d bytes", label, len(captured.body))
	}
	entry, ok := route.Responses["200"]
	if !ok || entry.Body == "" || entry.Body == "none" {
		t.Fatalf("%s lacks a declared JSON 200 body", label)
	}
	contracttest.Validate(t, "egress/"+entry.Body, response)
}

func requestFields(t *testing.T, label string, captured capturedRequest) map[string]any {
	t.Helper()
	var body map[string]any
	if err := json.Unmarshal(captured.body, &body); err != nil {
		t.Fatalf("%s request not JSON: %v", label, err)
	}
	return body
}

func assertCanonicalVersion(t *testing.T, label, expected string, captured capturedRequest) {
	t.Helper()
	body := requestFields(t, label, captured)
	if body["expected_version"] != expected {
		t.Fatalf("%s expected_version %v, want %q: %s", label, body["expected_version"], expected, string(captured.body))
	}
	for _, legacy := range []string{"expected_resource_version", "expected_revision"} {
		if _, ok := body[legacy]; ok {
			t.Fatalf("%s emits legacy %s: %s", label, legacy, string(captured.body))
		}
	}
}

func TestRouteSchemaEgressRequests(t *testing.T) {
	routes := loadEgressContract(t)
	covered := map[string]bool{}
	lookupRoute := func(method, path string) egressContractRoute {
		t.Helper()
		route, ok := routes[method+" "+path]
		if !ok {
			t.Fatalf("contract missing %s %s", method, path)
		}
		covered[method+" "+path] = true
		return route
	}

	ctx := context.Background()
	agent := "agent-1"
	networkClosed := goldenBytes(t, "egress/examples/network.closed.json")
	networkOpen := goldenBytes(t, "egress/examples/network.open.json")
	assignment := goldenBytes(t, "egress/examples/assignment.current.json")
	policy := goldenBytes(t, "egress/examples/policy.v1.json")
	policyMetadata := goldenBytes(t, "egress/examples/policy-metadata.v1.json")
	endpoint := "10.243.1.20"
	tunnelKey := "rtk_0123456789abcdef0123456789abcdef"

	t.Run("ensure", func(t *testing.T) {
		route := lookupRoute("PUT", "/internal/agent-networks/{agent_id}")
		var captured capturedRequest
		client, response := exchangeClient(t, &captured)
		*response = networkClosed
		result, err := client.EnsureAgentNetwork(ctx, agent)
		if err != nil {
			t.Fatal(err)
		}
		if result.AgentID != agent {
			t.Fatalf("decoded %+v", result)
		}
		assertExchange(t, route, captured, "/internal/agent-networks/"+agent, *response)
	})

	t.Run("get", func(t *testing.T) {
		route := lookupRoute("GET", "/internal/agent-networks/{agent_id}")
		var captured capturedRequest
		client, response := exchangeClient(t, &captured)
		*response = networkClosed
		result, err := client.GetAgentNetwork(ctx, agent)
		if err != nil {
			t.Fatal(err)
		}
		if result.AgentID != agent {
			t.Fatalf("decoded %+v", result)
		}
		assertExchange(t, route, captured, "/internal/agent-networks/"+agent, *response)
	})

	t.Run("closed", func(t *testing.T) {
		route := lookupRoute("PUT", "/internal/agent-network-attachments/{agent_id}")
		var captured capturedRequest
		client, response := exchangeClient(t, &captured)
		*response = networkClosed
		result, err := client.SetAgentNetworkAttachment(ctx, agent, "closed", math.MaxInt64, "", "")
		if err != nil {
			t.Fatal(err)
		}
		if result.AgentID != agent {
			t.Fatalf("decoded %+v", result)
		}
		assertExchange(t, route, captured, "/internal/agent-network-attachments/"+agent, *response)
		assertCanonicalVersion(t, "closed", "9223372036854775807", captured)
	})

	t.Run("pending", func(t *testing.T) {
		route := lookupRoute("PUT", "/internal/agent-network-attachments/{agent_id}")
		var captured capturedRequest
		client, response := exchangeClient(t, &captured)
		*response = goldenVariant(t, "egress/examples/network.closed.json", func(doc map[string]any) {
			doc["attachment_state"] = "pending"
		})
		result, err := client.SetAgentNetworkAttachment(ctx, agent, "pending", 3, "", "")
		if err != nil {
			t.Fatal(err)
		}
		if result.AgentID != agent {
			t.Fatalf("decoded %+v", result)
		}
		assertExchange(t, route, captured, "/internal/agent-network-attachments/"+agent, *response)
		assertCanonicalVersion(t, "pending", "3", captured)
	})

	t.Run("open", func(t *testing.T) {
		route := lookupRoute("PUT", "/internal/agent-network-attachments/{agent_id}")
		var captured capturedRequest
		client, response := exchangeClient(t, &captured)
		*response = networkOpen
		result, err := client.SetAgentNetworkAttachment(ctx, agent, "open", 1, endpoint, tunnelKey)
		if err != nil {
			t.Fatal(err)
		}
		if result.AgentID != agent {
			t.Fatalf("decoded %+v", result)
		}
		assertExchange(t, route, captured, "/internal/agent-network-attachments/"+agent, *response)
		assertCanonicalVersion(t, "open", "1", captured)
		body := requestFields(t, "open", captured)
		if body["runtime_endpoint"] != endpoint || body["tunnel_key_id"] != tunnelKey {
			t.Fatalf("open request peer fields: %s", string(captured.body))
		}
	})

	t.Run("release", func(t *testing.T) {
		route := lookupRoute("POST", "/internal/agent-networks/{agent_id}/release")
		var captured capturedRequest
		client, response := exchangeClient(t, &captured)
		*response = goldenVariant(t, "egress/examples/network.closed.json", func(doc map[string]any) {
			doc["state"] = "quarantined"
		})
		result, err := client.ReleaseAgentNetwork(ctx, agent, math.MaxInt64)
		if err != nil {
			t.Fatal(err)
		}
		if result.AgentID != agent {
			t.Fatalf("decoded %+v", result)
		}
		assertExchange(t, route, captured, "/internal/agent-networks/"+agent+"/release", *response)
		assertCanonicalVersion(t, "release", "9223372036854775807", captured)
	})

	t.Run("assignment-get", func(t *testing.T) {
		route := lookupRoute("GET", "/internal/agent-policy-assignments/{agent_id}")
		var captured capturedRequest
		client, response := exchangeClient(t, &captured)
		*response = assignment
		result, err := client.GetAgentPolicyAssignment(ctx, agent)
		if err != nil {
			t.Fatal(err)
		}
		if result.AgentID != agent {
			t.Fatalf("decoded %+v", result)
		}
		assertExchange(t, route, captured, "/internal/agent-policy-assignments/"+agent, *response)
	})

	t.Run("assignment-set", func(t *testing.T) {
		route := lookupRoute("PUT", "/internal/agent-policy-assignments/{agent_id}")
		var captured capturedRequest
		client, response := exchangeClient(t, &captured)
		*response = assignment
		input := ports.SetNetworkPolicy{
			NetworkPolicyReference:  ports.NetworkPolicyReference{PolicyID: "builtin/allow-all", Revision: 1},
			ExpectedResourceVersion: 1,
		}
		result, err := client.SetAgentPolicyAssignment(ctx, agent, input)
		if err != nil {
			t.Fatal(err)
		}
		if result.PolicyID != "builtin/allow-all" {
			t.Fatalf("decoded %+v", result)
		}
		assertExchange(t, route, captured, "/internal/agent-policy-assignments/"+agent, *response)
		assertCanonicalVersion(t, "assignment-set", "1", captured)
	})

	t.Run("policy-get", func(t *testing.T) {
		route := lookupRoute("GET", "/internal/policies/{policy_id}/revisions/{revision}")
		var captured capturedRequest
		client, response := exchangeClient(t, &captured)
		*response = policy
		ref := ports.NetworkPolicyReference{PolicyID: "builtin/allow-all", Revision: 1}
		result, err := client.GetPolicyRevision(ctx, ref)
		if err != nil {
			t.Fatal(err)
		}
		if result.PolicyID != "builtin/allow-all" {
			t.Fatalf("decoded %+v", result)
		}
		assertExchange(t, route, captured, "/internal/policies/builtin%2Fallow-all/revisions/1", *response)
	})

	t.Run("policy-put", func(t *testing.T) {
		route := lookupRoute("PUT", "/internal/policies/{policy_id}/revisions/{revision}")
		var captured capturedRequest
		client, response := exchangeClient(t, &captured)
		*response = policyMetadata
		ref := ports.NetworkPolicyReference{PolicyID: "builtin/allow-all", Revision: 1}
		var specDocument map[string]any
		if err := json.Unmarshal(policy, &specDocument); err != nil {
			t.Fatal(err)
		}
		raw, _ := json.Marshal(specDocument["spec"])
		var spec ports.NetworkPolicySpec
		if err := json.Unmarshal(raw, &spec); err != nil {
			t.Fatal(err)
		}
		result, err := client.PutPolicyRevision(ctx, ref, spec)
		if err != nil {
			t.Fatal(err)
		}
		if result.PolicyID != "builtin/allow-all" {
			t.Fatalf("decoded %+v", result)
		}
		assertExchange(t, route, captured, "/internal/policies/builtin%2Fallow-all/revisions/1", *response)
	})

	for key, route := range routes {
		if route.Caller == "agent-controller" && !covered[key] {
			t.Fatalf("agent-controller route %s has no consumer coverage", key)
		}
	}
}
