package server

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/callercontext"
	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
)

type countedWorkspaceQueries struct {
	agentQueryServiceStub
	calls int
}

func (q *countedWorkspaceQueries) ListWorkspaceAgents(ctx context.Context, input application.ListWorkspaceAgentsInput) (application.WorkspaceAgentPage, error) {
	q.calls++
	return q.agentQueryServiceStub.ListWorkspaceAgents(ctx, input)
}

func TestControllerRetiredGatewayRejectedBeforeContextAndBusiness(t *testing.T) {
	const path = "/rpc/agent-controller/list-workspace-agents"
	const body = `{"request_id":"retirement-1","organization_id":"org-1","principal_id":"user-admin"}`
	for _, scenario := range []struct {
		name, caller, path, method, body, context string
		status                                    int
		code                                      string
		duplicate, keyUnavailable                 bool
	}{
		{name: "Gateway valid signed scope", caller: "edge-gateway", status: 403, code: "caller_not_allowed"},
		{name: "Gateway missing context", caller: "edge-gateway", context: "missing", status: 403, code: "caller_not_allowed"},
		{name: "Gateway forged context", caller: "edge-gateway", context: "forged", status: 403, code: "caller_not_allowed"},
		{name: "Gateway duplicate context", caller: "edge-gateway", duplicate: true, status: 403, code: "caller_not_allowed"},
		{name: "Gateway malformed body", caller: "edge-gateway", body: "{", status: 403, code: "caller_not_allowed"},
		{name: "Gateway unavailable keys", caller: "edge-gateway", keyUnavailable: true, status: 403, code: "caller_not_allowed"},
		{name: "Gateway unknown route", caller: "edge-gateway", path: "/internal/retired-gateway-probe", method: "GET", status: 403, code: "caller_not_allowed"},
		{name: "Gateway wrong method", caller: "edge-gateway", method: "GET", status: 403, code: "caller_not_allowed"},
		{name: "Agent UI signed ordinary member", caller: "agent-ui", status: 200},
		{name: "Agent UI actor mismatch", caller: "agent-ui", body: `{"request_id":"retirement-1","organization_id":"org-1","principal_id":"other"}`, status: 403, code: "actor_mismatch"},
		{name: "Agent UI organization mismatch", caller: "agent-ui", body: `{"request_id":"retirement-1","organization_id":"other","principal_id":"user-admin"}`, status: 403, code: "organization_mismatch"},
		{name: "Agent UI missing context", caller: "agent-ui", context: "missing", status: 401, code: "caller_context_required"},
		{name: "Agent UI forged context", caller: "agent-ui", context: "forged", status: 401, code: "caller_context_invalid"},
		{name: "Agent UI duplicate context", caller: "agent-ui", duplicate: true, status: 401, code: "caller_context_invalid"},
		{name: "Agent UI unavailable keys", caller: "agent-ui", keyUnavailable: true, status: 503, code: "identity_dependency_unavailable"},
		{name: "public health", caller: "edge-gateway", path: "/status", method: "GET", context: "missing", status: 200},
		{name: "public health HEAD", caller: "edge-gateway", path: "/status", method: "HEAD", context: "missing", status: 200},
		{name: "public RPC health", caller: "edge-gateway", path: "/rpc/agent-controller/status", method: "GET", context: "missing", status: 200},
		{name: "public RPC health HEAD", caller: "edge-gateway", path: "/rpc/agent-controller/status", method: "HEAD", context: "missing", status: 200},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			f := newAuthenticationFixture(t)
			var keyCalls atomic.Int32
			public := f.key.Public().(ed25519.PublicKey)
			jwks, err := json.Marshal(map[string]any{"keys": []any{map[string]string{
				"kid": "fixture", "kty": "OKP", "crv": "Ed25519", "use": "sig", "alg": "EdDSA", "x": base64.RawURLEncoding.EncodeToString(public),
			}}})
			if err != nil {
				t.Fatal(err)
			}
			f.security.CallerContext, err = callercontext.NewVerifier("http://identity.fixture", &http.Client{Transport: fixtureTransport(func(r *http.Request) (*http.Response, error) {
				keyCalls.Add(1)
				if r.URL.Path != "/rpc/identity/jwks" {
					t.Error("unexpected Identity request")
				}
				status := http.StatusOK
				if scenario.keyUnavailable {
					status = http.StatusServiceUnavailable
				}
				return &http.Response{StatusCode: status, Body: io.NopCloser(bytes.NewReader(jwks))}, nil
			})}, time.Second)
			if err != nil {
				t.Fatal(err)
			}
			queries := &countedWorkspaceQueries{}
			f.raw, err = NewHandler(&catalogServiceStub{}, &lifecycleServiceStub{}, &agentConfigurationServiceStub{}, queries,
				&agentEventServiceStub{}, &networkPolicyServiceStub{}, func(context.Context) error { return nil }, f.security)
			if err != nil {
				t.Fatal(err)
			}
			f.raw, err = WithSkillLearningPolicyRoutes(f.raw, &learningPolicyServiceStub{}, f.security)
			if err != nil {
				t.Fatal(err)
			}
			method, target, input := scenario.method, scenario.path, scenario.body
			if method == "" {
				method = http.MethodPost
			}
			if target == "" {
				target = path
			}
			if input == "" {
				input = body
			}
			r := httptest.NewRequest(method, target, strings.NewReader(input))
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set(serviceauth.Header, "Bearer "+f.tokens[scenario.caller])
			// The credential is configured and authenticates successfully. A
			// removed route grant must produce 403, not an unknown-token 401.
			if caller, err := f.security.Authentication.Authorize(r, []string{scenario.caller}); err != nil || caller != scenario.caller {
				t.Fatalf("fixture workload did not authenticate: %v", err)
			}
			token := f.sign(map[string]any{"org_role": "member", "aud": []string{"agent-ui", "agent-acp-service", "agent-controller"}})
			if scenario.context == "forged" {
				token = "forged"
			}
			if scenario.context != "missing" {
				r.Header.Set(callercontext.Header, token)
			}
			if scenario.duplicate {
				r.Header.Add(callercontext.Header, token)
			}
			r.Header.Set("X-Antnest-Organization-ID", "forged-organization")
			r.Header.Set("X-Antnest-Principal-ID", "forged-principal")
			w := httptest.NewRecorder()
			f.raw.ServeHTTP(w, r)
			if w.Code != scenario.status {
				t.Errorf("status=%d, want=%d", w.Code, scenario.status)
			}
			if scenario.code != "" {
				var payload errorResponse
				retryable := scenario.keyUnavailable && scenario.caller == "agent-ui"
				if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil || payload.Code != scenario.code || payload.Retryable != retryable {
					t.Errorf("error code/retryability did not match %s", scenario.code)
				}
			}
			if scenario.caller == "edge-gateway" && keyCalls.Load() != 0 {
				t.Error("retired Gateway reached Identity keys")
			}
			if scenario.caller == "agent-ui" && scenario.status == 200 {
				if keyCalls.Load() != 1 || queries.calls != 1 || queries.workspaceInput != (application.ListWorkspaceAgentsInput{
					RequestID: "retirement-1", OrganizationID: "org-1", PrincipalID: "user-admin",
				}) || w.Header().Get("Cache-Control") != "no-store" {
					t.Error("Agent UI lost signed scope, real verification, single query or no-store")
				}
			} else if queries.calls != 0 {
				t.Error("rejected caller or health probe reached workspace query")
			}
		})
	}
}

func TestControllerCallerCatalogRetiresGateway(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join(repositoryRoot(t), "contracts/agent-controller/callers.json"))
	if err != nil {
		t.Fatal(err)
	}
	var catalog struct {
		Routes map[string]struct {
			Callers       []string          `json:"callers"`
			CallerContext map[string]string `json:"caller_context"`
		} `json:"routes"`
	}
	if err := json.Unmarshal(raw, &catalog); err != nil {
		t.Fatal(err)
	}
	for pattern, route := range catalog.Routes {
		if _, exists := route.CallerContext["edge-gateway"]; exists || slices.Contains(route.Callers, "edge-gateway") {
			t.Errorf("retired Gateway still allowed by %s", pattern)
		}
	}
	reader := catalog.Routes["POST /rpc/agent-controller/list-workspace-agents"]
	if !slices.Equal(reader.Callers, []string{"agent-ui"}) || reader.CallerContext["agent-ui"] != "required" {
		t.Error("workspace reader must retain Agent UI and required CCT")
	}
}
