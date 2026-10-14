package server

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"

	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/identity"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/session"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/telemetry"
)

func newNetworkBridgeTestHandler(t *testing.T, identities IdentityService, upstream *httptest.Server) *handler {
	t.Helper()
	h := newTestHandler(t, identities, http.NotFoundHandler(), time.Now()).(*handler)
	h.agentUIURL, _ = url.Parse(upstream.URL)
	h.httpClient = &http.Client{Transport: telemetry.NewHTTPTransport(upstream.Client().Transport)}
	h.workspaceBridgeProxy = h.newWorkspaceBridgeProxy(h.agentUIURL)
	return h
}

func TestWorkspaceBridgeTraceCompletesWhileEventStreamRemainsOpen(t *testing.T) {
	previousProvider, previousPropagator := otel.GetTracerProvider(), otel.GetTextMapPropagator()
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	otel.SetTracerProvider(provider)
	otel.SetTextMapPropagator(propagation.TraceContext{})
	t.Cleanup(func() {
		_ = provider.Shutdown(context.Background())
		otel.SetTracerProvider(previousProvider)
		otel.SetTextMapPropagator(previousPropagator)
	})
	const traceID = "4bf92f3577b34da6a3ce929d0e0e4736"
	const incomingParent = "00f067aa0ba902b7"
	const commandPath = "/api/app/workspace/v1/agents/agent-1/commands"
	issuerContext := testIssuerContext(t)
	streamStopped := make(chan struct{})
	commandParent := make(chan string, 1)
	identityParents := make(chan string, 2)
	var identityCalls, commandCalls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Cookie") != "" || r.Header.Get("Authorization") != "" {
			t.Error("browser credential reached an internal HTTP request")
		}
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/rpc/identity/resolve-access-token" {
			identityCalls.Add(1)
			select {
			case identityParents <- r.Header.Get("traceparent"):
			default:
				t.Error("unexpected extra Identity HTTP request")
				http.Error(w, "unexpected request", http.StatusInternalServerError)
				return
			}
			principal := ordinaryPrincipal()
			if err := json.NewEncoder(w).Encode(map[string]any{
				"principal": principal, "caller_context": issuerContext, "expires_at": principal.ExpiresAt,
				"idle_expires_at": principal.IdleExpiresAt, "activity_interval_ms": principal.ActivityIntervalMS,
			}); err != nil {
				t.Error(err)
			}
			return
		}
		for header, want := range map[string]string{
			HeaderOrganizationID: "org-1", HeaderPrincipalID: "user-admin", HeaderUserID: "user-admin",
			HeaderAgentID: "agent-1", identity.CallerContextHeader: issuerContext,
		} {
			if values := r.Header.Values(header); len(values) != 1 || values[0] != want {
				t.Errorf("Bridge lost verified %s", header)
			}
		}
		if strings.HasSuffix(r.URL.Path, "/events") {
			defer close(streamStopped)
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = io.WriteString(w, "event: reset\ndata: {}\n\n")
			if err := http.NewResponseController(w).Flush(); err != nil {
				t.Error(err)
				return
			}
			<-r.Context().Done()
			return
		}
		if r.URL.Path != commandPath || r.Method != http.MethodPost {
			t.Errorf("unexpected Bridge request: %s %s", r.Method, r.URL.Path)
		}
		commandCalls.Add(1)
		select {
		case commandParent <- r.Header.Get("traceparent"):
		default:
			t.Error("unexpected extra Bridge command request")
			http.Error(w, "unexpected request", http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusAccepted)
		_, _ = io.WriteString(w, `{"operationId":"operation-1"}`)
	}))
	defer upstream.Close()
	client := &http.Client{Transport: telemetry.NewHTTPTransport(upstream.Client().Transport)}
	identities, err := identity.NewClient(upstream.URL, client)
	if err != nil {
		t.Fatal(err)
	}
	h := newNetworkBridgeTestHandler(t, identities, upstream)
	commandHandled := make(chan struct{}, 1)
	observed := telemetry.HTTPHandler(h, slog.New(slog.NewTextHandler(io.Discard, nil)))
	edge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		observed.ServeHTTP(w, r)
		if r.URL.Path == commandPath {
			select {
			case commandHandled <- struct{}{}:
			default:
				t.Error("unexpected extra command handler completed")
			}
		}
	}))
	defer edge.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	events, _ := http.NewRequestWithContext(ctx, http.MethodGet, edge.URL+"/api/app/workspace/v1/agents/agent-1/events", nil)
	addSessionCookies(events, "token-1", testCSRFToken)
	stream, err := edge.Client().Do(events)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = stream.Body.Close() }()
	first := make([]byte, len("event: reset\ndata: {}\n\n"))
	if _, err := io.ReadFull(stream.Body, first); err != nil {
		t.Fatal(err)
	}
	request, _ := http.NewRequestWithContext(ctx, http.MethodPost, edge.URL+commandPath, strings.NewReader(`{"command":"stop"}`))
	request.Header.Set("Origin", edge.URL)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set(session.CSRFHeaderName, testCSRFToken)
	request.Header.Set("traceparent", "00-"+traceID+"-"+incomingParent+"-01")
	request.Header.Set("Authorization", "Bearer private-browser-token")
	request.Header.Set(HeaderUserID, "forged-user")
	addSessionCookies(request, "token-1", testCSRFToken)
	response, err := edge.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	_, readErr := io.Copy(io.Discard, response.Body)
	_ = response.Body.Close()
	if readErr != nil || response.StatusCode != http.StatusAccepted || commandCalls.Load() != 1 || identityCalls.Load() != 2 {
		t.Fatalf("command status=%d command/identity calls=%d/%d err=%v", response.StatusCode, commandCalls.Load(), identityCalls.Load(), readErr)
	}
	select {
	case <-commandHandled:
	case <-ctx.Done():
		t.Fatal("command HTTP handler and trace did not finish")
	}
	select {
	case <-streamStopped:
		t.Fatal("command trace only completed after the independent event stream closed")
	default:
	}
	var root trace.SpanID
	var selected []sdktrace.ReadOnlySpan
	for _, span := range recorder.Ended() {
		if span.SpanContext().TraceID().String() == traceID {
			selected = append(selected, span)
			if span.SpanKind() == trace.SpanKindServer {
				root = span.SpanContext().SpanID()
				if span.Parent().SpanID().String() != incomingParent {
					t.Fatal("Gateway lost the actual incoming HTTP parent")
				}
			}
		}
	}
	if !root.IsValid() || len(selected) != 4 {
		t.Fatalf("completed command trace has %d spans, root=%s", len(selected), root)
	}
	clients, decisions := 0, 0
	actualParent := <-commandParent
	actualIdentityParent := ""
	for len(identityParents) > 0 {
		parent := <-identityParents
		if strings.HasPrefix(parent, "00-"+traceID+"-") {
			actualIdentityParent = parent
		}
	}
	if actualIdentityParent == "" || actualParent == actualIdentityParent {
		t.Fatal("Bridge and Identity HTTP requests did not carry distinct actual CLIENT parents")
	}
	matchedUpstream := false
	matchedIdentity := false
	for _, span := range selected {
		if span.SpanKind() == trace.SpanKindClient {
			clients++
			if span.Parent().SpanID() != root {
				t.Fatal("detached outgoing HTTP client")
			}
			if actualParent == "00-"+traceID+"-"+span.SpanContext().SpanID().String()+"-01" {
				matchedUpstream = true
			}
			if actualIdentityParent == "00-"+traceID+"-"+span.SpanContext().SpanID().String()+"-01" {
				matchedIdentity = true
			}
		}
		if span.Name() == "gateway.identity.resolve" {
			decisions++
			if span.SpanKind() != trace.SpanKindInternal || span.Parent().SpanID() != root {
				t.Fatal("Resolve decision lost its request parent")
			}
			attributes := map[string]string{}
			for _, attr := range span.Attributes() {
				attributes[string(attr.Key)] = attr.Value.AsString()
			}
			if attributes["antnest.identity.resolve.source"] != "rpc" || attributes["antnest.identity.resolve.outcome"] != "admitted" {
				t.Fatal("Resolve source/outcome evidence changed")
			}
		}
		for _, attr := range span.Attributes() {
			if strings.Contains(attr.Value.String(), "private-browser-token") || strings.Contains(attr.Value.String(), issuerContext) {
				t.Fatal("credential leaked into a trace attribute")
			}
		}
	}
	if clients != 2 || decisions != 1 || !matchedUpstream || !matchedIdentity {
		t.Fatalf("CLIENT/Resolve=%d/%d actual Bridge/Identity HTTP parents matched=%t/%t", clients, decisions, matchedUpstream, matchedIdentity)
	}
	cancel()
	select {
	case <-streamStopped:
	case <-time.After(time.Second):
		t.Fatal("Bridge event receiver survived browser cancellation")
	}
}
