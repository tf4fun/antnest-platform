package server

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"

	"soft/antnest-platform/services/edge-gateway/internal/agentacp"
	"soft/antnest-platform/services/edge-gateway/internal/identity"
	"soft/antnest-platform/services/edge-gateway/internal/telemetry"
)

func TestWorkspaceStateHTTPDisconnectCancelsACPReceive(t *testing.T) {
	t.Parallel()
	stopped := make(chan struct{})
	acp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(stopped)
		w.Header().Set("Content-Type", "text/event-stream")
		state, _ := json.Marshal(readyState())
		// Partial network writes must not become partial browser snapshots.
		for _, piece := range []string{"event: work", "space_state\ndata: ", string(state), "\n\n"} {
			if _, err := io.WriteString(w, piece); err != nil {
				return
			}
			if err := http.NewResponseController(w).Flush(); err != nil {
				return
			}
		}
		<-r.Context().Done()
	}))
	defer acp.Close()
	agents, err := agentacp.NewClient(acp.URL, acp.Client())
	if err != nil {
		t.Fatal(err)
	}
	h := newTestHandlerWithServices(t, &identityServiceStub{resolvePrincipal: ordinaryPrincipal()}, &agentServiceStub{listErr: context.DeadlineExceeded}, agents, http.NotFoundHandler(), time.Now(), Config{})
	edge := httptest.NewServer(h)
	defer edge.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	r := stateRequest("/watch").WithContext(ctx)
	r.URL.Scheme = "http"
	r.URL.Host = strings.TrimPrefix(edge.URL, "http://")
	r.RequestURI = ""
	response, err := edge.Client().Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = response.Body.Close() }()
	reader := bufio.NewReader(response.Body)
	var frame strings.Builder
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatal(err)
		}
		frame.WriteString(line)
		if line == "\n" {
			break
		}
	}
	if response.StatusCode != 200 || !strings.Contains(frame.String(), `"configuration_revision":"`+strings.Repeat("a", 64)+`"`) {
		t.Fatalf("response=%d frame=%s", response.StatusCode, frame.String())
	}
	cancel()
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("ACP receive survived browser disconnect")
	}
}

func TestWorkspaceStateHTTPChainPreservesTraceAndStripsBrowserCredentials(t *testing.T) {
	previousProvider := otel.GetTracerProvider()
	previousPropagator := otel.GetTextMapPropagator()
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	otel.SetTracerProvider(provider)
	otel.SetTextMapPropagator(propagation.TraceContext{})
	t.Cleanup(func() {
		_ = provider.Shutdown(context.Background())
		otel.SetTracerProvider(previousProvider)
		otel.SetTextMapPropagator(previousPropagator)
	})
	for _, suffix := range []string{"", "/watch"} {
		t.Run(suffix, func(t *testing.T) {
			traceID := "4bf92f3577b34da6a3ce929d0e0e4736"
			if suffix != "" {
				traceID = "5bf92f3577b34da6a3ce929d0e0e4736"
			}
			acpCalls := 0
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Cookie") != "" || r.Header.Get("Authorization") != "" || r.Header.Get(HeaderUserID) != "" {
					t.Error("browser credentials or forged scope forwarded")
				}
				if !strings.Contains(r.Header.Get("traceparent"), traceID) {
					t.Error("missing trace context")
				}
				w.Header().Set("Content-Type", "application/json")
				if r.URL.Path == "/rpc/identity/resolve-access-token" {
					if err := json.NewEncoder(w).Encode(map[string]any{"principal": ordinaryPrincipal()}); err != nil {
						t.Error(err)
					}
					return
				}
				acpCalls++
				principal := ordinaryPrincipal()
				if r.Header.Get(HeaderOrganizationID) != principal.OrganizationID || r.Header.Get(HeaderPrincipalID) != principal.UserID || r.Header.Get(HeaderAgentID) != "agent-1" {
					t.Error("untrusted scope")
				}
				state := readyState()
				if suffix == "" {
					if err := json.NewEncoder(w).Encode(state); err != nil {
						t.Error(err)
					}
					return
				}
				w.Header().Set("Content-Type", "text/event-stream")
				first, _ := json.Marshal(state)
				state.AccessAllowed = false
				state.Availability = "offline"
				state.ConfigurationRevision = nil
				state.UnavailableReason = stateText("access_denied")
				last, _ := json.Marshal(state)
				if _, err := fmt.Fprintf(w, "event: workspace_state\ndata: %s\n\nevent: workspace_state\ndata: %s\n\n", first, last); err != nil {
					t.Error(err)
				}
			}))
			defer upstream.Close()
			client := &http.Client{Transport: telemetry.NewHTTPTransport(upstream.Client().Transport)}
			agents, err := agentacp.NewClient(upstream.URL, client)
			if err != nil {
				t.Fatal(err)
			}
			identities, err := identity.NewClient(upstream.URL, client)
			if err != nil {
				t.Fatal(err)
			}
			h := newTestHandlerWithServices(t, identities, &agentServiceStub{listErr: context.DeadlineExceeded}, agents, http.NotFoundHandler(), time.Now(), Config{})
			r := stateRequest(suffix)
			r.Header.Set("traceparent", "00-"+traceID+"-00f067aa0ba902b7-01")
			r.Header.Set("Authorization", "Bearer private-browser-token")
			r.Header.Set(HeaderUserID, "forged")
			w := httptest.NewRecorder()
			telemetry.HTTPHandler(h, slog.New(slog.NewTextHandler(io.Discard, nil))).ServeHTTP(w, r)
			if w.Code != 200 || acpCalls != 1 {
				t.Fatalf("response=%d %s calls=%d", w.Code, w.Body, acpCalls)
			}
			assertWorkspaceTrace(t, recorder.Ended(), traceID, suffix)
		})
	}
}

func assertWorkspaceTrace(t *testing.T, spans []sdktrace.ReadOnlySpan, traceID, suffix string) {
	t.Helper()
	var root trace.SpanID
	var selected []sdktrace.ReadOnlySpan
	for _, span := range spans {
		if span.SpanContext().TraceID().String() == traceID {
			selected = append(selected, span)
			if span.SpanKind() == trace.SpanKindServer {
				root = span.SpanContext().SpanID()
			}
		}
	}
	want := 3
	if suffix != "" {
		want = 4
	}
	if !root.IsValid() || len(selected) != want {
		t.Fatalf("trace spans=%d want=%d root=%s", len(selected), want, root)
	}
	for _, span := range selected {
		if span.SpanKind() == trace.SpanKindClient && span.Parent().SpanID() != root {
			t.Fatalf("detached client %s", span.Name())
		}
		if span.SpanKind() == trace.SpanKindServer && span.Parent().SpanID().String() != "00f067aa0ba902b7" {
			t.Fatal("lost incoming parent")
		}
		for _, attr := range span.Attributes() {
			if strings.Contains(attr.Value.String(), "private-browser-token") {
				t.Fatal("credential in trace")
			}
		}
	}
}

func TestWorkspaceStateReconnectsAfterSourceFailureWithoutController(t *testing.T) {
	t.Parallel()
	var calls atomic.Int32
	failureReleased := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/rpc/agent-acp/watch-agent-execution-state" || r.Method != http.MethodPost {
			t.Errorf("unexpected route: %s %s", r.Method, r.URL.Path)
		}
		state := readyState()
		first := calls.Add(1) == 1
		if first {
			state.Availability = "busy"
			state.ActiveSessionID = stateText("session-1")
		}
		payload, err := json.Marshal(state)
		if err != nil {
			t.Error(err)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		if _, err := fmt.Fprintf(w, "event: workspace_state\ndata: %s\n\n", payload); err != nil {
			t.Error(err)
			return
		}
		if first {
			_, err = io.WriteString(w, "event: workspace_error\ndata: {\"code\":\"execution_state_unavailable\",\"message\":\"private storage detail\",\"retryable\":true}\n\n")
		} else {
			_, err = io.WriteString(w, "event: workspace_state\ndata: {\"agent_id\":\"agent-1\",\"availability\":\"offline\",\"access_allowed\":false,\"configuration_revision\":null,\"active_session_id\":null,\"unavailable_reason\":\"access_denied\"}\n\n")
		}
		if err != nil {
			t.Error(err)
			return
		}
		if first {
			if err := http.NewResponseController(w).Flush(); err != nil {
				t.Error(err)
				return
			}
			<-r.Context().Done()
			close(failureReleased)
		}
	}))
	defer upstream.Close()
	client, err := agentacp.NewClient(upstream.URL, upstream.Client())
	if err != nil {
		t.Fatal(err)
	}
	controller := &agentServiceStub{listErr: context.DeadlineExceeded}
	h := newTestHandlerWithServices(t, &identityServiceStub{resolvePrincipal: ordinaryPrincipal()}, controller, client, http.NotFoundHandler(), time.Now(), Config{}).(*handler)
	for attempt := range 2 {
		w := httptest.NewRecorder()
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		h.ServeHTTP(w, stateRequest("/watch").WithContext(ctx))
		expired := ctx.Err()
		cancel()
		if expired != nil {
			t.Fatalf("waited for deadline instead of completing state delivery: %v", expired)
		}
		if attempt == 0 {
			select {
			case <-failureReleased:
			case <-time.After(time.Second):
				t.Fatal("source error did not cancel live upstream")
			}
		}
		if w.Code != 200 || len(h.stateConnections) != 0 || strings.Contains(w.Body.String(), "private") {
			t.Fatalf("attempt=%d response=%d %s", attempt, w.Code, w.Body)
		}
		if attempt == 0 && (strings.Count(w.Body.String(), "event: workspace_state") != 1 || strings.Contains(w.Body.String(), `"availability":"ready"`)) {
			t.Fatal("source failure fabricated readiness")
		}
		if attempt == 1 && !strings.Contains(w.Body.String(), `"availability":"ready"`) {
			t.Fatal("reconnect lost fresh state")
		}
	}
	if calls.Load() != 2 || controller.input.RequestID != "" {
		t.Fatalf("ACP requests=%d Controller request=%s", calls.Load(), controller.input.RequestID)
	}
}
