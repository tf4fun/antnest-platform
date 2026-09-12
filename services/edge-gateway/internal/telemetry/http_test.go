package telemetry

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

func TestHTTPHandlerCreatesServerSpanAndReturnsTraceID(t *testing.T) {
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	previous := otel.GetTracerProvider()
	otel.SetTracerProvider(provider)
	t.Cleanup(func() {
		_ = provider.Shutdown(context.Background())
		otel.SetTracerProvider(previous)
	})

	handler := HTTPHandler(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		request.SetPathValue("resource", "agents")
		response.WriteHeader(http.StatusAccepted)
	}), slog.New(slog.NewTextHandler(io.Discard, nil)))
	request := httptest.NewRequest(http.MethodPost, "/api/admin/agents", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Header().Get("X-Antnest-Trace-ID") == "" {
		t.Fatal("trace ID response header is missing")
	}
	spans := recorder.Ended()
	if len(spans) != 1 || spans[0].SpanKind() != 2 || spans[0].Status().Code != 0 {
		t.Fatalf("spans=%#v", spans)
	}
}

func TestHTTPHandlerCompletesTraceWhenHandlerUnwinds(t *testing.T) {
	for _, tc := range []struct {
		name                       string
		panicValue                 any
		writtenStatus, traceStatus int
		cancelled                  bool
		requestCancelled           bool
	}{
		{"normal", nil, http.StatusOK, http.StatusOK, false, false},
		{"aborted stream", http.ErrAbortHandler, http.StatusOK, http.StatusOK, false, false},
		{"panic before headers", "private-panic-payload", 0, http.StatusInternalServerError, false, false},
		{"panic after headers", "private-panic-payload", http.StatusAccepted, http.StatusAccepted, false, false},
		{"cancelled stream", http.ErrAbortHandler, http.StatusOK, http.StatusOK, true, true},
		{"cancelled ordinary panic", "private-panic-payload", http.StatusOK, http.StatusOK, true, false},
		{"completed cancelled request", nil, http.StatusOK, http.StatusOK, true, false},
		{"cancelled before headers", http.ErrAbortHandler, 0, http.StatusInternalServerError, true, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			recorder := tracetest.NewSpanRecorder()
			provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
			previous := otel.GetTracerProvider()
			otel.SetTracerProvider(provider)
			t.Cleanup(func() {
				if err := provider.Shutdown(context.Background()); err != nil {
					t.Error(err)
				}
				otel.SetTracerProvider(previous)
			})
			var logs bytes.Buffer
			handler := HTTPHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				r.Pattern = "GET /api/app/agents/{agent_id}/v1/acp"
				_, child := otel.Tracer("test").Start(r.Context(), "downstream")
				defer child.End()
				if tc.writtenStatus != 0 {
					w.WriteHeader(tc.writtenStatus)
				}
				if tc.panicValue != nil {
					panic(tc.panicValue)
				}
			}), slog.New(slog.NewJSONHandler(&logs, nil)))
			response := httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodGet, "/api/app/agents/a/v1/acp", nil)
			ctx, cancel := context.WithCancel(request.Context())
			defer cancel()
			if tc.cancelled {
				cancel()
			}
			var recovered any
			func() {
				defer func() { recovered = recover() }()
				handler.ServeHTTP(response, request.WithContext(ctx))
			}()
			if recovered != tc.panicValue {
				t.Fatalf("changed panic: %T", recovered)
			}
			spans := recorder.Ended()
			if len(spans) != 2 {
				t.Fatalf("ended spans = %d, want child and Gateway", len(spans))
			}
			child, root := spans[0], spans[1]
			if child.Parent().SpanID() != root.SpanContext().SpanID() {
				t.Fatal("child lost Gateway parent")
			}
			if root.Name() != "HTTP GET /api/app/agents/{agent_id}/v1/acp" {
				t.Fatalf("route = %q", root.Name())
			}
			wantCode := codes.Unset
			if tc.panicValue != nil {
				wantCode = codes.Error
			}
			if root.Status().Code != wantCode {
				t.Fatalf("trace status = %v", root.Status())
			}
			foundStatus := false
			requestCancelled := false
			for _, attr := range root.Attributes() {
				if attr.Key == "http.response.status_code" {
					foundStatus = int(attr.Value.AsInt64()) == tc.traceStatus
				}
				if attr.Key == "antnest.http.request_cancelled" {
					requestCancelled = attr.Value.AsBool()
				}
			}
			if requestCancelled != tc.requestCancelled {
				t.Fatalf("request cancellation marker = %t, want %t", requestCancelled, tc.requestCancelled)
			}
			if !foundStatus {
				t.Fatal("missing or overwritten HTTP status")
			}
			if tc.writtenStatus != 0 && response.Code != tc.writtenStatus {
				t.Fatal("rewrote committed response")
			}
			if response.Body.Len() != 0 {
				t.Fatal("wrote an error body while unwinding")
			}
			if strings.Contains(logs.String(), "private-panic-payload") {
				t.Fatal("logged panic payload")
			}
		})
	}
}
