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

	"github.com/tf4fun/antnest-platform/services/admin-console/internal/principal"
	"github.com/tf4fun/antnest-platform/services/admin-console/internal/upstream"
)

func scopedLifecycleRequest(method, path, body, organization string) *http.Request {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header.Set(principal.HeaderUserID, "user-admin")
	request.Header.Set(principal.HeaderOrganizationID, organization)
	request.Header.Set(principal.HeaderMembershipID, "membership-1")
	request.Header.Set(principal.HeaderSystemRole, "admin")
	request.Header.Set(principal.HeaderOrganizationRole, "admin")
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Idempotency-Key", "one-lifecycle-intent")
	return request
}

func TestLifecycleRetryIdentitySurvivesHandlerReplacement(t *testing.T) {
	cases := []struct {
		kind string
		path string
		body string
	}{
		{"create", "/agents", `{"owner_user_id":"owner-1","name":"Agent","template_id":"template-1","template_revision":7}`},
		{"rebuild", "/agents/agent-1/rebuild", `{"template_id":"template-1","template_revision":7}`},
		{"disable", "/agents/agent-1/disable", `{}`},
		{"enable", "/agents/agent-1/enable", `{}`},
		{"delete", "/agents/agent-1/delete", `{}`},
	}
	for _, scenario := range cases {
		t.Run(scenario.kind, func(t *testing.T) {
			backend := newBackendStub()
			operation := fmt.Sprintf(`{"request_id":"request-1","agent_id":"agent-1","kind":%q,"state":"running","phase":"drain"}`, scenario.kind)
			result := operation
			if scenario.kind == "create" {
				result = `{"agent":{"agent_id":"agent-1"},"operation":` + operation + `}`
			}
			backend.enqueueFor("/internal"+scenario.path, http.StatusAccepted, result)
			handler := newTestHandler(t, backend)
			var baseline map[string]any
			for index, organization := range []string{"org-1", "org-1", "org-1", "org-2"} {
				if index == 2 {
					handler = newTestHandler(t, backend)
				}
				request := scopedLifecycleRequest(http.MethodPost, "/api/admin"+scenario.path, scenario.body, organization)
				response := httptest.NewRecorder()
				handler.ServeHTTP(response, request)
				if response.Code != http.StatusAccepted || !strings.Contains(response.Body.String(), `"state":"running"`) {
					t.Fatalf("admission changed: status=%d body=%s", response.Code, response.Body.String())
				}
				if len(backend.calls) != index+1 {
					t.Fatalf("retry generated extra calls: %d", len(backend.calls))
				}
				call := backend.calls[index]
				if call.Target != upstream.AgentController || call.Method != http.MethodPost || call.Path != "/internal"+scenario.path {
					t.Fatalf("unexpected authority: %+v", call)
				}
				var payload map[string]any
				decodeBytes(t, call.Body, &payload)
				if payload["organization_id"] != organization || payload["actor_principal_id"] != "user-admin" {
					t.Fatalf("untrusted scope: %v", payload)
				}
				if scenario.kind == "create" || scenario.kind == "rebuild" {
					if payload["template_id"] != "template-1" || payload["template_revision"] != float64(7) {
						t.Fatalf("frozen revision changed: %v", payload)
					}
				}
				switch index {
				case 0:
					baseline = payload
				case 1, 2:
					if !reflect.DeepEqual(payload, baseline) {
						t.Fatalf("replay changed identity or input: before=%v after=%v", baseline, payload)
					}
				case 3:
					if payload["request_id"] == baseline["request_id"] {
						t.Fatal("different organizations shared a request identity")
					}
				}
			}
		})
	}
}

func TestOperationReadPreservesAuthorityAndFailureEvidence(t *testing.T) {
	for _, state := range []string{"running", "completed", "failed"} {
		t.Run(state, func(t *testing.T) {
			backend := newBackendStub()
			expected := map[string]any{
				"request_id": "request-1", "agent_id": "agent-1", "kind": "create",
				"phase": "runtime_initialize", "state": state,
				"created_at": "2026-09-10T00:00:00Z", "updated_at": "2026-09-10T00:00:01Z",
			}
			if state == "failed" {
				expected["error_code"] = "runtime_initialize_failed"
				expected["error_detail"] = "Runtime image unavailable"
			}
			payload := make(map[string]any)
			for key, value := range expected {
				payload[key] = value
			}
			payload["organization_id"] = "org-1"
			payload["request_fingerprint"] = "private-fingerprint"
			encoded, err := json.Marshal(payload)
			if err != nil {
				t.Fatal(err)
			}
			backend.enqueue(http.StatusOK, string(encoded))
			handler := newTestHandler(t, backend)
			response := requestAdmin(t, handler, http.MethodGet, "/api/admin/operations/request-1?organization_id=forged", "")
			var actual map[string]any
			decodeBytes(t, response.Body.Bytes(), &actual)
			if response.Code != http.StatusOK || !reflect.DeepEqual(actual, expected) {
				t.Fatalf("operation evidence changed: status=%d body=%v", response.Code, actual)
			}
			call := backend.singleCall(t)
			if call.Query != "organization_id=org-1" || call.Path != "/internal/agent-operations/request-1" {
				t.Fatalf("operation scope changed: %+v", call)
			}
			backend.enqueue(http.StatusNotFound, `{"code":"operation_not_found"}`)
			response = httptest.NewRecorder()
			handler.ServeHTTP(response, scopedLifecycleRequest(http.MethodGet, "/api/admin/operations/request-1", "", "org-2"))
			if response.Code != http.StatusNotFound || backend.calls[1].Query != "organization_id=org-2" {
				t.Fatalf("foreign operation reused cached evidence: status=%d call=%+v", response.Code, backend.calls[1])
			}
		})
	}
}

const replayEvent = `{"event_id":"event-9","global_sequence":109,"aggregate_sequence":9,"schema_version":1,"agent_id":"agent-1","event_type":"agent_ready","operation_request_id":"request-1","trace_id":"trace-1","occurred_at":"2026-09-10T00:00:00Z"}`

func upstreamReplayEvent(t *testing.T) string {
	t.Helper()
	var payload map[string]any
	decodeBytes(t, []byte(replayEvent), &payload)
	payload["organization_id"] = "private-organization"
	payload["future_private_field"] = "must-not-reach-browser"
	payload["data"] = map[string]string{"mcp_endpoint": "http://private-runtime"}
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

func TestEventListPreservesGlobalCursorAndSafeEnvelope(t *testing.T) {
	backend := newBackendStub()
	backend.enqueue(http.StatusOK, `{"events":[`+upstreamReplayEvent(t)+`],"next_sequence":109}`)
	response := requestAdmin(t, newTestHandler(t, backend), http.MethodGet,
		"/api/admin/agents/agent-1/events?after_sequence=107&limit=200&organization_id=forged", "")
	var actual, expected map[string]any
	decodeBytes(t, response.Body.Bytes(), &actual)
	decodeBytes(t, []byte(`{"events":[`+replayEvent+`],"next_sequence":109}`), &expected)
	if response.Code != http.StatusOK || !reflect.DeepEqual(actual, expected) {
		t.Fatalf("event evidence changed: status=%d body=%v", response.Code, actual)
	}
	call := backend.singleCall(t)
	if call.Query != "after_sequence=107&limit=200&organization_id=org-1" {
		t.Fatalf("global cursor or scope lost: %s", call.Query)
	}
}

func TestEventWatchResumesAtLastEventID(t *testing.T) {
	for _, header := range []string{"", "0", "108", " 108 "} {
		t.Run(header, func(t *testing.T) {
			backend := newBackendStub()
			backend.enqueue(http.StatusOK, "id: 109\nevent: agent_event\ndata: "+upstreamReplayEvent(t)+"\n\n")
			request := scopedLifecycleRequest(http.MethodGet,
				"/api/admin/agents/agent-1/events/watch?after_sequence=107&organization_id=forged", "", "org-1")
			expectedCursor := "107"
			if header != "" {
				request.Header.Set("Last-Event-ID", header)
				expectedCursor = strings.TrimSpace(header)
			}
			response := httptest.NewRecorder()
			newTestHandler(t, backend).ServeHTTP(response, request)
			call := backend.singleCall(t)
			query, err := url.ParseQuery(call.Query)
			if err != nil {
				t.Fatal(err)
			}
			if query.Get("after_sequence") != expectedCursor || query.Get("organization_id") != "org-1" {
				t.Fatalf("reconnect cursor lost: query=%s expected=%s", call.Query, expectedCursor)
			}
			if response.Code != http.StatusOK || !strings.HasPrefix(response.Body.String(), "id: 109\nevent: agent_event\ndata: ") {
				t.Fatalf("SSE envelope lost: %s", response.Body.String())
			}
			var actual, expected map[string]any
			payload := strings.TrimSpace(strings.SplitN(response.Body.String(), "data: ", 2)[1])
			decodeBytes(t, []byte(payload), &actual)
			decodeBytes(t, []byte(replayEvent), &expected)
			if !reflect.DeepEqual(actual, expected) {
				t.Fatalf("SSE event changed: %v", actual)
			}
		})
	}
}

func TestEventWatchRejectsInvalidLastEventID(t *testing.T) {
	for _, values := range [][]string{{""}, {"-1"}, {"one"}, {"9223372036854775808"}, {"10", "11"}} {
		t.Run(fmt.Sprint(values), func(t *testing.T) {
			backend := newBackendStub()
			request := scopedLifecycleRequest(http.MethodGet, "/api/admin/agents/agent-1/events/watch?after_sequence=107", "", "org-1")
			request.Header["Last-Event-Id"] = values
			response := httptest.NewRecorder()
			newTestHandler(t, backend).ServeHTTP(response, request)
			if response.Code != http.StatusBadRequest || len(backend.calls) != 0 {
				t.Fatalf("invalid cursor restarted replay: status=%d calls=%v", response.Code, backend.calls)
			}
		})
	}
}
