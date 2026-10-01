package telemetry

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
)

func recordSpans(t *testing.T) *tracetest.SpanRecorder {
	t.Helper()
	previous := otel.GetTracerProvider()
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	otel.SetTracerProvider(provider)
	t.Cleanup(func() {
		_ = provider.Shutdown(context.Background())
		otel.SetTracerProvider(previous)
	})
	return recorder
}

func attributeValue(attributes []attribute.KeyValue, key string) string {
	for _, item := range attributes {
		if string(item.Key) == key {
			return item.Value.AsString()
		}
	}
	return ""
}

func eventValue(span sdktrace.ReadOnlySpan, event, key string) string {
	for _, item := range span.Events() {
		if item.Name == event {
			return attributeValue(item.Attributes, key)
		}
	}
	return ""
}

func TestHTTPTransportExactParentsAndBodyLifetime(t *testing.T) {
	recorder := recordSpans(t)
	var received trace.SpanContext
	mux := http.NewServeMux()
	mux.HandleFunc("GET /status", func(w http.ResponseWriter, r *http.Request) {
		received = trace.SpanContextFromContext(r.Context())
		_, _ = io.WriteString(w, "ready")
	})
	server := httptest.NewServer(HTTPHandler(mux, slog.New(slog.NewTextHandler(io.Discard, nil))))
	defer server.Close()
	ctx, parent := otel.Tracer("test").Start(t.Context(), "caller")
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, server.URL+"/status?state=secret", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Baggage", "secret=canary")
	response, err := (&http.Client{Transport: NewHTTPTransport(nil)}).Do(request)
	if err != nil {
		t.Fatal(err)
	}
	for _, span := range recorder.Ended() {
		if span.SpanKind() == trace.SpanKindClient {
			t.Fatal("CLIENT ended before response consumption")
		}
	}
	if _, err := io.Copy(io.Discard, response.Body); err != nil {
		t.Fatal(err)
	}
	if err := response.Body.Close(); err != nil {
		t.Fatal(err)
	}
	parent.End()
	var clientSpan, serverSpan sdktrace.ReadOnlySpan
	for _, span := range recorder.Ended() {
		switch span.SpanKind() {
		case trace.SpanKindClient:
			if clientSpan != nil {
				t.Fatal("duplicate CLIENT")
			}
			clientSpan = span
		case trace.SpanKindServer:
			serverSpan = span
		}
	}
	if clientSpan == nil || serverSpan == nil || serverSpan.SpanContext().SpanID() != received.SpanID() {
		t.Fatal("missing HTTP boundary spans")
	}
	if clientSpan.Parent().SpanID() != parent.SpanContext().SpanID() ||
		serverSpan.Parent().SpanID() != clientSpan.SpanContext().SpanID() ||
		serverSpan.SpanContext().TraceID() != parent.SpanContext().TraceID() {
		t.Fatal("HTTP parent IDs do not follow caller -> CLIENT -> SERVER")
	}
	if serverSpan.Name() != "HTTP GET /status" {
		t.Fatal(serverSpan.Name())
	}
}

func TestRPCContentSwitch(t *testing.T) {
	for _, enabled := range []bool{false, true} {
		t.Run(fmt.Sprint(enabled), func(t *testing.T) {
			t.Setenv("ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT", fmt.Sprint(enabled))
			recorder := recordSpans(t)
			var logs bytes.Buffer
			body := `{"id":"user-42","nested":{"new_field":"` + strings.Repeat("x", 20000) + `","password":"RPC-CANARY"}}`
			handler := HTTPHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				RegisterRPC(w, "test")
				var value any
				if err := json.NewDecoder(r.Body).Decode(&value); err != nil {
					t.Fatal(err)
				}
				RequestValue(w, value)
				ResponseValue(w, value)
				w.Header().Set("Content-Type", "application/json")
				if err := json.NewEncoder(w).Encode(value); err != nil {
					t.Fatal(err)
				}
			}), slog.New(slog.NewJSONHandler(&logs, nil)))
			request := httptest.NewRequest(http.MethodPost, "/rpc/test?code=QUERY-CANARY", strings.NewReader(body))
			request.Header.Set("Authorization", "Bearer HEADER-CANARY")
			request.Header.Set("Content-Type", "application/json")
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if strings.TrimSpace(response.Body.String()) != body {
				t.Fatal("wire changed")
			}
			span := recorder.Ended()[0]
			for _, direction := range []string{"request", "response"} {
				got := eventValue(span, "antnest."+direction, "antnest.payload.json")
				if enabled && got != body {
					t.Fatalf("%s contents were projected or limited", direction)
				}
				if !enabled && got != "" {
					t.Fatal("disabled capture produced content")
				}
			}
			if strings.Contains(logs.String(), "CANARY") {
				t.Fatal("contents entered completion log")
			}
			encoded, err := json.Marshal(span.Attributes())
			if err != nil {
				t.Fatal(err)
			}
			if strings.Contains(string(encoded), "CANARY") {
				t.Fatal("HTTP metadata captured headers or query")
			}
		})
	}
}

func TestRPCDisabledDoesNotSerialize(t *testing.T) {
	t.Setenv("ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT", "false")
	recorder := recordSpans(t)
	calls := 0
	value := marshalProbe{calls: &calls}
	HTTPHandler(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		RegisterRPC(w, "test")
		RequestValue(w, value)
		ResponseValue(w, value)
	}), slog.New(slog.NewTextHandler(io.Discard, nil))).ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/", nil))
	if calls != 0 || len(recorder.Ended()[0].Events()) != 0 {
		t.Fatal("disabled capture serialized DTO")
	}
}

func TestRPCCaptureEncodingFailureDoesNotChangeResponse(t *testing.T) {
	t.Setenv("ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT", "true")
	recorder := recordSpans(t)
	response := httptest.NewRecorder()
	HTTPHandler(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		RegisterRPC(w, "test")
		RequestValue(w, make(chan int))
		w.WriteHeader(http.StatusNoContent)
	}), slog.New(slog.NewTextHandler(io.Discard, nil))).ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/", nil))
	if response.Code != http.StatusNoContent || eventValue(recorder.Ended()[0], "antnest.capture.error", "error.type") != "json_encoding" {
		t.Fatal("capture failure changed business response or disappeared")
	}
}

type marshalProbe struct{ calls *int }

func (p marshalProbe) MarshalJSON() ([]byte, error) { *p.calls++; return []byte("{}"), nil }

func TestProtocolErrorInsideHTTP200AndCausePrivacy(t *testing.T) {
	recorder := recordSpans(t)
	err := domain.WithCause(domain.NewError("oidc_exchange_failed", "safe wire response", false), errors.New("token=ERROR-CANARY"))
	HTTPHandler(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		ProtocolError(w, err)
		w.WriteHeader(http.StatusOK)
	}), slog.New(slog.NewTextHandler(io.Discard, nil))).ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/rpc/test", nil))
	span := recorder.Ended()[0]
	for _, attr := range span.Attributes() {
		switch string(attr.Key) {
		case "antnest.error.stage", "antnest.error.type", "antnest.error.code", "antnest.error.message", "error.type":
			if attr.Value.Type() != attribute.STRING {
				t.Fatalf("error field is not a string: %s", attr.Key)
			}
		case "antnest.error.cause_types":
			if attr.Value.Type() != attribute.STRINGSLICE {
				t.Fatal("cause_types must be strings")
			}
		}
	}
	if span.Status().Code != codes.Error || attributeValue(span.Attributes(), "antnest.error.code") != "oidc_exchange_failed" {
		t.Fatal("HTTP 200 hid protocol failure")
	}
	if got := eventValue(span, "antnest.error", "antnest.error.message"); got == "" || strings.Contains(got, "CANARY") {
		t.Fatalf("safe cause summary=%q", got)
	}
}

func TestHTTPTransportStreamingErrorsAndCancellation(t *testing.T) {
	for _, canceled := range []bool{false, true} {
		t.Run(map[bool]string{false: "read", true: "cancel"}[canceled], func(t *testing.T) {
			recorder := recordSpans(t)
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			body := &failingBody{}
			transport := NewHTTPTransport(roundTripFunc(func(r *http.Request) (*http.Response, error) {
				if r.Header.Get("Baggage") != "" {
					t.Fatal("baggage propagated")
				}
				return &http.Response{StatusCode: 200, Body: body, Header: make(http.Header)}, nil
			}))
			request, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://provider.test/token?secret=CANARY", nil)
			if err != nil {
				t.Fatal(err)
			}
			request.Header.Set("Baggage", "secret=CANARY")
			response, err := transport.RoundTrip(request)
			if err != nil {
				t.Fatal(err)
			}
			if body.reads != 0 || len(recorder.Ended()) != 0 {
				t.Fatal("transport consumed stream")
			}
			if canceled {
				cancel()
			} else {
				buffer := make([]byte, 1)
				if _, err := response.Body.Read(buffer); !errors.Is(err, io.ErrUnexpectedEOF) {
					t.Fatal(err)
				}
			}
			if err := response.Body.Close(); err != nil {
				t.Fatal(err)
			}
			if !body.closed || len(recorder.Ended()) != 1 || recorder.Ended()[0].Status().Code != codes.Error {
				t.Fatal("stream failure lifecycle")
			}
		})
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

type failingBody struct {
	reads  int
	closed bool
}

func (b *failingBody) Read([]byte) (int, error) { b.reads++; return 0, io.ErrUnexpectedEOF }
func (b *failingBody) Close() error             { b.closed = true; return nil }
