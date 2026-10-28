package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"github.com/tf4fun/antnest-platform/modules/service-authentication/callercontext"
	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

const modelCallPolicyPath = "/internal/model-call-policy"
const modelCallPolicyMutation = `{"request_id":"policy-change-1","organization_id":"org-1","actor_principal_id":"user-admin","expected_revision":0,"unknown_cost":"deny","run_caps":{"max_input_tokens":1000},"daily":{"soft_cost_usd_micros":40,"hard_cost_usd_micros":60},"monthly":{}}`

type modelCallPolicyServiceStub struct {
	policy domain.ModelCallPolicy
	err    error
	reads  []string
	writes []application.SetModelCallPolicyInput
}

func (stub *modelCallPolicyServiceStub) Get(_ context.Context, organizationID string) (domain.ModelCallPolicy, error) {
	stub.reads = append(stub.reads, organizationID)
	return stub.policy, stub.err
}

func (stub *modelCallPolicyServiceStub) Set(_ context.Context, input application.SetModelCallPolicyInput) (domain.ModelCallPolicy, error) {
	stub.writes = append(stub.writes, input)
	return stub.policy, stub.err
}

func modelCallPolicyFixture(t *testing.T, stub *modelCallPolicyServiceStub) *businessFixture {
	t.Helper()
	f := newAuthenticationFixture(t)
	var err error
	f.raw, err = WithModelCallPolicyRoutes(http.NotFoundHandler(), stub, f.security)
	require.NoError(t, err)
	return f
}

func modelCallPolicyInput(t *testing.T, overrides map[string]json.RawMessage, omitted ...string) string {
	t.Helper()
	var object map[string]json.RawMessage
	require.NoError(t, json.Unmarshal([]byte(modelCallPolicyMutation), &object))
	for key, value := range overrides {
		object[key] = value
	}
	for _, key := range omitted {
		delete(object, key)
	}
	raw, err := json.Marshal(object)
	require.NoError(t, err)
	return string(raw)
}

func assertModelCallPolicyError(t *testing.T, response *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	require.Equal(t, status, response.Code, response.Body.String())
	var payload errorResponse
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &payload))
	require.Equal(t, code, payload.Code)
	require.False(t, payload.Retryable)
}

func modelCallPolicySnapshot(policy domain.ModelCallPolicy) string {
	encoded, err := json.Marshal(policy)
	if err != nil {
		panic(err)
	}
	return string(encoded)
}

func TestModelCallPolicyHTTPAdministratorsAndWireBoundaries(t *testing.T) {
	for _, authority := range []struct {
		name   string
		claims map[string]any
	}{
		{name: "organization administrator"},
		{name: "system administrator", claims: map[string]any{"sys_role": "admin", "org_role": "member"}},
	} {
		t.Run(authority.name, func(t *testing.T) {
			stub := &modelCallPolicyServiceStub{policy: domain.DefaultModelCallPolicy("org-1")}
			f := modelCallPolicyFixture(t, stub)
			read := httptest.NewRecorder()
			f.raw.ServeHTTP(read, recoveryPolicyRequest(f, http.MethodGet, modelCallPolicyPath+"?organization_id=org-1", "", authority.claims))
			require.Equal(t, http.StatusOK, read.Code, read.Body.String())
			require.Equal(t, "no-store", read.Header().Get("Cache-Control"))
			require.JSONEq(t, modelCallPolicySnapshot(stub.policy), read.Body.String())
			require.Equal(t, []string{"org-1"}, stub.reads)
			require.Empty(t, stub.writes)
			stub.policy.Revision = 1
			write := httptest.NewRecorder()
			f.raw.ServeHTTP(write, recoveryPolicyRequest(f, http.MethodPut, modelCallPolicyPath, modelCallPolicyMutation, authority.claims))
			require.Equal(t, http.StatusOK, write.Code, write.Body.String())
			require.JSONEq(t, modelCallPolicySnapshot(stub.policy), write.Body.String())
			require.Len(t, stub.writes, 1)
			require.Equal(t, "policy-change-1", stub.writes[0].RequestID)
			require.Equal(t, "org-1", stub.writes[0].OrganizationID)
			require.Equal(t, "user-admin", stub.writes[0].ActorPrincipalID)
			require.NotNil(t, stub.writes[0].ExpectedRevision)
			require.EqualValues(t, 0, *stub.writes[0].ExpectedRevision)
			require.Equal(t, "deny", stub.writes[0].UnknownCost)
			require.Equal(t, domain.RunBudget{MaxInputTokens: modelCallPolicyInt64Test(1000)}, *stub.writes[0].RunCaps)
			require.Equal(t, domain.PeriodCaps{SoftCostUSDMicros: modelCallPolicyInt64Test(40), HardCostUSDMicros: modelCallPolicyInt64Test(60)}, *stub.writes[0].Daily)
			require.Equal(t, domain.PeriodCaps{}, *stub.writes[0].Monthly)
		})
	}
}

func modelCallPolicyInt64Test(value int64) *int64 { return &value }

func TestModelCallPolicyHTTPRequiresWorkloadAndCurrentAdministrator(t *testing.T) {
	now := time.Now().Unix()
	for _, method := range []string{http.MethodGet, http.MethodPut} {
		t.Run(method, func(t *testing.T) {
			for _, scenario := range []struct {
				name, code string
				status     int
				claims     map[string]any
				change     func(*businessFixture, *http.Request)
			}{
				{name: "no workload", status: 401, code: "service_unauthenticated", change: func(_ *businessFixture, r *http.Request) { r.Header.Del(serviceauth.Header) }},
				{name: "unrecognized workload token", status: 401, code: "service_unauthenticated", change: func(_ *businessFixture, r *http.Request) {
					r.Header.Set(serviceauth.Header, "Bearer "+strings.Repeat("z", 43))
				}},
				{name: "no CCT despite forged admin hints", status: 401, code: "caller_context_required", change: func(_ *businessFixture, r *http.Request) { r.Header.Del(callercontext.Header) }},
				{name: "forged CCT", status: 401, code: "caller_context_invalid", change: func(_ *businessFixture, r *http.Request) { r.Header.Set(callercontext.Header, "forged-cct") }},
				{name: "duplicate CCT", status: 401, code: "caller_context_invalid", change: func(f *businessFixture, r *http.Request) { r.Header.Add(callercontext.Header, f.sign(nil)) }},
				{name: "expired CCT", status: 401, code: "caller_context_invalid", claims: map[string]any{"iat": now - 180, "exp": now - 120}},
				{name: "wrong audience", status: 401, code: "caller_context_invalid", claims: map[string]any{"aud": []string{"admin-console"}}},
				{name: "non administrator despite forged admin hints", status: 403, code: "forbidden", claims: map[string]any{"sys_role": "user", "org_role": "member"}},
				{name: "cross organization", status: 403, code: "organization_mismatch", claims: map[string]any{"org": "org-2"}},
			} {
				t.Run(scenario.name, func(t *testing.T) {
					stub := &modelCallPolicyServiceStub{}
					f := modelCallPolicyFixture(t, stub)
					target, body := modelCallPolicyPath, modelCallPolicyMutation
					if method == http.MethodGet {
						target, body = modelCallPolicyPath+"?organization_id=org-1", ""
					}
					request := recoveryPolicyRequest(f, method, target, body, scenario.claims)
					if scenario.change != nil {
						scenario.change(f, request)
					}
					response := httptest.NewRecorder()
					f.raw.ServeHTTP(response, request)
					assertModelCallPolicyError(t, response, scenario.status, scenario.code)
					require.Empty(t, stub.reads)
					require.Empty(t, stub.writes)
					for _, credential := range []string{request.Header.Get(serviceauth.Header), request.Header.Get(callercontext.Header), "private-policy-cookie", "private-policy-hint"} {
						if credential != "" {
							require.NotContains(t, response.Body.String(), credential)
						}
					}
				})
			}
			for _, caller := range serviceauth.Services {
				if caller == "admin-console" || caller == "agent-controller" {
					continue
				}
				t.Run("foreign authenticated workload/"+caller, func(t *testing.T) {
					stub := &modelCallPolicyServiceStub{}
					f := modelCallPolicyFixture(t, stub)
					target, body := modelCallPolicyPath, modelCallPolicyMutation
					if method == http.MethodGet {
						target, body = modelCallPolicyPath+"?organization_id=org-1", ""
					}
					request := recoveryPolicyRequest(f, method, target, body, nil)
					request.Header.Set(serviceauth.Header, "Bearer "+f.tokens[caller])
					verified, err := f.security.Authentication.Authorize(request, []string{caller})
					require.NoError(t, err, "the negative must use an actual authenticated foreign workload")
					require.Equal(t, caller, verified)
					response := httptest.NewRecorder()
					f.raw.ServeHTTP(response, request)
					assertModelCallPolicyError(t, response, 403, "caller_not_allowed")
					require.Empty(t, stub.reads)
					require.Empty(t, stub.writes)
				})
			}
		})
	}
	t.Run("PUT actor must be the signed administrator", func(t *testing.T) {
		stub := &modelCallPolicyServiceStub{}
		f := modelCallPolicyFixture(t, stub)
		response := httptest.NewRecorder()
		f.raw.ServeHTTP(response, recoveryPolicyRequest(f, http.MethodPut, modelCallPolicyPath, modelCallPolicyMutation,
			map[string]any{"sub": "another-administrator"}))
		assertModelCallPolicyError(t, response, 403, "actor_mismatch")
		require.Empty(t, stub.reads)
		require.Empty(t, stub.writes)
	})
}

func TestModelCallPolicyHTTPUsesDistinctConflictCodes(t *testing.T) {
	for _, scenario := range []struct {
		name string
		err  error
		code string
	}{
		{name: "stale expected revision", err: ports.ErrConcurrentChange, code: "resource_version_conflict"},
		{name: "reused request identity", err: ports.ErrRequestConflict, code: "request_id_conflict"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			stub := &modelCallPolicyServiceStub{err: scenario.err}
			f := modelCallPolicyFixture(t, stub)
			response := httptest.NewRecorder()
			f.raw.ServeHTTP(response, recoveryPolicyRequest(f, http.MethodPut, modelCallPolicyPath, modelCallPolicyMutation, nil))
			assertModelCallPolicyError(t, response, http.StatusConflict, scenario.code)
			require.Len(t, stub.writes, 1)
			require.Empty(t, stub.reads)
		})
	}
}

func TestModelCallPolicyHTTPReauthenticatesIdenticalMutation(t *testing.T) {
	stub := &modelCallPolicyServiceStub{policy: domain.ModelCallPolicy{OrganizationID: "org-1",
		OrganizationBudget: domain.OrganizationBudget{Revision: 1, UnknownCost: "deny",
			RunCaps: domain.RunBudget{MaxInputTokens: modelCallPolicyInt64Test(1000)},
			Daily:   domain.PeriodCaps{SoftCostUSDMicros: modelCallPolicyInt64Test(40), HardCostUSDMicros: modelCallPolicyInt64Test(60)}}}}
	f := modelCallPolicyFixture(t, stub)
	first := httptest.NewRecorder()
	f.raw.ServeHTTP(first, recoveryPolicyRequest(f, http.MethodPut, modelCallPolicyPath, modelCallPolicyMutation, nil))
	require.Equal(t, http.StatusOK, first.Code, first.Body.String())
	require.Len(t, stub.writes, 1)
	for _, scenario := range []struct {
		name, code string
		status     int
		claims     map[string]any
	}{
		{name: "expired original authority", status: 401, code: "caller_context_invalid", claims: map[string]any{"iat": time.Now().Unix() - 180, "exp": time.Now().Unix() - 120}},
		{name: "administrator role removed", status: 403, code: "forbidden", claims: map[string]any{"org_role": "member", "sys_role": "user"}},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			f.raw.ServeHTTP(response, recoveryPolicyRequest(f, http.MethodPut, modelCallPolicyPath, modelCallPolicyMutation, scenario.claims))
			assertModelCallPolicyError(t, response, scenario.status, scenario.code)
			require.Len(t, stub.writes, 1, "a replay receipt must not bypass current authorization")
			require.Empty(t, stub.reads)
		})
	}
}

func TestModelCallPolicyHTTPStrictGETQueryAndNoBody(t *testing.T) {
	for _, scenario := range []struct {
		name, query, body string
		claims            map[string]any
	}{
		{name: "missing organization"},
		{name: "empty organization", query: "organization_id="},
		{name: "repeated organization", query: "organization_id=org-1&organization_id=org-1"},
		{name: "unknown field", query: "organization_id=org-1&extra=x"},
		{name: "case alias", query: "Organization_ID=org-1"},
		{name: "padded identifier", query: "organization_id=%20org-1"},
		{name: "identifier grammar", query: "organization_id=" + url.QueryEscape("org/1"), claims: map[string]any{"org": "org/1"}},
		{name: "object body", query: "organization_id=org-1", body: "{}"},
		{name: "whitespace body", query: "organization_id=org-1", body: " "},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			stub := &modelCallPolicyServiceStub{}
			f := modelCallPolicyFixture(t, stub)
			response := httptest.NewRecorder()
			f.raw.ServeHTTP(response, recoveryPolicyRequest(f, http.MethodGet, modelCallPolicyPath+"?"+scenario.query, scenario.body, scenario.claims))
			assertModelCallPolicyError(t, response, 400, "invalid_request")
			require.Empty(t, stub.reads)
			require.Empty(t, stub.writes)
		})
	}
}

func TestModelCallPolicyHTTPRequiresAllEightMutationFields(t *testing.T) {
	for _, field := range []string{"request_id", "organization_id", "actor_principal_id", "expected_revision", "unknown_cost", "run_caps", "daily", "monthly"} {
		for _, form := range []string{"missing", "null"} {
			t.Run(field+"/"+form, func(t *testing.T) {
				stub := &modelCallPolicyServiceStub{}
				f := modelCallPolicyFixture(t, stub)
				body := modelCallPolicyInput(t, map[string]json.RawMessage{field: json.RawMessage("null")})
				if form == "missing" {
					body = modelCallPolicyInput(t, nil, field)
				}
				response := httptest.NewRecorder()
				f.raw.ServeHTTP(response, recoveryPolicyRequest(f, http.MethodPut, modelCallPolicyPath, body, nil))
				assertModelCallPolicyError(t, response, 400, "invalid_request")
				require.Empty(t, stub.reads)
				require.Empty(t, stub.writes)
			})
		}
	}
}

func TestModelCallPolicyHTTPRejectsMalformedMutationFields(t *testing.T) {
	for _, field := range []string{
		`"extra":true`,
		`"Organization_ID":"org-1"`,
		`"expected_revision":-1`,
		`"expected_revision":9007199254740992`,
		`"expected_revision":0.5`,
		`"expected_revision":"0"`,
		`"unknown_cost":"warn"`,
		`"unknown_cost":"ALLOW"`,
		`"run_caps":{"max_input_tokens":null}`,
		`"run_caps":{"max_input_tokens":-1}`,
		`"run_caps":{"max_input_tokens":0.5}`,
		`"run_caps":{"max_input_tokens":"10"}`,
		`"run_caps":{"max_input_tokens":9007199254740992}`,
		`"run_caps":{"MAX_INPUT_TOKENS":1}`,
		`"run_caps":{"max_input_tokens":1,"extra":true}`,
		`"daily":{"soft_cost_usd_micros":null}`,
		`"daily":{"soft_cost_usd_micros":-1}`,
		`"daily":{"soft_cost_usd_micros":0.5}`,
		`"daily":{"soft_cost_usd_micros":9007199254740992}`,
		`"daily":{"soft_cost_usd_micros":10,"hard_cost_usd_micros":9}`,
		`"daily":{"Soft_Cost_USD_Micros":1}`,
		`"monthly":{"soft_cost_usd_micros":10,"hard_cost_usd_micros":9}`,
	} {
		t.Run(field, func(t *testing.T) {
			stub := &modelCallPolicyServiceStub{}
			f := modelCallPolicyFixture(t, stub)
			var object map[string]json.RawMessage
			require.NoError(t, json.Unmarshal([]byte(modelCallPolicyMutation), &object))
			require.NoError(t, json.Unmarshal([]byte("{"+field+"}"), &object))
			raw, err := json.Marshal(object)
			require.NoError(t, err)
			response := httptest.NewRecorder()
			f.raw.ServeHTTP(response, recoveryPolicyRequest(f, http.MethodPut, modelCallPolicyPath, string(raw), nil))
			assertModelCallPolicyError(t, response, 400, "invalid_request")
			require.Empty(t, stub.reads)
			require.Empty(t, stub.writes)
		})
	}
	t.Run("duplicate member", func(t *testing.T) {
		stub := &modelCallPolicyServiceStub{}
		f := modelCallPolicyFixture(t, stub)
		body := `{"request_id":"policy-change-1","organization_id":"org-1","actor_principal_id":"user-admin","expected_revision":0,"unknown_cost":"deny","run_caps":{"max_input_tokens":1000,"max_input_tokens":1000},"daily":{"soft_cost_usd_micros":40,"hard_cost_usd_micros":60},"monthly":{}}`
		response := httptest.NewRecorder()
		f.raw.ServeHTTP(response, recoveryPolicyRequest(f, http.MethodPut, modelCallPolicyPath, body, nil))
		assertModelCallPolicyError(t, response, 400, "invalid_request")
		require.Empty(t, stub.writes)
	})
	t.Run("duplicate top-level member", func(t *testing.T) {
		stub := &modelCallPolicyServiceStub{}
		f := modelCallPolicyFixture(t, stub)
		body := `{"request_id":"policy-change-1","organization_id":"org-1","organization_id":"org-1","actor_principal_id":"user-admin","expected_revision":0,"unknown_cost":"deny","run_caps":{"max_input_tokens":1000},"daily":{"soft_cost_usd_micros":40,"hard_cost_usd_micros":60},"monthly":{}}`
		response := httptest.NewRecorder()
		f.raw.ServeHTTP(response, recoveryPolicyRequest(f, http.MethodPut, modelCallPolicyPath, body, nil))
		assertModelCallPolicyError(t, response, 400, "invalid_request")
		require.Empty(t, stub.writes)
	})
	t.Run("PUT rejects query fields", func(t *testing.T) {
		stub := &modelCallPolicyServiceStub{}
		f := modelCallPolicyFixture(t, stub)
		response := httptest.NewRecorder()
		f.raw.ServeHTTP(response, recoveryPolicyRequest(f, http.MethodPut, modelCallPolicyPath+"?organization_id=org-1", modelCallPolicyMutation, nil))
		assertModelCallPolicyError(t, response, 400, "invalid_request")
		require.Empty(t, stub.writes)
	})
}
