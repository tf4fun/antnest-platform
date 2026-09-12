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
	"testing"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"

	"soft/antnest-platform/services/edge-gateway/internal/agentcontroller"
	"soft/antnest-platform/services/edge-gateway/internal/identity"
	"soft/antnest-platform/services/edge-gateway/internal/telemetry"
)

func TestWorkspaceStateHTTPDisconnectCancelsControllerReceive(t *testing.T) {
	t.Parallel()
	stopped := make(chan struct{})
	controller := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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
	defer controller.Close()
	agents, err := agentcontroller.NewClient(controller.URL, controller.Client())
	if err != nil {
		t.Fatal(err)
	}
	h := newTestHandlerWithAgents(t, &identityServiceStub{resolvePrincipal: ordinaryPrincipal()}, agents, http.NotFoundHandler(), time.Now(), Config{})
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
	if response.StatusCode != 200 || !strings.Contains(frame.String(), `"agent_revision":3`) {
		t.Fatalf("response=%d frame=%s", response.StatusCode, frame.String())
	}
	cancel()
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("Controller receive survived browser disconnect")
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
			controllerCalls := 0
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
				controllerCalls++
				principal := ordinaryPrincipal()
				if r.URL.Query().Get("organization_id") != principal.OrganizationID || r.URL.Query().Get("principal_id") != principal.UserID {
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
				last, _ := json.Marshal(state)
				if _, err := fmt.Fprintf(w, "event: workspace_state\ndata: %s\n\nevent: workspace_state\ndata: %s\n\n", first, last); err != nil {
					t.Error(err)
				}
			}))
			defer upstream.Close()
			client := &http.Client{Transport: telemetry.NewHTTPTransport(upstream.Client().Transport)}
			agents, err := agentcontroller.NewClient(upstream.URL, client)
			if err != nil {
				t.Fatal(err)
			}
			identities, err := identity.NewClient(upstream.URL, client)
			if err != nil {
				t.Fatal(err)
			}
			h := newTestHandlerWithAgents(t, identities, agents, http.NotFoundHandler(), time.Now(), Config{})
			r := stateRequest(suffix)
			r.Header.Set("traceparent", "00-"+traceID+"-00f067aa0ba902b7-01")
			r.Header.Set("Authorization", "Bearer private-browser-token")
			r.Header.Set(HeaderUserID, "forged")
			w := httptest.NewRecorder()
			telemetry.HTTPHandler(h, slog.New(slog.NewTextHandler(io.Discard, nil))).ServeHTTP(w, r)
			if w.Code != 200 || controllerCalls != 1 {
				t.Fatalf("response=%d %s calls=%d", w.Code, w.Body, controllerCalls)
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
