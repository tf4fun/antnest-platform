package server

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/callercontext"
	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
	"github.com/tf4fun/antnest-platform/services/admin-console/internal/principal"
	"github.com/tf4fun/antnest-platform/services/admin-console/internal/upstream"
)

const modelCallPolicyPath = "/api/admin/model-call-policy"

const modelCallPolicyBody = `{"expected_revision":0,"unknown_cost":"deny","run_caps":{"max_input_tokens":1000,"max_cost_usd_micros":50},"daily":{"soft_cost_usd_micros":40,"hard_cost_usd_micros":60},"monthly":{},"expected_principal":["org-1","user-admin"]}`

func modelCallPolicyUpstreamPolicy(org string, revision int64) string {
	return fmt.Sprintf(`{"organization_id":%q,"revision":%d,"unknown_cost":"deny","run_caps":{"max_input_tokens":1000,"max_cost_usd_micros":50,"secret":"private"},"daily":{"soft_cost_usd_micros":40,"hard_cost_usd_micros":60},"monthly":{},"private_field":"hidden"}`, org, revision)
}

func modelCallPolicyRequest(method, path, body, org string) *http.Request {
	request := scopedLifecycleRequest(method, path, body, org)
	request.Header.Set("Idempotency-Key", "policy-request-1")
	return request
}

func TestModelCallPolicyGETForwardsSignedScopeAndStripsOrganization(t *testing.T) {
	backend := newBackendStub()
	backend.enqueue(http.StatusOK, modelCallPolicyUpstreamPolicy("org-1", 3))
	response := httptest.NewRecorder()
	newTestHandler(t, backend).ServeHTTP(response, modelCallPolicyRequest(http.MethodGet, modelCallPolicyPath, "", "org-1"))
	if response.Code != http.StatusOK || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var value map[string]any
	decodeBytes(t, response.Body.Bytes(), &value)
	want := map[string]any{"revision": float64(3), "unknown_cost": "deny",
		"run_caps": map[string]any{"max_input_tokens": float64(1000), "max_cost_usd_micros": float64(50)},
		"daily":    map[string]any{"soft_cost_usd_micros": float64(40), "hard_cost_usd_micros": float64(60)},
		"monthly":  map[string]any{}}
	if len(value) != 5 {
		t.Fatalf("projection leaked fields: %v", value)
	}
	for key := range want {
		if _, ok := value[key]; !ok {
			t.Fatalf("missing projected field %s in %v", key, value)
		}
	}
	if _, leaked := value["organization_id"]; leaked {
		t.Fatalf("organization leaked: %v", value)
	}
	if len(backend.calls) != 1 {
		t.Fatalf("calls=%v", backend.calls)
	}
	call := backend.calls[0]
	query, _ := url.ParseQuery(call.Query)
	if call.Target != upstream.AgentController || call.Method != http.MethodGet ||
		call.Path != "/internal/model-call-policy" || query.Get("organization_id") != "org-1" || len(query) != 1 || len(call.Body) != 0 {
		t.Fatalf("call=%+v", call)
	}
}

func TestModelCallPolicyGETRejectsQueryAndBody(t *testing.T) {
	for _, request := range []*http.Request{
		modelCallPolicyRequest(http.MethodGet, modelCallPolicyPath+"?organization_id=org-1", "", "org-1"),
		modelCallPolicyRequest(http.MethodGet, modelCallPolicyPath+"?organization_id=org-1&organization_id=org-1", "", "org-1"),
		modelCallPolicyRequest(http.MethodGet, modelCallPolicyPath, `{"x":1}`, "org-1"),
	} {
		backend := newBackendStub()
		response := httptest.NewRecorder()
		newTestHandler(t, backend).ServeHTTP(response, request)
		if response.Code != http.StatusBadRequest || len(backend.calls) != 0 {
			t.Fatalf("status=%d calls=%d url=%s", response.Code, len(backend.calls), request.URL)
		}
	}
}

func TestModelCallPolicyGETRejectsMalformedOrForeignUpstream(t *testing.T) {
	for _, body := range []string{
		modelCallPolicyUpstreamPolicy("other-org", 3),
		`{"organization_id":"org-1","revision":3,"unknown_cost":"deny","run_caps":{},"daily":{},"monthly":null}`,
		`{"organization_id":"org-1","revision":9007199254740992,"unknown_cost":"deny","run_caps":{},"daily":{},"monthly":{}}`,
		`{"organization_id":"org-1","revision":3,"unknown_cost":"warn","run_caps":{},"daily":{},"monthly":{}}`,
		`{"organization_id":"org-1","revision":3,"unknown_cost":"deny","run_caps":{"max_input_tokens":-1},"daily":{},"monthly":{}}`,
		`{"organization_id":"org-1","revision":3,"unknown_cost":"deny","run_caps":{},"daily":{"soft_cost_usd_micros":61,"hard_cost_usd_micros":60},"monthly":{}}`,
		`not json`,
	} {
		backend := newBackendStub()
		backend.enqueue(http.StatusOK, body)
		response := httptest.NewRecorder()
		newTestHandler(t, backend).ServeHTTP(response, modelCallPolicyRequest(http.MethodGet, modelCallPolicyPath, "", "org-1"))
		if response.Code != http.StatusBadGateway {
			t.Fatalf("body=%q status=%d", body, response.Code)
		}
	}
}

func TestModelCallPolicyPUTForwardsSignedCompleteReplacement(t *testing.T) {
	backend := newBackendStub()
	backend.enqueue(http.StatusOK, modelCallPolicyUpstreamPolicy("org-1", 1))
	response := httptest.NewRecorder()
	newTestHandler(t, backend).ServeHTTP(response, modelCallPolicyRequest(http.MethodPut, modelCallPolicyPath, modelCallPolicyBody, "org-1"))
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var value map[string]any
	decodeBytes(t, response.Body.Bytes(), &value)
	if _, leaked := value["organization_id"]; leaked || len(value) != 5 {
		t.Fatalf("response leaked organization: %v", value)
	}
	if len(backend.calls) != 1 {
		t.Fatalf("calls=%v", backend.calls)
	}
	call := backend.calls[0]
	var sent map[string]any
	decodeBytes(t, call.Body, &sent)
	if call.Target != upstream.AgentController || call.Method != http.MethodPut || call.Path != "/internal/model-call-policy" || call.Query != "" {
		t.Fatalf("call=%+v", call)
	}
	if sent["organization_id"] != "org-1" || sent["actor_principal_id"] != "user-admin" || sent["unknown_cost"] != "deny" {
		t.Fatalf("forwarded=%v", sent)
	}
	if sent["expected_revision"] != float64(0) {
		t.Fatalf("expected revision: %v", sent)
	}
	requestID, _ := sent["request_id"].(string)
	if !strings.HasPrefix(requestID, "model-policy-") || len(requestID) != len("model-policy-")+64 {
		t.Fatalf("request_id=%q", requestID)
	}
}

func TestModelCallPolicyPUTRejectsStaleExpectedPrincipal(t *testing.T) {
	for _, body := range []string{
		`{"expected_revision":0,"unknown_cost":"deny","run_caps":{},"daily":{},"monthly":{},"expected_principal":["other-org","user-admin"]}`,
		`{"expected_revision":0,"unknown_cost":"deny","run_caps":{},"daily":{},"monthly":{},"expected_principal":["org-1","other-user"]}`,
	} {
		backend := newBackendStub()
		response := httptest.NewRecorder()
		newTestHandler(t, backend).ServeHTTP(response, modelCallPolicyRequest(http.MethodPut, modelCallPolicyPath, body, "org-1"))
		if response.Code != http.StatusConflict || len(backend.calls) != 0 ||
			!strings.Contains(response.Body.String(), "principal_changed") {
			t.Fatalf("body=%s status=%d calls=%d out=%s", body, response.Code, len(backend.calls), response.Body.String())
		}
	}
}

func TestModelCallPolicyPUTRejectsMalformedBodies(t *testing.T) {
	for _, body := range []string{
		`{"unknown_cost":"deny","run_caps":{},"daily":{},"monthly":{},"expected_principal":["org-1","user-admin"]}`,
		`{"expected_revision":null,"unknown_cost":"deny","run_caps":{},"daily":{},"monthly":{},"expected_principal":["org-1","user-admin"]}`,
		`{"expected_revision":-1,"unknown_cost":"deny","run_caps":{},"daily":{},"monthly":{},"expected_principal":["org-1","user-admin"]}`,
		`{"expected_revision":0,"unknown_cost":null,"run_caps":{},"daily":{},"monthly":{},"expected_principal":["org-1","user-admin"]}`,
		`{"expected_revision":0,"unknown_cost":"warn","run_caps":{},"daily":{},"monthly":{},"expected_principal":["org-1","user-admin"]}`,
		`{"expected_revision":0,"unknown_cost":"deny","run_caps":null,"daily":{},"monthly":{},"expected_principal":["org-1","user-admin"]}`,
		`{"expected_revision":0,"unknown_cost":"deny","run_caps":{"max_input_tokens":9007199254740992},"daily":{},"monthly":{},"expected_principal":["org-1","user-admin"]}`,
		`{"expected_revision":0,"unknown_cost":"deny","run_caps":{"max_input_tokens":1.5},"daily":{},"monthly":{},"expected_principal":["org-1","user-admin"]}`,
		`{"expected_revision":0,"unknown_cost":"deny","run_caps":{},"daily":{"soft_cost_usd_micros":61,"hard_cost_usd_micros":60},"monthly":{},"expected_principal":["org-1","user-admin"]}`,
		`{"expected_revision":0,"unknown_cost":"deny","run_caps":{},"daily":{},"monthly":{"soft_cost_usd_micros":11,"hard_cost_usd_micros":10},"expected_principal":["org-1","user-admin"]}`,
		`{"expected_revision":0,"unknown_cost":"deny","run_caps":{"bogus":1},"daily":{},"monthly":{},"expected_principal":["org-1","user-admin"]}`,
		`{"expected_revision":0,"unknown_cost":"deny","run_caps":{},"daily":{},"monthly":{},"expected_principal":["org-1","user-admin"],"bogus":1}`,
		`{"expected_revision":0,"unknown_cost":"deny","run_caps":{},"daily":{},"monthly":{},"expected_principal":["org-1","user-admin"],"unknown_cost":"allow"}`,
		`{"expected_revision":0,"unknown_cost":"deny","run_caps":{},"daily":{},"monthly":{},"expected_principal":["org-1","user-admin"],"Unknown_Cost":"deny"}`,
		`{"expected_revision":0,"unknown_cost":"deny","run_caps":{},"daily":{},"monthly":{},"expected_principal":[]}`,
		`{"expected_revision":0,"unknown_cost":"deny","run_caps":{},"daily":{},"monthly":{},"expected_principal":["org-1"]}`,
		`{"expected_revision":0,"unknown_cost":"deny","run_caps":{},"daily":{},"monthly":{},"expected_principal":["org-1","user-admin","extra"]}`,
		`{"expected_revision":0,"unknown_cost":"deny","run_caps":{},"daily":{},"monthly":{},"expected_principal":null}`,
		`{"expected_revision":0,"unknown_cost":"deny","run_caps":{},"daily":{},"monthly":{},"expected_principal":["org-1",null]}`,
		`{"expected_revision":0,"unknown_cost":"deny","run_caps":{},"daily":{},"monthly":{},"expected_principal":["","user-admin"]}`,
	} {
		backend := newBackendStub()
		response := httptest.NewRecorder()
		newTestHandler(t, backend).ServeHTTP(response, modelCallPolicyRequest(http.MethodPut, modelCallPolicyPath, body, "org-1"))
		if response.Code != http.StatusBadRequest || len(backend.calls) != 0 {
			t.Fatalf("body=%s status=%d calls=%d", body, response.Code, len(backend.calls))
		}
	}
}

func TestModelCallPolicyPUTRejectsMismatchedAck(t *testing.T) {
	for _, body := range []string{
		modelCallPolicyUpstreamPolicy("other-org", 1),
		modelCallPolicyUpstreamPolicy("org-1", 2),
		`{"organization_id":"org-1","revision":1,"unknown_cost":"allow","run_caps":{"max_input_tokens":1000,"max_cost_usd_micros":50},"daily":{"soft_cost_usd_micros":40,"hard_cost_usd_micros":60},"monthly":{}}`,
		`{"organization_id":"org-1","revision":1,"unknown_cost":"deny","run_caps":{"max_input_tokens":1000},"daily":{"soft_cost_usd_micros":40,"hard_cost_usd_micros":60},"monthly":{}}`,
	} {
		backend := newBackendStub()
		backend.enqueue(http.StatusOK, body)
		response := httptest.NewRecorder()
		newTestHandler(t, backend).ServeHTTP(response, modelCallPolicyRequest(http.MethodPut, modelCallPolicyPath, modelCallPolicyBody, "org-1"))
		if response.Code != http.StatusBadGateway {
			t.Fatalf("ack=%s status=%d", body, response.Code)
		}
	}
}

func TestModelCallPolicyPUTRelaysSafeConflictsAndSanitizesOthers(t *testing.T) {
	for _, scenario := range []struct {
		status   int
		body     string
		wantCode string
		want     int
	}{
		{409, `{"code":"resource_version_conflict","detail":"private"}`, "resource_version_conflict", 409},
		{409, `{"code":"request_id_conflict"}`, "request_id_conflict", 409},
		{409, `{"code":"execution_configuration_capacity_exceeded"}`, "execution_configuration_capacity_exceeded", 409},
		{403, `{"code":"forbidden","actor_key":"secret"}`, "forbidden", 403},
		{403, `{"code":"caller_not_allowed"}`, "caller_not_allowed", 403},
		{401, `{"code":"service_unauthenticated"}`, "service_unauthenticated", 401},
		{401, `{"code":"caller_context_invalid"}`, "caller_context_invalid", 401},
		{400, `{"code":"invalid_request","raw":"body"}`, "invalid_request", 400},
		{503, `{"code":"dependency_unavailable"}`, "dependency_unavailable", 503},
		{503, `{"code":"identity_dependency_unavailable"}`, "identity_dependency_unavailable", 503},
		{500, `{"code":"internal_error","dump":"heap"}`, "internal_error", 500},
		{403, `{"code":"service_unauthenticated"}`, "upstream_error", 502},
		{401, `{"code":"forbidden"}`, "upstream_error", 502},
		{500, `{"code":"private_internal","dump":"heap"}`, "upstream_error", 502},
		{201, `{"revision":2}`, "upstream_error", 502},
	} {
		backend := newBackendStub()
		backend.enqueue(scenario.status, scenario.body)
		response := httptest.NewRecorder()
		newTestHandler(t, backend).ServeHTTP(response, modelCallPolicyRequest(http.MethodPut, modelCallPolicyPath, modelCallPolicyBody, "org-1"))
		if response.Code != scenario.want || !strings.Contains(response.Body.String(), scenario.wantCode) {
			t.Fatalf("scenario=%v status=%d body=%s", scenario, response.Code, response.Body.String())
		}
		if strings.Contains(response.Body.String(), "private") || strings.Contains(response.Body.String(), "secret") || strings.Contains(response.Body.String(), "heap") {
			t.Fatalf("upstream private body relayed: %s", response.Body.String())
		}
	}
}

func TestModelCallPolicyStrictUpstreamMembers(t *testing.T) {
	for _, body := range []string{
		`{"organization_id":"org-1","revision":3,"unknown_cost":"deny","run_caps":{"max_input_tokens":null},"daily":{},"monthly":{}}`,
		`{"organization_id":"org-1","revision":3,"unknown_cost":"deny","run_caps":{"Max_Input_Tokens":5},"daily":{},"monthly":{}}`,
		`{"organization_id":"org-1","revision":3,"unknown_cost":"deny","run_caps":{"max_input_tokens":"5"},"daily":{},"monthly":{}}`,
		`{"organization_id":"org-1","revision":3,"unknown_cost":"deny","run_caps":{"max_input_tokens":-1},"daily":{},"monthly":{}}`,
		`{"organization_id":"org-1","revision":3,"unknown_cost":"deny","run_caps":{},"daily":{"Soft_Cost_USD_Micros":5},"monthly":{}}`,
		`{"organization_id":"org-1","revision":3,"unknown_cost":"deny","run_caps":{},"daily":{"soft_cost_usd_micros":null},"monthly":{}}`,
		`{"organization_id":"org-1","Revision":3,"unknown_cost":"deny","run_caps":{},"daily":{},"monthly":{}}`,
		`{"organization_id":"org-1","revision":3,"unknown_cost":"deny","Run_Caps":{},"daily":{},"monthly":{}}`,
		`{"organization_id":"org-1","revision":0,"unknown_cost":"deny","run_caps":{},"daily":{},"monthly":{}}`,
		`{"organization_id":"org-1","revision":0,"unknown_cost":"allow","run_caps":{"max_input_tokens":5},"daily":{},"monthly":{}}`,
		`{"organization_id":"org-1","revision":0,"unknown_cost":"allow","run_caps":{},"daily":{"hard_cost_usd_micros":5},"monthly":{}}`,
	} {
		backend := newBackendStub()
		backend.enqueue(http.StatusOK, body)
		response := httptest.NewRecorder()
		newTestHandler(t, backend).ServeHTTP(response, modelCallPolicyRequest(http.MethodGet, modelCallPolicyPath, "", "org-1"))
		if response.Code != http.StatusBadGateway {
			t.Fatalf("body=%s status=%d out=%s", body, response.Code, response.Body.String())
		}
	}
}

func TestModelCallPolicyGETAcceptsValidDefaultAndStripsPrivate(t *testing.T) {
	for _, body := range []string{
		`{"organization_id":"org-1","revision":0,"unknown_cost":"allow","run_caps":{},"daily":{},"monthly":{}}`,
		modelCallPolicyUpstreamPolicy("org-1", 3),
	} {
		backend := newBackendStub()
		backend.enqueue(http.StatusOK, body)
		response := httptest.NewRecorder()
		newTestHandler(t, backend).ServeHTTP(response, modelCallPolicyRequest(http.MethodGet, modelCallPolicyPath, "", "org-1"))
		if response.Code != http.StatusOK {
			t.Fatalf("body=%s status=%d out=%s", body, response.Code, response.Body.String())
		}
	}
}

func TestModelCallPolicyGETUsesSafeFailureMapping(t *testing.T) {
	for _, scenario := range []struct {
		status int
		body   string
		want   int
		code   string
	}{
		{409, `{"code":"resource_version_conflict","detail":"private"}`, 409, "resource_version_conflict"},
		{403, `{"code":"forbidden","member":"secret"}`, 403, "forbidden"},
		{503, `{"code":"dependency_unavailable"}`, 503, "dependency_unavailable"},
		{201, `{"revision":1}`, 502, "upstream_error"},
		{500, `{"code":"private","trace":"x"}`, 502, "upstream_error"},
	} {
		backend := newBackendStub()
		backend.enqueue(scenario.status, scenario.body)
		response := httptest.NewRecorder()
		newTestHandler(t, backend).ServeHTTP(response, modelCallPolicyRequest(http.MethodGet, modelCallPolicyPath, "", "org-1"))
		if response.Code != scenario.want || !strings.Contains(response.Body.String(), scenario.code) {
			t.Fatalf("scenario=%v status=%d body=%s", scenario, response.Code, response.Body.String())
		}
		if response.Header().Get("Cache-Control") != "no-store" ||
			strings.Contains(response.Body.String(), "private") || strings.Contains(response.Body.String(), "secret") {
			t.Fatalf("unsafe failure relay: %v %s", response.Header(), response.Body.String())
		}
	}
}

func TestModelCallPolicyPUTRejectsDuplicateIdempotencyKeys(t *testing.T) {
	backend := newBackendStub()
	request := modelCallPolicyRequest(http.MethodPut, modelCallPolicyPath, modelCallPolicyBody, "org-1")
	request.Header.Add("Idempotency-Key", "policy-request-2")
	response := httptest.NewRecorder()
	newTestHandler(t, backend).ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest || len(backend.calls) != 0 {
		t.Fatalf("status=%d calls=%d body=%s", response.Code, len(backend.calls), response.Body.String())
	}
}

func TestModelCallPolicyPUTRejectsNon200Success(t *testing.T) {
	backend := newBackendStub()
	backend.enqueue(http.StatusCreated, modelCallPolicyUpstreamPolicy("org-1", 1))
	response := httptest.NewRecorder()
	newTestHandler(t, backend).ServeHTTP(response, modelCallPolicyRequest(http.MethodPut, modelCallPolicyPath, modelCallPolicyBody, "org-1"))
	if response.Code != http.StatusBadGateway {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestModelCallPolicyRequiresVerifiedAdministratorContext(t *testing.T) {
	for _, scenario := range []struct {
		name   string
		status int
		apply  func(*businessFixture, *http.Request)
	}{
		{"no credentials", http.StatusUnauthorized, func(_ *businessFixture, _ *http.Request) {}},
		{"workload only", http.StatusUnauthorized, func(f *businessFixture, r *http.Request) {
			r.Header.Set(serviceauth.Header, "Bearer "+f.token)
		}},
		{"forged context", http.StatusUnauthorized, func(f *businessFixture, r *http.Request) {
			r.Header.Set(serviceauth.Header, "Bearer "+f.token)
			signed := f.sign(principal.Principal{UserID: "user-admin", OrganizationID: "org-1",
				MembershipID: "membership-1", SystemRole: "admin", OrganizationRole: "admin"}, "", nil)
			parts := strings.Split(signed, ".")
			parts[1] = "Zm9yZ2VkLWNsYWltcw"
			r.Header.Set(callercontext.Header, strings.Join(parts, "."))
		}},
		{"foreign workload", http.StatusUnauthorized, func(f *businessFixture, r *http.Request) {
			r.Header.Set(serviceauth.Header, "Bearer not-the-registered-workload-token")
			r.Header.Set(callercontext.Header, f.sign(principal.Principal{UserID: "user-admin",
				OrganizationID: "org-1", MembershipID: "membership-1", SystemRole: "admin", OrganizationRole: "admin"}, "", nil))
		}},
		{"expired context", http.StatusUnauthorized, func(f *businessFixture, r *http.Request) {
			r.Header.Set(serviceauth.Header, "Bearer "+f.token)
			r.Header.Set(callercontext.Header, f.sign(principal.Principal{UserID: "user-admin",
				OrganizationID: "org-1", MembershipID: "membership-1", SystemRole: "admin", OrganizationRole: "admin"}, "",
				func(claims map[string]any) {
					claims["exp"] = time.Now().Unix() - 120
					claims["iat"] = time.Now().Unix() - 240
				}))
		}},
		{"member only", http.StatusForbidden, func(f *businessFixture, r *http.Request) {
			r.Header.Set(serviceauth.Header, "Bearer "+f.token)
			r.Header.Set(callercontext.Header, f.sign(principal.Principal{UserID: "member-user",
				OrganizationID: "org-1", MembershipID: "membership-2", SystemRole: "user", OrganizationRole: "member"}, "", nil))
		}},
	} {
		for _, method := range []string{http.MethodGet, http.MethodPut} {
			backend := newBackendStub()
			fixture, ok := newTestHandler(t, backend).(*businessFixture)
			if !ok {
				t.Fatal("fixture type")
			}
			body := ""
			if method == http.MethodPut {
				body = modelCallPolicyBody
			}
			request := httptest.NewRequest(method, modelCallPolicyPath, strings.NewReader(body))
			request.Header.Set("Content-Type", "application/json")
			scenario.apply(fixture, request)
			response := httptest.NewRecorder()
			fixture.handler.ServeHTTP(response, request)
			if response.Code != scenario.status || len(backend.calls) != 0 {
				t.Fatalf("%s %s status=%d want=%d calls=%d body=%s", scenario.name, method, response.Code,
					scenario.status, len(backend.calls), response.Body.String())
			}
		}
	}
}

func TestModelCallPolicyPUTStableRequestIdentity(t *testing.T) {
	backend := newBackendStub()
	backend.enqueue(http.StatusOK, modelCallPolicyUpstreamPolicy("org-1", 1))
	backend.enqueue(http.StatusOK, modelCallPolicyUpstreamPolicy("org-1", 1))
	seen := []string{}
	for index := 0; index < 2; index++ {
		response := httptest.NewRecorder()
		newTestHandler(t, backend).ServeHTTP(response, modelCallPolicyRequest(http.MethodPut, modelCallPolicyPath, modelCallPolicyBody, "org-1"))
		if response.Code != http.StatusOK {
			t.Fatalf("attempt=%d status=%d", index, response.Code)
		}
		var sent map[string]any
		decodeBytes(t, backend.calls[index].Body, &sent)
		seen = append(seen, sent["request_id"].(string))
	}
	if seen[0] != seen[1] {
		t.Fatalf("same Idempotency-Key must derive the same request_id: %v", seen)
	}
	request := modelCallPolicyRequest(http.MethodPut, modelCallPolicyPath, modelCallPolicyBody, "org-1")
	request.Header.Set("Idempotency-Key", "policy-request-2")
	backend.enqueue(http.StatusOK, modelCallPolicyUpstreamPolicy("org-1", 1))
	newTestHandler(t, backend).ServeHTTP(httptest.NewRecorder(), request)
	var third map[string]any
	decodeBytes(t, backend.calls[2].Body, &third)
	if third["request_id"] == seen[0] {
		t.Fatalf("changed key must change request identity: %v", third["request_id"])
	}
}
