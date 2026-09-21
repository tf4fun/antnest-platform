package docker

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	"soft/antnest-platform/services/runtime-controller/internal/deployment"
)

func testInspectAbsenceTraceMatchesReadOnlyResult(t *testing.T, recorder *tracetest.SpanRecorder) {
	for _, tc := range []struct {
		name   string
		status int
		direct bool
	}{
		{"driver missing source", http.StatusNotFound, false},
		{"driver forbidden", http.StatusForbidden, false},
		{"driver server failure", http.StatusInternalServerError, false},
		{"generic client missing source", http.StatusNotFound, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			recorder.Reset()
			calls := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				if r.Method != http.MethodGet || r.URL.Path != "/v1.47/containers/antnest-runtime-agent-1/json" {
					t.Errorf("unexpected Docker request: %s %s", r.Method, r.URL.Path)
				}
				w.WriteHeader(tc.status)
			}))
			defer server.Close()
			client, err := NewHTTPClient(server.Client(), server.URL)
			if err != nil {
				t.Fatal(err)
			}
			driver, err := NewDriver(client, testDriverConfig())
			if err != nil {
				t.Fatal(err)
			}
			var result deployment.Inspection
			if tc.direct {
				_, err = client.InspectContainer(context.Background(), "antnest-runtime-agent-1")
			} else {
				result, err = driver.Inspect(context.Background(), deployment.Key{AgentID: "agent-1", Generation: 7})
			}
			absent := tc.status == http.StatusNotFound && !tc.direct
			if absent {
				if err != nil || result.AgentID != "agent-1" || result.Generation != 7 ||
					result.PlatformPhase != deployment.PhaseAbsent || result.Health != deployment.HealthAbsent ||
					result.RuntimeExecutionID != "" || result.MCPEndpoint != "" || result.ObservedAt.IsZero() {
					t.Fatalf("unexpected absent inspection: %+v, %v", result, err)
				}
			} else if err == nil {
				t.Fatal("failure was suppressed")
			}
			spans := recorder.Ended()
			if calls != 1 || len(spans) != 1 {
				t.Fatalf("calls=%d spans=%d", calls, len(spans))
			}
			span := spans[0]
			attrs := map[string]any{}
			for _, a := range span.Attributes() {
				attrs[string(a.Key)] = a.Value.AsInterface()
			}
			if attrs["http.response.status_code"] != int64(tc.status) {
				t.Fatal("wire status was rewritten")
			}
			if absent {
				if span.Status().Code != codes.Unset || attrs["antnest.outcome"] != "absent" ||
					attrs["antnest.error.code"] != nil || attrs["error.type"] != nil || len(span.Events()) != 0 {
					t.Errorf("absence marked as failure: status=%v attrs=%v events=%v", span.Status(), attrs, span.Events())
				}
			} else if span.Status().Code != codes.Error || attrs["antnest.outcome"] == "absent" || len(span.Events()) == 0 {
				t.Error("unexpected HTTP failure lost its error evidence")
			}
		})
	}
}
