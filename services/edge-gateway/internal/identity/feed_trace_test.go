package identity

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/telemetry"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
)

func recordFeedSpans(t *testing.T) *tracetest.SpanRecorder {
	t.Helper()
	t.Setenv("ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT", "true")
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	previous, propagator := otel.GetTracerProvider(), otel.GetTextMapPropagator()
	otel.SetTracerProvider(provider)
	otel.SetTextMapPropagator(propagation.TraceContext{})
	t.Cleanup(func() {
		if err := provider.Shutdown(context.Background()); err != nil {
			t.Error(err)
		}
		otel.SetTracerProvider(previous)
		otel.SetTextMapPropagator(propagator)
	})
	return recorder
}

func feedTraceAttribute(span sdktrace.ReadOnlySpan, name string) string {
	for _, attribute := range span.Attributes() {
		if string(attribute.Key) == name {
			return attribute.Value.AsString()
		}
	}
	return ""
}

func assertFeedMethod(t *testing.T, span sdktrace.ReadOnlySpan, expected bool) {
	t.Helper()
	for name, value := range map[string]string{
		"rpc.method": "list_session_revocations", "rpc.service": "identity", "rpc.system.name": "antnest.http-json",
	} {
		if !expected {
			value = ""
		}
		if actual := feedTraceAttribute(span, name); actual != value {
			t.Errorf("%s: %s=%q, want %q", span.Name(), name, actual, value)
		}
	}
}

func TestFeedMethodWitnessSurvivesSendFailureWithoutReceiver(t *testing.T) {
	for _, mode := range []string{"success", "transport-error", "deadline"} {
		t.Run(mode, func(t *testing.T) {
			recorder := recordFeedSpans(t)
			ctx, owner := otel.Tracer("test").Start(context.Background(), "feed-owner")
			defer owner.End()
			ctx, cancel := context.WithTimeout(ctx, 20*time.Millisecond)
			defer cancel()
			const canary = "private-feed-canary"
			failure := errors.New(canary)
			var sent trace.SpanContext
			client, err := NewClient("http://identity.internal", &http.Client{Transport: telemetry.NewHTTPTransport(roundTripFunc(func(request *http.Request) (*http.Response, error) {
				sent = trace.SpanContextFromContext(request.Context())
				if request.URL.Path != "/rpc/identity/list-session-revocations" || request.Header.Get(CallerContextHeader) != "" {
					t.Error("feed changed its route or forwarded a caller context")
				}
				var body map[string]int
				if err := json.NewDecoder(request.Body).Decode(&body); err != nil || body["after_sequence"] != 731 || body["limit"] != 500 {
					t.Error("feed request changed")
				}
				switch mode {
				case "transport-error":
					return nil, failure
				case "deadline":
					<-request.Context().Done()
					return nil, request.Context().Err()
				default:
					return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"events":[{"sequence":732,"token_id":"token-private-feed-canary","user_id":"user-private-feed-canary","organization_id":"org-private-feed-canary","reason":"session_revoked","occurred_at":"2026-10-12T00:00:00Z"}],"next_sequence":732}`)), Header: make(http.Header)}, nil
				}
			}))})
			if err != nil {
				t.Fatal(err)
			}
			page, err := client.ListSessionRevocations(ctx, 731, 500)
			switch mode {
			case "success":
				if err != nil || page.NextSequence != 732 || len(page.Events) != 1 {
					t.Fatalf("feed response changed: %v", err)
				}
			case "transport-error":
				if !errors.Is(err, failure) {
					t.Fatalf("original transport error lost: %v", err)
				}
			case "deadline":
				if !errors.Is(err, context.DeadlineExceeded) {
					t.Fatalf("original deadline lost: %v", err)
				}
			}
			owner.End()
			spans := recorder.Ended()
			if len(spans) != 2 {
				t.Fatalf("expected one actual CLIENT and its owner; spans=%d", len(spans))
			}
			actual := spans[0]
			if actual.SpanKind() != trace.SpanKindClient || !actual.SpanContext().Equal(sent) || actual.Parent().SpanID() != owner.SpanContext().SpanID() {
				t.Fatal("feed marker changed actual CLIENT or ancestry")
			}
			assertFeedMethod(t, actual, true)
			assertFeedMethod(t, spans[1], false)
			if (actual.Status().Code == codes.Error) != (mode != "success") {
				t.Fatal("original error status changed")
			}
			for _, span := range spans {
				encoded, err := json.Marshal([]any{span.Attributes(), span.Events(), span.Status()})
				if err != nil {
					t.Fatal(err)
				}
				if strings.Contains(string(encoded), canary) || strings.Contains(string(encoded), "after_sequence") || strings.Contains(string(encoded), "antnest.payload.json") {
					t.Fatal("feed content escaped into diagnostics")
				}
			}
		})
	}
}

func TestFeedMethodWitnessCannotComeFromURLHeadersOrSiblingContext(t *testing.T) {
	recorder := recordFeedSpans(t)
	ctx, owner := otel.Tracer("test").Start(context.Background(), "owner")
	defer owner.End()
	var actualFeed trace.SpanContext
	calls := 0
	httpClient := &http.Client{Transport: telemetry.NewHTTPTransport(roundTripFunc(func(request *http.Request) (*http.Response, error) {
		calls++
		if calls == 1 {
			actualFeed = trace.SpanContextFromContext(request.Context())
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"events":[],"next_sequence":0,"methods":[]}`)), Header: make(http.Header)}, nil
	}))}
	client, err := NewClient("http://identity.internal", httpClient)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.ListSessionRevocations(ctx, -1, 500); err == nil || calls != 0 {
		t.Fatal("invalid feed query created work")
	}
	if _, err := client.ListSessionRevocations(ctx, 0, 500); err != nil {
		t.Fatal(err)
	}
	if _, err := client.ListLoginMethods(ctx, "private-organization"); err != nil {
		t.Fatal(err)
	}
	if _, err := client.Resolve(ctx, "private-token"); err == nil {
		t.Fatal("incomplete authority was admitted")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://identity.internal/rpc/identity/list-session-revocations?rpc.method=list_session_revocations", strings.NewReader(`{"rpc.method":"list_session_revocations"}`))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Rpc.Method", "list_session_revocations")
	response, err := httpClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	if err := response.Body.Close(); err != nil {
		t.Fatal(err)
	}
	owner.End()
	marked := 0
	for _, span := range recorder.Ended() {
		expected := span.SpanContext().Equal(actualFeed)
		assertFeedMethod(t, span, expected)
		if expected {
			marked++
		}
	}
	if marked != 1 || calls != 4 || len(recorder.Ended()) != 6 {
		t.Fatal("feed method was fabricated or an actual call disappeared")
	}
}
