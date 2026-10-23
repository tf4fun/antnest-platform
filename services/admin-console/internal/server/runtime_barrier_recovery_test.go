package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"testing"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/callercontext"
	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
	"github.com/tf4fun/antnest-platform/services/admin-console/internal/principal"
	"github.com/tf4fun/antnest-platform/services/admin-console/internal/upstream"
)

const consoleRuntimeRecoveryID = "rebuild_original"
const consoleRuntimeRecoveryPath = "/api/admin/agents/agent-1/rebuild"
const consoleRuntimeRecoveryUpstreamPath = "/internal/agents/agent-1/rebuild"
const consoleRuntimeRecoveryRaw = `{"barrier_id":"barrier-\u0000-é-🧪","expected_runtime_revision":"rtv_original"}`

func TestRuntimeBarrierRecoveryProjectionPreservesSafeFields(t *testing.T) {
	for _, route := range consoleRuntimeRecoveryReadRoutes() {
		for _, variant := range []struct {
			name, mode         string
			revision, cooldown float64
			until              any
		}{
			{"default-manual", "manual", 0, 300000, nil},
			{"notify-utc", "notify", 9007199254740991, 60000, "2026-10-23T01:02:03.123456789Z"},
			{"auto", "auto", 1, 86400000, nil},
		} {
			t.Run(route.name+"/"+variant.name, func(t *testing.T) {
				expected := consoleRuntimeRecoveryProjection()
				expected["mode"], expected["policy_revision"] = variant.mode, variant.revision
				expected["cooldown_ms"], expected["cooldown_until"] = variant.cooldown, variant.until
				source := consoleRuntimeRecoveryProjection()
				for field, value := range expected {
					source[field] = value
				}
				source["runtime_execution_id"] = "private-recovery-execution"
				source["mcp_endpoint"] = "http://private-recovery-endpoint"
				source["future_private_field"] = map[string]any{"credential": "private-recovery-credential"}
				agent := consoleRuntimeRecoveryAgent()
				agent["runtime_recovery"] = source
				response, backend := consoleRuntimeRecoveryRead(t, route, agent)
				if response.Code != http.StatusOK {
					t.Fatalf("projection status=%d body=%s", response.Code, response.Body)
				}
				result := consoleRuntimeRecoveryReadAgent(t, route, response)
				if !reflect.DeepEqual(result["runtime_recovery"], expected) {
					t.Fatalf("recovery wire changed: got=%v want=%v", result["runtime_recovery"], expected)
				}
				if result["agent_spec_revision"] != "spec-original" || result["last_successful_execution_revision"] != "execution-original" {
					t.Fatalf("existing history changed: %v", result)
				}
				if strings.Contains(response.Body.String(), "private-") || response.Header().Get("Cache-Control") != "no-store" {
					t.Fatalf("private projection or cache policy escaped: %s", response.Body)
				}
				call := backend.singleCall(t)
				query, err := url.ParseQuery(call.Query)
				if err != nil || call.Target != upstream.AgentController || call.Method != http.MethodGet || call.Path != route.upstream || query.Get("organization_id") != "org-1" {
					t.Fatalf("read authority changed: %+v query error=%v", call, err)
				}
			})
		}
	}
}

func TestRuntimeBarrierRecoveryProjectionOmitsAbsentObject(t *testing.T) {
	for _, route := range consoleRuntimeRecoveryReadRoutes() {
		t.Run(route.name, func(t *testing.T) {
			response, backend := consoleRuntimeRecoveryRead(t, route, consoleRuntimeRecoveryAgent())
			if response.Code != http.StatusOK {
				t.Fatalf("legacy Agent rejected: status=%d body=%s", response.Code, response.Body)
			}
			result := consoleRuntimeRecoveryReadAgent(t, route, response)
			if _, exists := result["runtime_recovery"]; exists {
				t.Fatal("absent recovery was defaulted or inserted")
			}
			backend.singleCall(t)
		})
	}
}

func TestRuntimeBarrierRecoveryProjectionRejectsMalformedObject(t *testing.T) {
	type mutation struct {
		name, field string
		value       any
		missing     bool
	}
	var cases []mutation
	for _, field := range []string{"barrier_id", "reason", "runtime_revision", "policy_revision", "mode", "cooldown_ms", "rebuild_request_id", "notification_id", "cooldown_until"} {
		cases = append(cases, mutation{name: "missing-" + field, field: field, missing: true})
	}
	cases = append(cases, []mutation{
		{name: "null-object", value: nil},
		{name: "array-object", value: []any{}},
		{name: "barrier-type", field: "barrier_id", value: 17},
		{name: "reason-type", field: "reason", value: true},
		{name: "wrong-reason", field: "reason", value: "other_reason"},
		{name: "runtime-type", field: "runtime_revision", value: 17},
		{name: "runtime-id", field: "runtime_revision", value: "runtime/invalid"},
		{name: "unknown-mode", field: "mode", value: "automatic"},
		{name: "null-mode", field: "mode", value: nil},
		{name: "negative-revision", field: "policy_revision", value: -1},
		{name: "fractional-revision", field: "policy_revision", value: 0.5},
		{name: "unsafe-revision", field: "policy_revision", value: 9007199254740992.0},
		{name: "revision-type", field: "policy_revision", value: "0"},
		{name: "null-revision", field: "policy_revision", value: nil},
		{name: "short-cooldown", field: "cooldown_ms", value: 59999},
		{name: "long-cooldown", field: "cooldown_ms", value: 86400001},
		{name: "fractional-cooldown", field: "cooldown_ms", value: 60000.5},
		{name: "cooldown-type", field: "cooldown_ms", value: "300000"},
		{name: "null-cooldown", field: "cooldown_ms", value: nil},
		{name: "rebuild-id-type", field: "rebuild_request_id", value: 17},
		{name: "notification-id", field: "notification_id", value: "notification/invalid"},
		{name: "non-utc-date", field: "cooldown_until", value: "2026-10-23T01:02:03+00:00"},
		{name: "invalid-calendar-date", field: "cooldown_until", value: "2026-02-30T01:02:03Z"},
		{name: "invalid-date", field: "cooldown_until", value: "not-a-date"},
		{name: "date-type", field: "cooldown_until", value: 17},
	}...)
	for _, route := range consoleRuntimeRecoveryReadRoutes() {
		for _, scenario := range cases {
			t.Run(route.name+"/"+scenario.name, func(t *testing.T) {
				agent := consoleRuntimeRecoveryAgent()
				if scenario.field == "" {
					agent["runtime_recovery"] = scenario.value
				} else {
					projection := consoleRuntimeRecoveryProjection()
					if scenario.missing {
						delete(projection, scenario.field)
					} else {
						projection[scenario.field] = scenario.value
					}
					agent["runtime_recovery"] = projection
				}
				response, backend := consoleRuntimeRecoveryRead(t, route, agent)
				var failure map[string]any
				decodeBytes(t, response.Body.Bytes(), &failure)
				if response.Code != http.StatusBadGateway || failure["code"] != "invalid_upstream_response" {
					t.Fatalf("malformed recovery accepted: status=%d body=%s", response.Code, response.Body)
				}
				backend.singleCall(t)
			})
		}
	}
}

func TestRuntimeBarrierRecoveryForwardsOriginalIntentAcrossHandlerReplacement(t *testing.T) {
	backend := newBackendStub()
	operation := consoleRuntimeRecoveryOperation()
	backend.enqueueFor(consoleRuntimeRecoveryUpstreamPath, http.StatusAccepted, consoleRuntimeRecoveryJSON(t, operation))
	for index := range 2 {
		f := newTestHandler(t, backend).(*businessFixture)
		request := scopedLifecycleRequest(http.MethodPost, consoleRuntimeRecoveryPath, consoleRuntimeRecoveryBody(consoleRuntimeRecoveryRaw), "org-1")
		request.Header.Set("Idempotency-Key", consoleRuntimeRecoveryID)
		response := httptest.NewRecorder()
		if index == 0 {
			f.ServeHTTP(response, request)
		} else {
			// Replacing the handler retains the original ID. Signed claims,
			// rather than presentation hints, still supply organization and actor.
			actor := principal.Principal{UserID: "user-admin", OrganizationID: "org-1", MembershipID: "membership-1", SystemRole: "user", OrganizationRole: "admin"}
			request.Header.Set(serviceauth.Header, "Bearer "+f.token)
			request.Header.Set(callercontext.Header, f.sign(actor, "agent-1", nil))
			request.Header.Set(principal.HeaderUserID, "spoof-owner")
			request.Header.Set(principal.HeaderOrganizationID, "org-spoof")
			f.handler.ServeHTTP(response, request)
		}
		if response.Code != http.StatusAccepted || len(backend.calls) != index+1 {
			t.Fatalf("recovery must make exactly one POST without a pre-read: status=%d calls=%d body=%s", response.Code, len(backend.calls), response.Body)
		}
		call := backend.calls[index]
		var actual map[string]any
		decodeBytes(t, call.Body, &actual)
		var recovery map[string]any
		decodeBytes(t, []byte(consoleRuntimeRecoveryRaw), &recovery)
		expected := map[string]any{
			"request_id": consoleRuntimeRecoveryID, "organization_id": "org-1", "actor_principal_id": "user-admin",
			"template_id": "template-original", "template_revision": float64(7), "recovery": recovery,
		}
		if call.Target != upstream.AgentController || call.Method != http.MethodPost || call.Path != consoleRuntimeRecoveryUpstreamPath || call.Query != "" || !reflect.DeepEqual(actual, expected) {
			t.Fatalf("original recovery intent changed: call=%+v payload=%v", call, actual)
		}
		var result map[string]any
		decodeBytes(t, response.Body.Bytes(), &result)
		if !reflect.DeepEqual(result, operation) {
			t.Fatalf("original operation was replaced: got=%v want=%v", result, operation)
		}
	}
}

func TestRuntimeBarrierRecoveryRejectsInvalidInputBeforeUpstream(t *testing.T) {
	cases := []struct{ name, recovery string }{
		{"null", `null`},
		{"empty-object", `{}`},
		{"array", `[]`},
		{"missing-barrier", `{"expected_runtime_revision":"rtv_original"}`},
		{"missing-runtime", `{"barrier_id":"barrier-original"}`},
		{"unknown-field", `{"barrier_id":"barrier-original","expected_runtime_revision":"rtv_original","runtime_execution_id":"private-execution"}`},
		{"case-alias", `{"Barrier_ID":"barrier-original","expected_runtime_revision":"rtv_original"}`},
		{"duplicate-key", `{"barrier_id":"barrier-original","barrier_id":"another","expected_runtime_revision":"rtv_original"}`},
		{"decoded-duplicate-key", `{"barrier_id":"barrier-original","\u0062arrier_id":"another","expected_runtime_revision":"rtv_original"}`},
		{"null-barrier", `{"barrier_id":null,"expected_runtime_revision":"rtv_original"}`},
		{"numeric-barrier", `{"barrier_id":17,"expected_runtime_revision":"rtv_original"}`},
		{"null-runtime", `{"barrier_id":"barrier-original","expected_runtime_revision":null}`},
		{"numeric-runtime", `{"barrier_id":"barrier-original","expected_runtime_revision":17}`},
		{"invalid-runtime", `{"barrier_id":"barrier-original","expected_runtime_revision":"runtime/invalid"}`},
	}
	for _, barrier := range []struct{ name, value string }{
		{"empty-barrier", ""}, {"space-barrier", "barrier original"}, {"newline-barrier", "barrier\noriginal"},
		{"bom-barrier", "barrier\ufefforiginal"}, {"long-unicode-barrier", strings.Repeat("🧪", 201)},
	} {
		cases = append(cases, struct{ name, recovery string }{barrier.name, consoleRuntimeRecoveryJSON(t, map[string]any{
			"barrier_id": barrier.value, "expected_runtime_revision": "rtv_original",
		})})
	}
	for _, scenario := range cases {
		t.Run(scenario.name, func(t *testing.T) {
			consoleRuntimeRecoveryRejectRequest(t, consoleRuntimeRecoveryBody(scenario.recovery), []string{consoleRuntimeRecoveryID})
		})
	}
	for _, field := range []string{"request_id", "organization_id", "actor_principal_id", "owner_user_id", "rebuild_reason", "runtime_execution_id"} {
		t.Run("authority-"+field, func(t *testing.T) {
			body := strings.TrimSuffix(consoleRuntimeRecoveryBody(consoleRuntimeRecoveryRaw), "}") + fmt.Sprintf(",%q:%q}", field, "browser-supplied")
			consoleRuntimeRecoveryRejectRequest(t, body, []string{consoleRuntimeRecoveryID})
		})
	}
	for _, scenario := range []struct {
		name   string
		values []string
	}{
		{"missing-header", nil}, {"empty-header", []string{""}},
		{"duplicate-header", []string{consoleRuntimeRecoveryID, consoleRuntimeRecoveryID}},
		{"leading-space", []string{" " + consoleRuntimeRecoveryID}}, {"trailing-space", []string{consoleRuntimeRecoveryID + " "}},
		{"leading-tab", []string{"\t" + consoleRuntimeRecoveryID}}, {"comma-header", []string{consoleRuntimeRecoveryID + ",another"}},
		{"invalid-id", []string{"rebuild/original"}}, {"invalid-leading-character", []string{"_rebuild_original"}},
		{"unicode-id", []string{"rebuild_🧪"}}, {"long-id", []string{strings.Repeat("r", 201)}},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			consoleRuntimeRecoveryRejectRequest(t, consoleRuntimeRecoveryBody(consoleRuntimeRecoveryRaw), scenario.values)
		})
	}
}

func TestRuntimeBarrierRecoveryKeepsOrdinaryRebuildIdentity(t *testing.T) {
	backend := newBackendStub()
	backend.enqueueFor(consoleRuntimeRecoveryUpstreamPath, http.StatusAccepted, consoleRuntimeRecoveryJSON(t, consoleRuntimeRecoveryOperation()))
	var originalID any
	for index := range 2 {
		response := httptest.NewRecorder()
		newTestHandler(t, backend).ServeHTTP(response, scopedLifecycleRequest(http.MethodPost, consoleRuntimeRecoveryPath,
			`{"template_id":"template-original","template_revision":7}`, "org-1"))
		if response.Code != http.StatusAccepted || len(backend.calls) != index+1 {
			t.Fatalf("ordinary Rebuild changed: status=%d calls=%d", response.Code, len(backend.calls))
		}
		var payload map[string]any
		decodeBytes(t, backend.calls[index].Body, &payload)
		id, ok := payload["request_id"].(string)
		if !ok || !strings.HasPrefix(id, "lifecycle-") || id == "one-lifecycle-intent" {
			t.Fatalf("ordinary Idempotency-Key mapping changed: %v", payload)
		}
		if _, exists := payload["recovery"]; exists {
			t.Fatal("ordinary Rebuild acquired a recovery payload")
		}
		if index == 0 {
			originalID = id
		} else if id != originalID {
			t.Fatal("ordinary Rebuild lost its existing stable identity after handler replacement")
		}
	}
}

func TestRuntimeBarrierRecoveryReadsOriginalOperationAndKeepsConflicts(t *testing.T) {
	t.Run("original-operation", func(t *testing.T) {
		backend := newBackendStub()
		operation := consoleRuntimeRecoveryOperation()
		backend.enqueueFor("/internal/agent-operations/"+consoleRuntimeRecoveryID, http.StatusOK, consoleRuntimeRecoveryJSON(t, operation))
		response := httptest.NewRecorder()
		newTestHandler(t, backend).ServeHTTP(response, scopedLifecycleRequest(http.MethodGet,
			"/api/admin/operations/"+consoleRuntimeRecoveryID+"?organization_id=forged", "", "org-1"))
		var result map[string]any
		decodeBytes(t, response.Body.Bytes(), &result)
		if response.Code != http.StatusOK || !reflect.DeepEqual(result, operation) {
			t.Fatalf("original operation read changed: status=%d body=%s", response.Code, response.Body)
		}
		call := backend.singleCall(t)
		if call.Target != upstream.AgentController || call.Method != http.MethodGet || call.Path != "/internal/agent-operations/"+consoleRuntimeRecoveryID || call.Query != "organization_id=org-1" {
			t.Fatalf("operation identity or trusted scope changed: %+v", call)
		}
	})
	for _, code := range []string{"lifecycle_conflict", "request_id_conflict"} {
		t.Run(code, func(t *testing.T) {
			backend := newBackendStub()
			expected := map[string]any{"code": code, "message": "Recovery was not admitted", "retryable": false}
			backend.enqueueFor(consoleRuntimeRecoveryUpstreamPath, http.StatusConflict, consoleRuntimeRecoveryJSON(t, expected))
			response := httptest.NewRecorder()
			request := scopedLifecycleRequest(http.MethodPost, consoleRuntimeRecoveryPath, consoleRuntimeRecoveryBody(consoleRuntimeRecoveryRaw), "org-1")
			request.Header.Set("Idempotency-Key", consoleRuntimeRecoveryID)
			newTestHandler(t, backend).ServeHTTP(response, request)
			var actual map[string]any
			decodeBytes(t, response.Body.Bytes(), &actual)
			if response.Code != http.StatusConflict || !reflect.DeepEqual(actual, expected) {
				t.Fatalf("conflict or retry policy changed: status=%d body=%s", response.Code, response.Body)
			}
			call := backend.singleCall(t)
			if call.Method != http.MethodPost || call.Path != consoleRuntimeRecoveryUpstreamPath {
				t.Fatalf("conflict triggered another action: %+v", call)
			}
		})
	}
}

func TestRuntimeBarrierRecoveryDoesNotGrantMemberAuthority(t *testing.T) {
	for _, method := range []string{http.MethodPost, http.MethodGet} {
		t.Run(method, func(t *testing.T) {
			backend := newBackendStub()
			f := newTestHandler(t, backend).(*businessFixture)
			path, body, agentID := consoleRuntimeRecoveryPath, consoleRuntimeRecoveryBody(consoleRuntimeRecoveryRaw), "agent-1"
			if method == http.MethodGet {
				path, body, agentID = "/api/admin/operations/"+consoleRuntimeRecoveryID, "", ""
			}
			request := scopedLifecycleRequest(method, path, body, "org-1")
			request.Header.Set("Idempotency-Key", consoleRuntimeRecoveryID)
			request.Header.Set(serviceauth.Header, "Bearer "+f.token)
			member := principal.Principal{UserID: "user-owner", OrganizationID: "org-1", MembershipID: "membership-1", SystemRole: "user", OrganizationRole: "member"}
			request.Header.Set(callercontext.Header, f.sign(member, agentID, nil))
			response := httptest.NewRecorder()
			// scopedLifecycleRequest's administrator hints cannot upgrade the
			// independently signed ordinary owner's actual role.
			f.handler.ServeHTTP(response, request)
			if response.Code != http.StatusForbidden || len(backend.calls) != 0 {
				t.Fatalf("member reached recovery authority: status=%d calls=%d body=%s", response.Code, len(backend.calls), response.Body)
			}
		})
	}
}

type consoleRuntimeRecoveryReadRoute struct {
	name, browser, upstream string
	list                    bool
}

func consoleRuntimeRecoveryReadRoutes() []consoleRuntimeRecoveryReadRoute {
	return []consoleRuntimeRecoveryReadRoute{
		{name: "detail", browser: "/api/admin/agents/agent-1", upstream: "/internal/agents/agent-1"},
		{name: "list", browser: "/api/admin/agents", upstream: "/internal/agents", list: true},
	}
}

func consoleRuntimeRecoveryProjection() map[string]any {
	return map[string]any{
		"barrier_id": "barrier-\x00-é-🧪", "reason": "runtime_barrier_required", "runtime_revision": "rtv_original",
		"policy_revision": float64(0), "mode": "manual", "cooldown_ms": float64(300000),
		"rebuild_request_id": consoleRuntimeRecoveryID, "notification_id": "notification_original", "cooldown_until": nil,
	}
}

func consoleRuntimeRecoveryAgent() map[string]any {
	return map[string]any{
		"agent_id": "agent-1", "owner_user_id": "user-owner", "name": "Agent",
		"desired_state": "enabled", "lifecycle_state": "created", "activation_state": "enabled", "runtime_state": "available",
		"agent_spec_revision": "spec-original", "last_successful_execution_revision": "execution-original",
		"aggregate_sequence": 7, "created_at": "2026-10-23T00:00:00Z", "updated_at": "2026-10-23T00:00:01Z",
		"future_controller_field": "private-future-controller-value", "access_revision": "private-access-revision",
	}
}

func consoleRuntimeRecoveryRead(t *testing.T, route consoleRuntimeRecoveryReadRoute, agent map[string]any) (*httptest.ResponseRecorder, *backendStub) {
	t.Helper()
	var payload any = agent
	if route.list {
		payload = map[string]any{"items": []any{agent}, "next_cursor": nil}
	}
	backend := newBackendStub()
	backend.enqueueFor(route.upstream, http.StatusOK, consoleRuntimeRecoveryJSON(t, payload))
	response := httptest.NewRecorder()
	newTestHandler(t, backend).ServeHTTP(response, scopedLifecycleRequest(http.MethodGet, route.browser, "", "org-1"))
	return response, backend
}

func consoleRuntimeRecoveryReadAgent(t *testing.T, route consoleRuntimeRecoveryReadRoute, response *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var result map[string]any
	decodeBytes(t, response.Body.Bytes(), &result)
	if !route.list {
		return result
	}
	items, ok := result["items"].([]any)
	if !ok || len(items) != 1 {
		t.Fatalf("invalid Agent page: %v", result)
	}
	agent, ok := items[0].(map[string]any)
	if !ok {
		t.Fatalf("invalid Agent row: %v", items[0])
	}
	return agent
}

func consoleRuntimeRecoveryBody(recovery string) string {
	return `{"template_id":"template-original","template_revision":7,"recovery":` + recovery + `}`
}

func consoleRuntimeRecoveryOperation() map[string]any {
	return map[string]any{"request_id": consoleRuntimeRecoveryID, "agent_id": "agent-1", "kind": "rebuild", "phase": "drain", "state": "running", "created_at": "2026-10-23T00:00:00Z", "updated_at": "2026-10-23T00:00:01Z"}
}

func consoleRuntimeRecoveryJSON(t *testing.T, value any) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

func consoleRuntimeRecoveryRejectRequest(t *testing.T, body string, keys []string) {
	t.Helper()
	backend := newBackendStub()
	request := scopedLifecycleRequest(http.MethodPost, consoleRuntimeRecoveryPath, body, "org-1")
	request.Header.Del("Idempotency-Key")
	for _, key := range keys {
		request.Header.Add("Idempotency-Key", key)
	}
	response := httptest.NewRecorder()
	newTestHandler(t, backend).ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest || len(backend.calls) != 0 {
		t.Fatalf("invalid recovery reached an upstream: status=%d calls=%d body=%s", response.Code, len(backend.calls), response.Body)
	}
}

func TestRuntimeBarrierRecoveryOpaqueJSONInput(t *testing.T) {
	for _, scenario := range consoleRuntimeRecoveryOpaqueJSONCases() {
		t.Run(scenario.name, func(t *testing.T) {
			backend := newBackendStub()
			backend.enqueueFor(consoleRuntimeRecoveryUpstreamPath, http.StatusAccepted, consoleRuntimeRecoveryJSON(t, consoleRuntimeRecoveryOperation()))
			// Splice the raw JSON string token directly: marshaling a decoded
			// fixture first would hide encoding/json's surrogate replacement.
			recovery := `{"barrier_id":` + scenario.raw + `,"expected_runtime_revision":"rtv_original"}`
			request := scopedLifecycleRequest(http.MethodPost, consoleRuntimeRecoveryPath, consoleRuntimeRecoveryBody(recovery), "org-1")
			request.Header.Set("Idempotency-Key", consoleRuntimeRecoveryID)
			response := httptest.NewRecorder()
			newTestHandler(t, backend).ServeHTTP(response, request)
			if !scenario.valid {
				if response.Code != http.StatusBadRequest || len(backend.calls) != 0 {
					t.Fatalf("unpaired surrogate was repaired and dispatched: status=%d calls=%d body=%s", response.Code, len(backend.calls), response.Body)
				}
				return
			}
			if response.Code != http.StatusAccepted {
				t.Fatalf("valid opaque identity rejected: status=%d body=%s", response.Code, response.Body)
			}
			call := backend.singleCall(t)
			var actual map[string]any
			decodeBytes(t, call.Body, &actual)
			expected := map[string]any{
				"request_id": consoleRuntimeRecoveryID, "organization_id": "org-1", "actor_principal_id": "user-admin",
				"template_id": "template-original", "template_revision": float64(7),
				"recovery": map[string]any{"barrier_id": scenario.decoded, "expected_runtime_revision": "rtv_original"},
			}
			if call.Target != upstream.AgentController || call.Method != http.MethodPost || call.Path != consoleRuntimeRecoveryUpstreamPath || call.Query != "" || !reflect.DeepEqual(actual, expected) {
				t.Fatalf("opaque identity or original intent changed: call=%+v payload=%v want=%v", call, actual, expected)
			}
		})
	}
}

func TestRuntimeBarrierRecoveryOpaqueJSONProjection(t *testing.T) {
	for _, route := range consoleRuntimeRecoveryReadRoutes() {
		for _, scenario := range consoleRuntimeRecoveryOpaqueJSONCases() {
			t.Run(route.name+"/"+scenario.name, func(t *testing.T) {
				projection := `{"barrier_id":` + scenario.raw + `,"reason":"runtime_barrier_required","runtime_revision":"rtv_original","policy_revision":0,"mode":"manual","cooldown_ms":300000,"rebuild_request_id":"rebuild_original","notification_id":"notification_original","cooldown_until":null}`
				// Only the ordinary Agent fixture is marshaled. The opaque token
				// remains byte-for-byte raw until the actual BFF decoder sees it.
				agent := strings.TrimSuffix(consoleRuntimeRecoveryJSON(t, consoleRuntimeRecoveryAgent()), "}") + `,"runtime_recovery":` + projection + `}`
				payload := agent
				if route.list {
					payload = `{"items":[` + agent + `],"next_cursor":null}`
				}
				backend := newBackendStub()
				backend.enqueueFor(route.upstream, http.StatusOK, payload)
				response := httptest.NewRecorder()
				newTestHandler(t, backend).ServeHTTP(response, scopedLifecycleRequest(http.MethodGet, route.browser, "", "org-1"))
				backend.singleCall(t)
				if !scenario.valid {
					var failure map[string]any
					decodeBytes(t, response.Body.Bytes(), &failure)
					if response.Code != http.StatusBadGateway || failure["code"] != "invalid_upstream_response" {
						t.Fatalf("unpaired surrogate was repaired into a public identity: status=%d body=%s", response.Code, response.Body)
					}
					return
				}
				if response.Code != http.StatusOK {
					t.Fatalf("valid opaque projection rejected: status=%d body=%s", response.Code, response.Body)
				}
				result := consoleRuntimeRecoveryReadAgent(t, route, response)
				expected := consoleRuntimeRecoveryProjection()
				expected["barrier_id"] = scenario.decoded
				if !reflect.DeepEqual(result["runtime_recovery"], expected) {
					t.Fatalf("opaque projection identity changed: got=%v want=%v", result["runtime_recovery"], expected)
				}
			})
		}
	}
}

func consoleRuntimeRecoveryOpaqueJSONCases() []struct {
	name, raw, decoded string
	valid              bool
} {
	return []struct {
		name, raw, decoded string
		valid              bool
	}{
		{name: "isolated-high-surrogate", raw: `"\ud800"`},
		{name: "isolated-low-surrogate", raw: `"\udc00"`},
		{name: "high-followed-by-non-low", raw: `"\ud800\u0041"`},
		{name: "paired-supplementary", raw: `"\ud83e\uddea"`, decoded: "🧪", valid: true},
		{name: "literal-replacement-character", raw: `"�"`, decoded: "�", valid: true},
		{name: "literal-backslash-sequence", raw: `"\\ud800"`, decoded: `\ud800`, valid: true},
		{name: "escaped-nul", raw: `"\u0000"`, decoded: "\x00", valid: true},
	}
}
