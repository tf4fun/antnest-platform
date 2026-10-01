package docker

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
)

func TestDockerAbsenceTraceFollowsCreationSemantics(t *testing.T) {
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	previous := otel.GetTracerProvider()
	otel.SetTracerProvider(provider)
	t.Cleanup(func() {
		otel.SetTracerProvider(previous)
		if err := provider.Shutdown(context.Background()); err != nil {
			t.Error(err)
		}
	})
	for _, tc := range []struct {
		name                                        string
		ensure, missingRequired, missingAfterCreate bool
		want404                                     []codes.Code
		wantCompleted                               bool
	}{
		{"ensure fresh storage", true, false, false, []codes.Code{codes.Unset}, true},
		{"create fresh container", false, false, false, []codes.Code{codes.Unset}, true},
		{"required storage missing", false, true, false, []codes.Code{codes.Error}, false},
		{"post-create storage missing", true, false, true, []codes.Code{codes.Unset, codes.Error}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			recorder.Reset()
			volumeExists := !tc.ensure
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch {
				case r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/volumes/"):
					if tc.missingRequired || !volumeExists || tc.missingAfterCreate {
						w.WriteHeader(http.StatusNotFound)
						return
					}
					_ = json.NewEncoder(w).Encode(map[string]any{"Name": workspaceVolume("agent-1"), "Labels": map[string]string{
						labelManaged: "workspace", labelScope: "test-controller", labelAgentID: "agent-1",
					}})
				case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/volumes/create"):
					volumeExists = true
					w.WriteHeader(http.StatusCreated)
					_, _ = w.Write([]byte(`{"Name":"antnest-workspace-agent-1"}`))
				case r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/containers/"):
					w.WriteHeader(http.StatusNotFound)
				case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/containers/create"):
					w.WriteHeader(http.StatusCreated)
					_, _ = w.Write([]byte(`{"Id":"container-created"}`))
				case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/start"):
					w.WriteHeader(http.StatusNoContent)
				default:
					t.Errorf("unexpected Docker request %s %s", r.Method, r.URL.Path)
					w.WriteHeader(500)
				}
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
			var outcome deployment.EffectOutcome
			if tc.ensure {
				outcome = driver.EnsureStorage(context.Background(), "agent-1")
			} else {
				outcome = driver.Create(context.Background(), testDeployment(), testDigest)
			}
			if (outcome.State == deployment.EffectCompleted) != tc.wantCompleted {
				t.Fatalf("outcome: %+v", outcome)
			}
			var found []sdktrace.ReadOnlySpan
			for _, span := range recorder.Ended() {
				for _, a := range span.Attributes() {
					if a.Key == "http.response.status_code" && a.Value.AsInt64() == 404 {
						found = append(found, span)
					}
				}
			}
			if len(found) != len(tc.want404) {
				t.Fatalf("404 spans = %d, want %d", len(found), len(tc.want404))
			}
			for i, span := range found {
				if span.Status().Code != tc.want404[i] {
					t.Errorf("404 #%d status = %v, want %v", i, span.Status().Code, tc.want404[i])
				}
				if tc.want404[i] == codes.Unset {
					absent := false
					for _, a := range span.Attributes() {
						if a.Key == "antnest.outcome" && a.Value.AsString() == "absent" {
							absent = true
						}
						if a.Key == "error.type" {
							t.Error("expected absence has error.type")
						}
					}
					if !absent || len(span.Events()) != 0 {
						t.Error("expected absence needs outcome and no error event")
					}
				}
			}
		})
	}
	t.Run("inspect semantics", func(t *testing.T) {
		testInspectAbsenceTraceMatchesReadOnlyResult(t, recorder)
	})
}
