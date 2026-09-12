package server

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"soft/antnest-platform/services/agent-controller/internal/telemetry"
)

func TestControllerParsedRPCContentSwitch(t *testing.T) {
	const valid = `{"request_id":"request-17","organization_id":"org-4","template_key":"assistant","model_profile_id":"model-rev-9","max_model_requests":23,"system_prompt":"secret-canary","runtime":{"image_ref":"repo/runtime@sha256:abcd","resources":{"memory_bytes":536870912,"pids_limit":128,"tmpfs_bytes":16777216},"mcp_servers":[{"id":"tool","command":"secret-canary","args":["secret-canary"],"env":{"TOKEN":"secret-canary"}}]}}`
	for _, scenario := range []struct {
		name, body, mode, encoding string
		visible                    bool
	}{
		{"enabled", valid, "true", "", true},
		{"disabled", valid, "false", "", false},
		{"incomplete", strings.TrimSuffix(valid, "}"), "true", "", false},
		{"unknown", `{"secret":"canary"}`, "true", "", false},
		{"large", strings.Replace(valid, "secret-canary", strings.Repeat("canary", 4000), 1), "true", "", true},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			t.Setenv("ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT", scenario.mode)
			recorder := networkPolicyTraceRecorder(t)
			mux := http.NewServeMux()
			mux.Handle("POST /internal/agent-templates", telemetry.RPCHandler("create_template", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var input createTemplateRequest
				if !decodeJSON(w, r, &input) {
					return
				}
				writeJSON(w, http.StatusCreated, templateResponse{TemplateID: "template-8", Revision: 3, ModelProfileID: input.ModelProfileID, MaxModelRequests: input.MaxModelRequests, Runtime: input.Runtime})
			})))
			request := httptest.NewRequest(http.MethodPost, "/internal/agent-templates?code=secret-canary", strings.NewReader(scenario.body))
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("Content-Encoding", scenario.encoding)
			request.Header.Set("Cookie", "secret-canary")
			response := httptest.NewRecorder()
			telemetry.HTTPHandler(mux, slog.New(slog.NewTextHandler(io.Discard, nil))).ServeHTTP(response, request)
			spans := recorder.Ended()
			if len(spans) != 1 {
				t.Fatalf("spans=%d", len(spans))
			}
			visible := false
			for _, event := range spans[0].Events() {
				for _, attr := range event.Attributes {
					if scenario.visible && event.Name == "antnest.request" && string(attr.Key) == "antnest.payload.json" && !strings.Contains(attr.Value.AsString(), "canary") {
						t.Fatal("RPC contents were projected")
					}
					if event.Name == "antnest.request" && string(attr.Key) == "antnest.payload.json" {
						visible = strings.Contains(attr.Value.AsString(), "model-rev-9") && strings.Contains(attr.Value.AsString(), "536870912")
					}

				}
			}
			if visible != scenario.visible {
				t.Fatalf("request content visible=%v want=%v", visible, scenario.visible)
			}
		})
	}
}
