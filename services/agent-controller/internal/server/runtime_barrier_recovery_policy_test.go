package server

import (
	"context"
	"encoding/json"
	"fmt"
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

const recoveryPolicyPath = "/internal/runtime-barrier-recovery-policy"
const recoveryPolicyMutation = `{"request_id":"policy-change-1","organization_id":"org-1","actor_principal_id":"user-admin","expected_revision":0,"mode":"manual","cooldown_ms":300000}`

type runtimeBarrierRecoveryPolicyServiceStub struct {
	policy domain.RuntimeBarrierRecoveryPolicy
	err    error
	reads  []string
	writes []application.SetRuntimeBarrierRecoveryPolicyInput
}

func (stub *runtimeBarrierRecoveryPolicyServiceStub) Get(_ context.Context, organizationID string) (domain.RuntimeBarrierRecoveryPolicy, error) {
	stub.reads = append(stub.reads, organizationID)
	return stub.policy, stub.err
}

func (stub *runtimeBarrierRecoveryPolicyServiceStub) Set(_ context.Context, input application.SetRuntimeBarrierRecoveryPolicyInput) (domain.RuntimeBarrierRecoveryPolicy, error) {
	stub.writes = append(stub.writes, input)
	return stub.policy, stub.err
}

func recoveryPolicyFixture(t *testing.T, stub *runtimeBarrierRecoveryPolicyServiceStub) *businessFixture {
	t.Helper()
	f := newAuthenticationFixture(t)
	var err error
	f.raw, err = WithRuntimeBarrierRecoveryPolicyRoutes(http.NotFoundHandler(), stub, f.security)
	require.NoError(t, err)
	return f
}

// Use the real workload receiver and CCT verifier, never the business fixture's
// ServeHTTP method, which signs and repairs requests on behalf of older tests.
func recoveryPolicyRequest(f *businessFixture, method, target, body string, claims map[string]any) *http.Request {
	f.t.Helper()
	r := httptest.NewRequest(method, target, strings.NewReader(body))
	r.Header.Set(serviceauth.Header, "Bearer "+f.tokens["admin-console"])
	r.Header.Set(callercontext.Header, f.sign(claims))
	if method == http.MethodPut {
		r.Header.Set("Content-Type", "application/json")
	}
	// These unverified hints must neither grant authority nor replace CCT scope.
	r.Header.Set("X-Antnest-Organization-ID", "forged-organization")
	r.Header.Set("X-Antnest-Principal-ID", "forged-principal")
	r.Header.Set("X-Antnest-System-Role", "admin")
	r.Header.Set("Authorization", "Bearer private-policy-hint")
	r.Header.Set("Cookie", "private-policy-cookie")
	return r
}

func recoveryPolicyInput(t *testing.T, overrides map[string]json.RawMessage, omitted ...string) string {
	t.Helper()
	var object map[string]json.RawMessage
	require.NoError(t, json.Unmarshal([]byte(recoveryPolicyMutation), &object))
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

func assertRecoveryPolicyError(t *testing.T, response *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	require.Equal(t, status, response.Code, response.Body.String())
	var payload errorResponse
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &payload))
	require.Equal(t, code, payload.Code)
	require.False(t, payload.Retryable)
}

func assertRecoveryPolicySnapshot(t *testing.T, response *httptest.ResponseRecorder, policy domain.RuntimeBarrierRecoveryPolicy) {
	t.Helper()
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	require.Equal(t, "no-store", response.Header().Get("Cache-Control"))
	require.Contains(t, response.Header().Get("Content-Type"), "application/json")
	require.JSONEq(t, fmt.Sprintf(`{"organization_id":%q,"revision":%d,"mode":%q,"cooldown_ms":%d}`,
		policy.OrganizationID, policy.Revision, policy.Mode, policy.CooldownMS), response.Body.String())
}

func TestRuntimeBarrierRecoveryPolicyHTTPAdministratorsAndWireBoundaries(t *testing.T) {
	for _, authority := range []struct {
		name   string
		claims map[string]any
	}{
		{name: "organization administrator"},
		{name: "system administrator", claims: map[string]any{"sys_role": "admin", "org_role": "member"}},
	} {
		t.Run(authority.name, func(t *testing.T) {
			stub := &runtimeBarrierRecoveryPolicyServiceStub{policy: domain.RuntimeBarrierRecoveryPolicy{
				OrganizationID: "org-1", Revision: 0, Mode: "manual", CooldownMS: 300000,
			}}
			f := recoveryPolicyFixture(t, stub)
			read := httptest.NewRecorder()
			f.raw.ServeHTTP(read, recoveryPolicyRequest(f, http.MethodGet, recoveryPolicyPath+"?organization_id=org-1", "", authority.claims))
			assertRecoveryPolicySnapshot(t, read, stub.policy)
			require.Equal(t, []string{"org-1"}, stub.reads)
			require.Empty(t, stub.writes)
			stub.policy.Revision = 1
			write := httptest.NewRecorder()
			f.raw.ServeHTTP(write, recoveryPolicyRequest(f, http.MethodPut, recoveryPolicyPath, recoveryPolicyMutation, authority.claims))
			assertRecoveryPolicySnapshot(t, write, stub.policy)
			require.Len(t, stub.writes, 1)
			expected := int64(0)
			require.Equal(t, application.SetRuntimeBarrierRecoveryPolicyInput{
				RequestID: "policy-change-1", OrganizationID: "org-1", ActorPrincipalID: "user-admin",
				ExpectedRevision: &expected, Mode: "manual", CooldownMS: 300000,
			}, stub.writes[0])
		})
	}
	for _, scenario := range []struct {
		name, requestID, organizationID, actor, mode string
		revision, cooldown                           int64
	}{
		{"minimum", "r", "o", "a", "manual", 0, 60000},
		{"automatic and identifier punctuation", "Request_1.-", "Org_1.-", "Actor_1.-", "auto", 7, 300000},
		{"maximum wire values", strings.Repeat("r", 200), strings.Repeat("o", 200), strings.Repeat("a", 200), "notify", 9007199254740991, 86400000},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			stub := &runtimeBarrierRecoveryPolicyServiceStub{policy: domain.RuntimeBarrierRecoveryPolicy{
				OrganizationID: scenario.organizationID, Revision: scenario.revision, Mode: scenario.mode, CooldownMS: scenario.cooldown,
			}}
			f := recoveryPolicyFixture(t, stub)
			body := fmt.Sprintf(`{"request_id":%q,"organization_id":%q,"actor_principal_id":%q,"expected_revision":%d,"mode":%q,"cooldown_ms":%d}`,
				scenario.requestID, scenario.organizationID, scenario.actor, scenario.revision, scenario.mode, scenario.cooldown)
			response := httptest.NewRecorder()
			f.raw.ServeHTTP(response, recoveryPolicyRequest(f, http.MethodPut, recoveryPolicyPath, body,
				map[string]any{"org": scenario.organizationID, "sub": scenario.actor}))
			assertRecoveryPolicySnapshot(t, response, stub.policy)
			require.Empty(t, stub.reads)
			require.Len(t, stub.writes, 1)
			actual := stub.writes[0]
			require.Equal(t, scenario.requestID, actual.RequestID)
			require.Equal(t, scenario.organizationID, actual.OrganizationID)
			require.Equal(t, scenario.actor, actual.ActorPrincipalID)
			require.NotNil(t, actual.ExpectedRevision)
			require.Equal(t, scenario.revision, *actual.ExpectedRevision)
			require.Equal(t, scenario.mode, actual.Mode)
			require.Equal(t, scenario.cooldown, actual.CooldownMS)
		})
	}
}

func TestRuntimeBarrierRecoveryPolicyHTTPRequiresWorkloadAndCurrentAdministrator(t *testing.T) {
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
					stub := &runtimeBarrierRecoveryPolicyServiceStub{}
					f := recoveryPolicyFixture(t, stub)
					target, body := recoveryPolicyPath, recoveryPolicyMutation
					if method == http.MethodGet {
						target, body = recoveryPolicyPath+"?organization_id=org-1", ""
					}
					request := recoveryPolicyRequest(f, method, target, body, scenario.claims)
					if scenario.change != nil {
						scenario.change(f, request)
					}
					response := httptest.NewRecorder()
					f.raw.ServeHTTP(response, request)
					assertRecoveryPolicyError(t, response, scenario.status, scenario.code)
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
					stub := &runtimeBarrierRecoveryPolicyServiceStub{}
					f := recoveryPolicyFixture(t, stub)
					target, body := recoveryPolicyPath, recoveryPolicyMutation
					if method == http.MethodGet {
						target, body = recoveryPolicyPath+"?organization_id=org-1", ""
					}
					request := recoveryPolicyRequest(f, method, target, body, nil)
					request.Header.Set(serviceauth.Header, "Bearer "+f.tokens[caller])
					verified, err := f.security.Authentication.Authorize(request, []string{caller})
					require.NoError(t, err, "the negative must use an actual authenticated foreign workload")
					require.Equal(t, caller, verified)
					response := httptest.NewRecorder()
					f.raw.ServeHTTP(response, request)
					assertRecoveryPolicyError(t, response, 403, "caller_not_allowed")
					require.Empty(t, stub.reads)
					require.Empty(t, stub.writes)
				})
			}
		})
	}
	t.Run("PUT actor must be the signed administrator", func(t *testing.T) {
		stub := &runtimeBarrierRecoveryPolicyServiceStub{}
		f := recoveryPolicyFixture(t, stub)
		response := httptest.NewRecorder()
		f.raw.ServeHTTP(response, recoveryPolicyRequest(f, http.MethodPut, recoveryPolicyPath, recoveryPolicyMutation,
			map[string]any{"sub": "another-administrator"}))
		assertRecoveryPolicyError(t, response, 403, "actor_mismatch")
		require.Empty(t, stub.reads)
		require.Empty(t, stub.writes)
	})
}

func TestRuntimeBarrierRecoveryPolicyHTTPReauthenticatesIdenticalMutation(t *testing.T) {
	stub := &runtimeBarrierRecoveryPolicyServiceStub{policy: domain.RuntimeBarrierRecoveryPolicy{
		OrganizationID: "org-1", Revision: 1, Mode: "manual", CooldownMS: 300000,
	}}
	f := recoveryPolicyFixture(t, stub)
	first := httptest.NewRecorder()
	f.raw.ServeHTTP(first, recoveryPolicyRequest(f, http.MethodPut, recoveryPolicyPath, recoveryPolicyMutation, nil))
	assertRecoveryPolicySnapshot(t, first, stub.policy)
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
			f.raw.ServeHTTP(response, recoveryPolicyRequest(f, http.MethodPut, recoveryPolicyPath, recoveryPolicyMutation, scenario.claims))
			assertRecoveryPolicyError(t, response, scenario.status, scenario.code)
			require.Len(t, stub.writes, 1, "a replay receipt must not bypass current authorization")
			require.Empty(t, stub.reads)
		})
	}
}

func TestRuntimeBarrierRecoveryPolicyHTTPStrictGETQueryAndNoBody(t *testing.T) {
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
			stub := &runtimeBarrierRecoveryPolicyServiceStub{}
			f := recoveryPolicyFixture(t, stub)
			response := httptest.NewRecorder()
			f.raw.ServeHTTP(response, recoveryPolicyRequest(f, http.MethodGet, recoveryPolicyPath+"?"+scenario.query, scenario.body, scenario.claims))
			assertRecoveryPolicyError(t, response, 400, "invalid_request")
			require.Empty(t, stub.reads)
			require.Empty(t, stub.writes)
		})
	}
}

func TestRuntimeBarrierRecoveryPolicyHTTPRequiresAllSixMutationFields(t *testing.T) {
	for _, field := range []string{"request_id", "organization_id", "actor_principal_id", "expected_revision", "mode", "cooldown_ms"} {
		for _, form := range []string{"missing", "null"} {
			t.Run(field+"/"+form, func(t *testing.T) {
				stub := &runtimeBarrierRecoveryPolicyServiceStub{}
				f := recoveryPolicyFixture(t, stub)
				body := recoveryPolicyInput(t, map[string]json.RawMessage{field: json.RawMessage("null")})
				if form == "missing" {
					body = recoveryPolicyInput(t, nil, field)
				}
				response := httptest.NewRecorder()
				f.raw.ServeHTTP(response, recoveryPolicyRequest(f, http.MethodPut, recoveryPolicyPath, body, nil))
				assertRecoveryPolicyError(t, response, 400, "invalid_request")
				require.Empty(t, stub.reads)
				require.Empty(t, stub.writes)
			})
		}
	}
}

func TestRuntimeBarrierRecoveryPolicyHTTPRejectsInvalidPolicyValuesBeforeService(t *testing.T) {
	for _, scenario := range []struct {
		name, field, raw string
		claims           map[string]any
	}{
		{name: "empty request ID", field: "request_id", raw: `""`},
		{name: "padded request ID", field: "request_id", raw: `" change-1"`},
		{name: "request ID grammar", field: "request_id", raw: `"change/1"`},
		{name: "request ID starts with punctuation", field: "request_id", raw: `"_change-1"`},
		{name: "request ID exceeds existing limit", field: "request_id", raw: `"` + strings.Repeat("r", 201) + `"`},
		{name: "organization ID grammar", field: "organization_id", raw: `"org/1"`, claims: map[string]any{"org": "org/1"}},
		{name: "actor ID grammar", field: "actor_principal_id", raw: `"user/admin"`, claims: map[string]any{"sub": "user/admin"}},
		{name: "negative revision", field: "expected_revision", raw: "-1"},
		{name: "fractional revision", field: "expected_revision", raw: "0.5"},
		{name: "unsafe revision", field: "expected_revision", raw: "9007199254740992"},
		{name: "revision integer overflow", field: "expected_revision", raw: "9223372036854775808"},
		{name: "string revision", field: "expected_revision", raw: `"0"`},
		{name: "unknown mode", field: "mode", raw: `"automatic"`},
		{name: "case sensitive mode", field: "mode", raw: `"Auto"`},
		{name: "empty mode", field: "mode", raw: `""`},
		{name: "cooldown below minimum", field: "cooldown_ms", raw: "59999"},
		{name: "cooldown above maximum", field: "cooldown_ms", raw: "86400001"},
		{name: "fractional cooldown", field: "cooldown_ms", raw: "60000.5"},
		{name: "string cooldown", field: "cooldown_ms", raw: `"60000"`},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			stub := &runtimeBarrierRecoveryPolicyServiceStub{}
			f := recoveryPolicyFixture(t, stub)
			body := recoveryPolicyInput(t, map[string]json.RawMessage{scenario.field: json.RawMessage(scenario.raw)})
			response := httptest.NewRecorder()
			f.raw.ServeHTTP(response, recoveryPolicyRequest(f, http.MethodPut, recoveryPolicyPath, body, scenario.claims))
			assertRecoveryPolicyError(t, response, 400, "invalid_request")
			require.Empty(t, stub.reads)
			require.Empty(t, stub.writes)
		})
	}
}

func TestRuntimeBarrierRecoveryPolicyHTTPRetainsStrictJSONMediaAndSize(t *testing.T) {
	for _, scenario := range []struct {
		name, body, media, encoding, query, code string
		status                                   int
		duplicateMedia                           bool
	}{
		{name: "mutation query", body: recoveryPolicyMutation, media: "application/json", query: "?organization_id=org-1", status: 400, code: "invalid_request"},
		{name: "unknown field", body: strings.TrimSuffix(recoveryPolicyMutation, "}") + `,"extra":true}`, media: "application/json", status: 400, code: "invalid_request"},
		{name: "decoded duplicate", body: strings.TrimSuffix(recoveryPolicyMutation, "}") + `,"\u006dode":"manual"}`, media: "application/json", status: 400, code: "invalid_request"},
		{name: "case alias", body: strings.Replace(recoveryPolicyMutation, `"mode"`, `"Mode"`, 1), media: "application/json", status: 400, code: "invalid_request"},
		{name: "BOM", body: "\xef\xbb\xbf" + recoveryPolicyMutation, media: "application/json", status: 400, code: "invalid_request"},
		{name: "invalid UTF8", body: strings.Replace(recoveryPolicyMutation, "policy-change-1", "invalid-\xff", 1), media: "application/json", status: 400, code: "invalid_request"},
		{name: "multiple documents", body: recoveryPolicyMutation + " {}", media: "application/json", status: 400, code: "invalid_request"},
		{name: "array", body: "[" + recoveryPolicyMutation + "]", media: "application/json", status: 400, code: "invalid_request"},
		{name: "null object", body: "null", media: "application/json", status: 400, code: "invalid_request"},
		{name: "missing media", body: recoveryPolicyMutation, status: 415, code: "unsupported_media_type"},
		{name: "browser simple media", body: recoveryPolicyMutation, media: "text/plain", status: 415, code: "unsupported_media_type"},
		{name: "foreign charset", body: recoveryPolicyMutation, media: "application/json; charset=latin1", status: 415, code: "unsupported_media_type"},
		{name: "duplicate media", body: recoveryPolicyMutation, media: "application/json", duplicateMedia: true, status: 415, code: "unsupported_media_type"},
		{name: "compressed body", body: recoveryPolicyMutation, media: "application/json", encoding: "gzip", status: 415, code: "unsupported_media_type"},
		{name: "oversize", body: strings.Repeat(" ", maximumRequestBytes+1), media: "application/json", status: 413, code: "request_too_large"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			stub := &runtimeBarrierRecoveryPolicyServiceStub{}
			f := recoveryPolicyFixture(t, stub)
			request := recoveryPolicyRequest(f, http.MethodPut, recoveryPolicyPath+scenario.query, scenario.body, nil)
			request.Header.Del("Content-Type")
			if scenario.media != "" {
				request.Header.Set("Content-Type", scenario.media)
			}
			if scenario.duplicateMedia {
				request.Header.Add("Content-Type", scenario.media)
			}
			if scenario.encoding != "" {
				request.Header.Set("Content-Encoding", scenario.encoding)
			}
			response := httptest.NewRecorder()
			f.raw.ServeHTTP(response, request)
			assertRecoveryPolicyError(t, response, scenario.status, scenario.code)
			require.Empty(t, stub.reads)
			require.Empty(t, stub.writes)
		})
	}
}

func TestRuntimeBarrierRecoveryPolicyHTTPUsesDistinctCASAndRequestConflictCodes(t *testing.T) {
	for _, scenario := range []struct {
		name, code string
		cause      error
	}{
		{name: "stale policy CAS", cause: ports.ErrConcurrentChange, code: "resource_version_conflict"},
		{name: "reused request ID", cause: ports.ErrRequestConflict, code: "request_id_conflict"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			stub := &runtimeBarrierRecoveryPolicyServiceStub{err: fmt.Errorf("policy storage: %w", scenario.cause)}
			f := recoveryPolicyFixture(t, stub)
			response := httptest.NewRecorder()
			f.raw.ServeHTTP(response, recoveryPolicyRequest(f, http.MethodPut, recoveryPolicyPath, recoveryPolicyMutation, nil))
			assertRecoveryPolicyError(t, response, 409, scenario.code)
			require.NotContains(t, response.Body.String(), "lifecycle_conflict")
			require.NotContains(t, response.Body.String(), "policy storage")
			require.Len(t, stub.writes, 1)
			require.Empty(t, stub.reads)
		})
	}
}

func TestRuntimeBarrierRecoveryPolicyHTTPPreservesBaseRoutes(t *testing.T) {
	f := newAuthenticationFixture(t)
	queries := &agentQueryServiceStub{}
	base, err := NewHandler(&catalogServiceStub{}, &lifecycleServiceStub{}, &agentConfigurationServiceStub{}, queries,
		&agentEventServiceStub{}, &networkPolicyServiceStub{}, func(context.Context) error { return nil }, f.security)
	require.NoError(t, err)
	stub := &runtimeBarrierRecoveryPolicyServiceStub{}
	f.raw, err = WithRuntimeBarrierRecoveryPolicyRoutes(base, stub, f.security)
	require.NoError(t, err)
	health := httptest.NewRecorder()
	f.raw.ServeHTTP(health, httptest.NewRequest(http.MethodGet, "/status", nil))
	require.Equal(t, 200, health.Code)
	response := httptest.NewRecorder()
	f.raw.ServeHTTP(response, recoveryPolicyRequest(f, http.MethodGet, "/internal/agents?organization_id=org-1", "", nil))
	require.Equal(t, 200, response.Code, response.Body.String())
	require.Equal(t, 1, queries.listCalls)
	require.Equal(t, "org-1", queries.listInput.OrganizationID)
	require.Empty(t, stub.reads)
	require.Empty(t, stub.writes)
}

func TestRuntimeBarrierRecoveryPolicyHTTPConstructorRequiresVerifiedSecurity(t *testing.T) {
	f := newAuthenticationFixture(t)
	stub := &runtimeBarrierRecoveryPolicyServiceStub{}
	for _, scenario := range []struct {
		name     string
		base     http.Handler
		service  RuntimeBarrierRecoveryPolicyService
		security []Security
	}{
		{name: "base missing", service: stub, security: []Security{f.security}},
		{name: "service missing", base: http.NotFoundHandler(), security: []Security{f.security}},
		{name: "security missing", base: http.NotFoundHandler(), service: stub},
		{name: "security incomplete", base: http.NotFoundHandler(), service: stub, security: []Security{{}}},
		{name: "ambiguous security", base: http.NotFoundHandler(), service: stub, security: []Security{f.security, f.security}},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			boundary, err := WithRuntimeBarrierRecoveryPolicyRoutes(scenario.base, scenario.service, scenario.security...)
			require.Error(t, err)
			require.Nil(t, boundary)
		})
	}
}
