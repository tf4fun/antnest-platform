package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/callercontext"
	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
)

type authenticationFailureEvidence struct {
	status    int
	retryable bool
	body      []byte
}

// Exercise the actual HTTP boundary for every new public error. The contract
// gate requires executable evidence rather than merely enumerating constants.
func authenticationErrorEvidence(t *testing.T) map[string]authenticationFailureEvidence {
	t.Helper()
	results := map[string]authenticationFailureEvidence{}
	for _, code := range []string{"service_unauthenticated", "caller_not_allowed", "caller_context_required", "caller_context_invalid", "identity_dependency_unavailable", "organization_mismatch", "actor_mismatch", "forbidden", "unsupported_media_type", "request_too_large"} {
		f := newAuthenticationFixture(t)
		if code == "identity_dependency_unavailable" {
			verifier, err := callercontext.NewVerifier("http://identity.fixture", &http.Client{Transport: fixtureTransport(func(*http.Request) (*http.Response, error) {
				return &http.Response{StatusCode: 503, Body: io.NopCloser(bytes.NewReader(nil))}, nil
			})}, time.Second)
			if err != nil {
				t.Fatal(err)
			}
			f.security.CallerContext = verifier
		}
		var err error
		f.raw, err = NewHandler(&catalogServiceStub{}, &lifecycleServiceStub{}, &agentConfigurationServiceStub{}, &agentQueryServiceStub{}, &agentEventServiceStub{}, &networkPolicyServiceStub{}, func(context.Context) error { return nil }, f.security)
		if err != nil {
			t.Fatal(err)
		}
		method, path, body := "GET", "/internal/agents?organization_id=org-1", ""
		if code == "organization_mismatch" {
			path = "/internal/agents?organization_id=other"
		}
		if code == "actor_mismatch" || code == "unsupported_media_type" || code == "request_too_large" {
			method, path, body = "POST", "/internal/agents", `{"actor_principal_id":"other"}`
		}
		if code == "request_too_large" {
			body = strings.Repeat(" ", maximumRequestBytes+1)
		}
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set(serviceauth.Header, "Bearer "+f.tokens["admin-console"])
		claims := map[string]any{}
		if code == "forbidden" {
			claims["org_role"] = "member"
		}
		r.Header.Set(callercontext.Header, f.sign(claims))
		switch code {
		case "service_unauthenticated":
			r.Header.Del(serviceauth.Header)
		case "caller_not_allowed":
			r.Header.Set(serviceauth.Header, "Bearer "+f.tokens["agent-ui"])
		case "caller_context_required":
			r.Header.Del(callercontext.Header)
		case "caller_context_invalid":
			r.Header.Set(callercontext.Header, "forged")
		case "unsupported_media_type":
			r.Header.Set("Content-Type", "text/plain")
		}
		w := httptest.NewRecorder()
		f.raw.ServeHTTP(w, r)
		var payload errorResponse
		if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil {
			t.Fatal(err)
		}
		if payload.Code != code {
			t.Fatalf("expected %s, received %s (%d)", code, payload.Code, w.Code)
		}
		results[code] = authenticationFailureEvidence{status: w.Code, retryable: payload.Retryable, body: w.Body.Bytes()}
	}
	return results
}

func TestControllerForgedHintsCannotReachBusiness(t *testing.T) {
	queries := &agentQueryServiceStub{}
	boundary, err := newBusinessHandler(t, &catalogServiceStub{}, &lifecycleServiceStub{}, &agentConfigurationServiceStub{}, queries,
		&agentEventServiceStub{}, &networkPolicyServiceStub{}, func(context.Context) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "/internal/agents?organization_id=org-1", nil)
	request.Header.Set("X-Antnest-Organization-ID", "org-1")
	request.Header.Set("X-Antnest-Principal-ID", "admin-forged")
	request.Header.Set("X-Antnest-System-Role", "admin")
	response := httptest.NewRecorder()
	boundary.(*businessFixture).raw.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized || !strings.Contains(response.Body.String(), "service_unauthenticated") {
		t.Fatalf("unverified request reached business: status=%d", response.Code)
	}
	if queries.listCalls != 0 {
		t.Fatal("unverified caller reached query service")
	}
}

func TestControllerEveryCatalogRouteDeniesForeignWorkloads(t *testing.T) {
	root := repositoryRoot(t)
	raw, err := os.ReadFile(filepath.Join(root, "contracts/agent-controller/callers.json"))
	if err != nil {
		t.Fatal(err)
	}
	var catalog struct {
		Routes map[string]struct {
			Callers        []string `json:"callers"`
			Authentication string   `json:"authentication"`
		} `json:"routes"`
	}
	if err := json.Unmarshal(raw, &catalog); err != nil {
		t.Fatal(err)
	}
	f := newAuthenticationFixture(t)
	base, err := NewHandler(&catalogServiceStub{}, &lifecycleServiceStub{}, &agentConfigurationServiceStub{}, &agentQueryServiceStub{},
		&agentEventServiceStub{}, &networkPolicyServiceStub{}, func(context.Context) error { return nil }, f.security)
	if err != nil {
		t.Fatal(err)
	}
	f.raw, err = WithSkillLearningPolicyRoutes(base, &learningPolicyServiceStub{}, f.security)
	if err != nil {
		t.Fatal(err)
	}
	for pattern, policy := range catalog.Routes {
		if policy.Authentication != "workload" {
			continue
		}
		method, path, _ := strings.Cut(pattern, " ")
		path = strings.NewReplacer("{agent_id}", "agent-1", "{request_id}", "request-1", "{template_id}", "template-1", "{model_profile_id}", "model-1", "{connection_id}", "provider-1", "{revision}", "1").Replace(path)
		for _, caller := range append([]string{""}, serviceauth.Services...) {
			if slices.Contains(policy.Callers, caller) || caller == "agent-controller" {
				continue
			}
			t.Run(pattern+"/"+caller, func(t *testing.T) {
				r := httptest.NewRequest(method, path, strings.NewReader("{}"))
				r.Header.Set("Content-Type", "application/json")
				if caller != "" {
					r.Header.Set(serviceauth.Header, "Bearer "+f.tokens[caller])
				}
				w := httptest.NewRecorder()
				f.raw.ServeHTTP(w, r)
				want := 403
				if caller == "" {
					want = 401
				}
				if w.Code != want {
					t.Fatalf("caller %s: status=%d", caller, w.Code)
				}
			})
		}
	}
}

func TestControllerVerifiesSignedAuthorityBeforeEffects(t *testing.T) {
	for _, scenario := range []struct {
		name, path, body string
		status           int
		claims           map[string]any
		duplicate        bool
	}{
		{name: "signed subject and organization", path: "/internal/agents?organization_id=org-1", status: 200},
		{name: "foreign organization", path: "/internal/agents?organization_id=org-2", status: 403},
		{name: "padded organization query", path: "/internal/agents?organization_id=%20org-1", status: 400},
		{name: "padded actor body", path: "/internal/agents", body: `{"organization_id":"org-1","actor_principal_id":"user-admin "}`, status: 400},
		{name: "foreign audience", path: "/internal/agents?organization_id=org-1", status: 401, claims: map[string]any{"aud": []string{"admin-console"}}},
		{name: "expired", path: "/internal/agents?organization_id=org-1", status: 401, claims: map[string]any{"iat": time.Now().Unix() - 91, "exp": time.Now().Unix() - 31}},
		{name: "signed non administrator", path: "/internal/agents?organization_id=org-1", status: 403, claims: map[string]any{"org_role": "member"}},
		{name: "foreign Agent", path: "/internal/agents/agent-1?organization_id=org-1", status: 401, claims: map[string]any{"agt": "agent-2"}},
		{name: "unscoped Agent", path: "/internal/agents/agent-1?organization_id=org-1", status: 401},
		{name: "duplicated context", path: "/internal/agents?organization_id=org-1", status: 401, duplicate: true},
		{name: "forged actor", path: "/internal/agents", body: `{"organization_id":"org-1","actor_principal_id":"forged"}`, status: 403},
		{name: "forged organization body", path: "/internal/agents", body: `{"organization_id":"org-2","actor_principal_id":"user-admin"}`, status: 403},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			queries := &agentQueryServiceStub{}
			boundary, err := newBusinessHandler(t, &catalogServiceStub{}, &lifecycleServiceStub{}, &agentConfigurationServiceStub{}, queries, &agentEventServiceStub{}, &networkPolicyServiceStub{}, func(context.Context) error { return nil })
			if err != nil {
				t.Fatal(err)
			}
			f := boundary.(*businessFixture)
			method := "GET"
			if scenario.body != "" {
				method = "POST"
			}
			r := httptest.NewRequest(method, scenario.path, strings.NewReader(scenario.body))
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set(serviceauth.Header, "Bearer "+f.tokens["admin-console"])
			r.Header.Set(callercontext.Header, f.sign(scenario.claims))
			if scenario.duplicate {
				r.Header.Add(callercontext.Header, f.sign(scenario.claims))
			}
			r.Header.Set("X-Antnest-Organization-ID", "org-evil")
			r.Header.Set("X-Antnest-System-Role", "admin")
			r.Header.Set("Cookie", "secret-cookie")
			w := httptest.NewRecorder()
			f.raw.ServeHTTP(w, r)
			if w.Code != scenario.status {
				t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
			}
			if scenario.status != 200 && queries.listCalls != 0 {
				t.Fatal("rejected delegation reached query")
			}
			if scenario.status == 200 && (queries.listCalls != 1 || queries.listInput.OrganizationID != "org-1") {
				t.Fatal("raw hints replaced signed scope")
			}
			if strings.Contains(w.Body.String(), "secret-cookie") || strings.Contains(w.Body.String(), r.Header.Get(callercontext.Header)) {
				t.Fatal("browser-safe result leaked credentials")
			}
		})
	}
}

func TestControllerAmbiguousJSONCannotReachBusiness(t *testing.T) {
	for _, scenario := range []struct {
		name, media, body, encoding string
		status                      int
		duplicate                   bool
	}{
		{"simple browser media", "text/plain", "{}", "", 415, false},
		{"foreign charset", "application/json; charset=latin1", "{}", "", 415, false},
		{"duplicate media", "application/json", "{}", "", 415, true},
		{"compressed body", "application/json", "{}", "gzip", 415, false},
		{"duplicate decoded key", "application/json", `{"organization_id":"org-1","\u006frganization_id":"other"}`, "", 400, false},
		{"case alias", "application/json", `{"organization_id":"org-1","Organization_ID":"other"}`, "", 400, false},
		{"invalid UTF8", "application/json", "{\"value\":\"\xff\"}", "", 400, false},
		{"BOM", "application/json", "\xef\xbb\xbf{}", "", 400, false},
		{"multiple documents", "application/json", "{} {}", "", 400, false},
		{"oversize", "application/json", strings.Repeat(" ", maximumRequestBytes+1), "", 413, false},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			queries := &agentQueryServiceStub{}
			boundary, err := newBusinessHandler(t, &catalogServiceStub{}, &lifecycleServiceStub{}, &agentConfigurationServiceStub{}, queries, &agentEventServiceStub{}, &networkPolicyServiceStub{}, func(context.Context) error { return nil })
			if err != nil {
				t.Fatal(err)
			}
			f := boundary.(*businessFixture)
			r := httptest.NewRequest("POST", "/internal/agents", strings.NewReader(scenario.body))
			r.Header.Set(serviceauth.Header, "Bearer "+f.tokens["admin-console"])
			r.Header.Set(callercontext.Header, f.sign(nil))
			r.Header.Set("Content-Type", scenario.media)
			if scenario.duplicate {
				r.Header.Add("Content-Type", scenario.media)
			}
			if scenario.encoding != "" {
				r.Header.Set("Content-Encoding", scenario.encoding)
			}
			w := httptest.NewRecorder()
			f.raw.ServeHTTP(w, r)
			if w.Code != scenario.status {
				t.Fatalf("status=%d", w.Code)
			}
			if queries.listCalls != 0 {
				t.Fatal("rejected JSON reached business")
			}
		})
	}
}

func TestControllerConstructorRequiresAuthentication(t *testing.T) {
	if _, err := NewHandler(&catalogServiceStub{}, &lifecycleServiceStub{}, &agentConfigurationServiceStub{}, &agentQueryServiceStub{}, &agentEventServiceStub{}, &networkPolicyServiceStub{}, func(context.Context) error { return nil }); err == nil {
		t.Fatal("unauthenticated constructor accepted")
	}
}

func TestControllerHealthIsMinimalAndRequiresNoUserContext(t *testing.T) {
	boundary, err := newBusinessHandler(t, &catalogServiceStub{}, &lifecycleServiceStub{}, &agentConfigurationServiceStub{}, &agentQueryServiceStub{}, &agentEventServiceStub{}, &networkPolicyServiceStub{}, func(context.Context) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	f := boundary.(*businessFixture)
	for _, path := range []string{"/status", "/rpc/agent-controller/status"} {
		r := httptest.NewRequest("GET", path, nil)
		w := httptest.NewRecorder()
		f.raw.ServeHTTP(w, r)
		if w.Code != 200 {
			t.Fatalf("health status=%d", w.Code)
		}
		var value map[string]any
		decoder := json.NewDecoder(w.Body)
		if decoder.Decode(&value) != nil || decoder.Decode(&struct{}{}) != io.EOF || len(value) != 1 || value["status"] != "ready" {
			t.Fatal("health exposed control data")
		}
	}
}
