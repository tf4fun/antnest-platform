package server

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/identity"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/telemetry"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
)

func TestBrowserFeedTerminationRecordsOnlyTheWinningCause(t *testing.T) {
	for _, scenario := range []string{"feed", "duplicate", "parent-first", "wrong-user", "wrong-org", "wrong-sid", "invalid-diagnostics", "normal-end"} {
		t.Run(scenario, func(t *testing.T) {
			previous, propagationBefore := otel.GetTracerProvider(), otel.GetTextMapPropagator()
			recorder := tracetest.NewSpanRecorder()
			provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
			otel.SetTracerProvider(provider)
			otel.SetTextMapPropagator(propagation.TraceContext{})
			defer func() {
				_ = provider.Shutdown(context.Background())
				otel.SetTracerProvider(previous)
				otel.SetTextMapPropagator(propagationBefore)
			}()
			returnUpstream := make(chan struct{})
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				_, _ = io.WriteString(w, "data: ready\n\n")
				_ = http.NewResponseController(w).Flush()
				select {
				case <-r.Context().Done():
				case <-returnUpstream:
				}
			}))
			defer upstream.Close()
			principal := ordinaryPrincipal()
			principal.SessionID = "private-sid-canary"
			principal.CallerContext = "private-cct-canary"
			h := newNetworkBridgeTestHandler(t, &identityServiceStub{resolvePrincipal: principal}, upstream)
			ready := make(chan context.CancelFunc, 1)
			done := make(chan struct{})
			observed := telemetry.HTTPHandler(h, slog.New(slog.NewTextHandler(io.Discard, nil)))
			edge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				defer close(done)
				ctx, cancel := context.WithCancel(r.Context())
				defer cancel()
				ready <- cancel
				observed.ServeHTTP(w, r.WithContext(ctx))
			}))
			defer edge.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			request, _ := http.NewRequestWithContext(ctx, http.MethodGet, edge.URL+"/api/app/workspace/v1/agents/agent-1/events", nil)
			addSessionCookies(request, "private-cookie-canary", testCSRFToken)
			response, err := edge.Client().Do(request)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			if response.StatusCode != 200 {
				t.Fatalf("stream status=%d", response.StatusCode)
			}
			if _, err := io.ReadFull(response.Body, make([]byte, len("data: ready\n\n"))); err != nil {
				t.Fatal(err)
			}
			parentCancel := <-ready
			defer parentCancel()
			event := identity.SessionRevocation{Sequence: 7, TokenID: principal.SessionID, UserID: principal.UserID,
				OrganizationID: principal.OrganizationID, Reason: "membership_deactivated", OccurredAt: time.Now(),
				TraceParent: "00-11111111111111111111111111111111-2222222222222222-01"}
			want := scenario == "feed" || scenario == "duplicate" || scenario == "invalid-diagnostics"
			if scenario == "parent-first" {
				parentCancel()
			}
			if scenario == "wrong-user" {
				event.UserID = "foreign-user"
			}
			if scenario == "wrong-org" {
				event.OrganizationID = "foreign-org"
			}
			if scenario == "wrong-sid" {
				event.TokenID = "foreign-sid"
			}
			if scenario == "invalid-diagnostics" {
				event.Reason = "private-reason-canary"
				event.TraceParent = "private-traceparent-canary"
			}
			before := time.Now()
			if scenario != "normal-end" {
				h.browserStreams.Revoke(event)
			}
			after := time.Now()
			if scenario == "duplicate" {
				event.Reason = "password_changed"
				event.TraceParent = "00-33333333333333333333333333333333-4444444444444444-01"
				h.browserStreams.Revoke(event)
			}
			if !want && scenario != "parent-first" {
				close(returnUpstream)
			}
			_, _ = io.Copy(io.Discard, response.Body)
			select {
			case <-done:
			case <-ctx.Done():
				t.Fatal("stream did not finish")
			}
			var root sdktrace.ReadOnlySpan
			for _, span := range recorder.Ended() {
				if span.SpanKind() == trace.SpanKindServer {
					if root != nil {
						t.Fatal("duplicate SERVER")
					}
					root = span
				}
			}
			if root == nil {
				t.Fatal("original stream SERVER missing")
			}
			var events []sdktrace.Event
			for _, item := range root.Events() {
				if item.Name == "antnest.stream.termination" {
					events = append(events, item)
				}
			}
			if !want {
				if len(events) != 0 {
					t.Fatal("unrelated or losing feed event claimed stream termination")
				}
				return
			}
			if len(events) != 1 {
				t.Fatalf("winning feed cancellation has %d termination events", len(events))
			}
			item := events[0]
			if item.Time.Before(before) || item.Time.After(after) || item.Time.Before(root.StartTime()) || item.Time.After(root.EndTime()) {
				t.Fatal("termination event is outside its actual cancellation interval")
			}
			values := map[string]string{}
			for _, attr := range item.Attributes {
				values[string(attr.Key)] = attr.Value.Emit()
				if strings.Contains(attr.Value.Emit(), "canary") {
					t.Fatal("private diagnostics leaked")
				}
			}
			for key, value := range map[string]string{"source": "identity-session-feed", "reason": "session_revoked",
				"antnest.organization.id": principal.OrganizationID, "antnest.principal.id": principal.UserID,
				"antnest.membership.id": principal.MembershipID, "antnest.agent.id": "agent-1", "antnest.revocation.sequence": "7"} {
				if values[key] != value {
					t.Fatalf("termination attribute %s=%q", key, values[key])
				}
			}
			if scenario == "invalid-diagnostics" {
				if values["antnest.revocation.reason"] != "unknown" || values["antnest.revocation.trace_id"] != "" || values["antnest.revocation.span_id"] != "" {
					t.Fatal("invalid feed diagnostics were trusted")
				}
			} else if values["antnest.revocation.reason"] != "membership_deactivated" || values["antnest.revocation.trace_id"] != "11111111111111111111111111111111" || values["antnest.revocation.span_id"] != "2222222222222222" {
				t.Fatal("actual winning mutation source changed")
			}
		})
	}
}
