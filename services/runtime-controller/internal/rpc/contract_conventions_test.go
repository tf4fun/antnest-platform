package rpc

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
)

var contractConventionActions = []struct {
	name       string
	kind       deployment.OperationKind
	withConfig bool
}{
	{name: "update", kind: deployment.OperationUpdateRuntime, withConfig: true},
	{name: "enable", kind: deployment.OperationEnableRuntime, withConfig: true},
	{name: "disable", kind: deployment.OperationDisableRuntime},
	{name: "delete", kind: deployment.OperationDeleteRuntime},
}

func contractConventionsBody(withConfig bool, fields map[string]any) []byte {
	body := map[string]any{}
	for key, value := range fields {
		body[key] = value
	}
	if withConfig {
		body["configuration"] = map[string]any{}
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		panic(err)
	}
	return encoded
}

func contractConventionsRequest(action, agent string, body []byte, ifMatch string) *http.Request {
	request := httptest.NewRequest(http.MethodPost, "/internal/runtimes/"+agent+"/"+action, bytes.NewReader(body))
	request.Header.Set("Idempotency-Key", "request-1")
	if ifMatch != "" {
		request.Header.Set("If-Match", ifMatch)
	}
	return request
}

func contractConventionsService() *fakeService {
	return &fakeService{operation: deployment.Operation{
		RequestID: "request-1", AgentID: "agent-1", RuntimeRevision: testRuntimeRevision,
		State: deployment.OperationCompleted, Effect: deployment.EffectCompleted,
	}}
}

func TestContractConventionsAcceptsPreconditionForms(t *testing.T) {
	for _, action := range contractConventionActions {
		for _, form := range []struct {
			name    string
			fields  map[string]any
			ifMatch string
		}{
			{name: "canonical", fields: map[string]any{"expected_version": string(testRuntimeRevision)}},
			{name: "legacy", fields: map[string]any{"expected_revision": string(testRuntimeRevision)}},
			{name: "if_match", fields: map[string]any{}, ifMatch: `"` + string(testRuntimeRevision) + `"`},
		} {
			t.Run(action.name+"/"+form.name, func(t *testing.T) {
				service := contractConventionsService()
				handler := newTestHandler(t, service)
				response := httptest.NewRecorder()
				handler.ServeHTTP(response, contractConventionsRequest(action.name, "agent-1",
					contractConventionsBody(action.withConfig, form.fields), form.ifMatch))
				if response.Code != http.StatusOK ||
					service.command != action.kind ||
					service.expectedRevision != testRuntimeRevision ||
					service.agentID != "agent-1" {
					t.Fatalf("response=%d command=%s revision=%s agent=%s body=%s",
						response.Code, service.command, service.expectedRevision, service.agentID,
						response.Body.String())
				}
				if !strings.Contains(response.Body.String(), `"request_id":"request-1"`) {
					t.Fatalf("idempotency receipt missing: %s", response.Body.String())
				}
			})
		}
	}
}

func TestContractConventionsRejectsInvalidPreconditions(t *testing.T) {
	for _, action := range contractConventionActions {
		cases := []struct {
			name    string
			fields  map[string]any
			raw     string
			ifMatch string
		}{
			{name: "missing"},
			{name: "null", fields: map[string]any{"expected_version": nil}},
			{name: "numeric", fields: map[string]any{"expected_version": 1}},
			{name: "empty", fields: map[string]any{"expected_version": ""}},
			{name: "overlong", fields: map[string]any{"expected_version": strings.Repeat("a", 129)}},
			{name: "bad_grammar", fields: map[string]any{"expected_version": "not-a-revision"}},
			{name: "bad_rtv", fields: map[string]any{"expected_version": "rtv_0123"}},
			{name: "aliases_equal", fields: map[string]any{
				"expected_version": string(testRuntimeRevision), "expected_revision": string(testRuntimeRevision)}},
			{name: "aliases_differ", fields: map[string]any{
				"expected_version": "rtv_ffffffffffffffffffffffffffffffff", "expected_revision": string(testRuntimeRevision)}},
			{name: "canonical_and_header", fields: map[string]any{
				"expected_version": string(testRuntimeRevision)}, ifMatch: `"` + string(testRuntimeRevision) + `"`},
			{name: "legacy_and_header", fields: map[string]any{
				"expected_revision": string(testRuntimeRevision)}, ifMatch: `"` + string(testRuntimeRevision) + `"`},
			{name: "duplicate_keys", raw: `{"expected_version":"` + string(testRuntimeRevision) + `","expected_version":"` + string(testRuntimeRevision) + `"`},
			{name: "unknown_field", fields: map[string]any{
				"expected_version": string(testRuntimeRevision), "unrelated": 1}},
			{name: "weak_tag", ifMatch: `W/"` + string(testRuntimeRevision) + `"`},
			{name: "wildcard", ifMatch: `*`},
			{name: "tag_list", ifMatch: `"` + string(testRuntimeRevision) + `", "` + string(testRuntimeRevision) + `"`},
			{name: "control_header", ifMatch: "\"rev\tevision\""},
			{name: "backslash_header", ifMatch: `"rev\ision"`},
			{name: "repeated_header", ifMatch: "repeat"},
		}
		for _, test := range cases {
			t.Run(action.name+"/"+test.name, func(t *testing.T) {
				service := contractConventionsService()
				handler := newTestHandler(t, service)
				body := test.raw
				if body == "" {
					body = string(contractConventionsBody(action.withConfig, test.fields))
				}
				request := contractConventionsRequest(action.name, "agent-1", []byte(body), "")
				if test.ifMatch == "repeat" {
					request.Header.Add("If-Match", `"`+string(testRuntimeRevision)+`"`)
					request.Header.Add("If-Match", `"`+string(testRuntimeRevision)+`"`)
				} else {
					request.Header.Set("If-Match", test.ifMatch)
				}
				response := httptest.NewRecorder()
				handler.ServeHTTP(response, request)
				if response.Code != http.StatusBadRequest {
					t.Fatalf("response=%d body=%s", response.Code, response.Body.String())
				}
				if service.command != "" || service.agentID != "" {
					t.Fatalf("mutation recorded: command=%s agent=%s", service.command, service.agentID)
				}
			})
		}
	}
}
