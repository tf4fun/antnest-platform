package telemetry

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func nativeSpans(t *testing.T) *tracetest.SpanRecorder {
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

type brokenBody struct{}

func (brokenBody) Read([]byte) (int, error) { return 0, errors.New("private response text") }
func (brokenBody) Close() error             { return nil }

func TestClientEndsAtBodySettlementAndKeepsOriginalRequest(t *testing.T) {
	for _, settlement := range []string{"eof", "close", "read_failure", "no_body", "status_failure"} {
		t.Run(settlement, func(t *testing.T) {
			recorder := nativeSpans(t)
			ctx, parent := otel.Tracer("fixture").Start(t.Context(), "caller")
			defer parent.End()
			request, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://source.invalid/private?credential=private-query", strings.NewReader("private-body"))
			if err != nil {
				t.Fatal(err)
			}
			request.Header.Set("Baggage", "private=private-baggage")
			request.Header.Set("Authorization", "Bearer private-token")
			base := &http.Client{Timeout: time.Second, Transport: roundTripFunc(func(sent *http.Request) (*http.Response, error) {
				remote := trace.SpanContextFromContext(propagation.TraceContext{}.Extract(t.Context(), propagation.HeaderCarrier(sent.Header)))
				if !remote.IsValid() || remote.TraceID() != parent.SpanContext().TraceID() || remote.SpanID() == parent.SpanContext().SpanID() || sent.Header.Get("Baggage") != "" || sent.Header.Get("Authorization") != "Bearer private-token" {
					t.Fatal("client context or authentication corrupted")
				}
				body := io.NopCloser(strings.NewReader("private-response"))
				status := 200
				switch settlement {
				case "read_failure":
					body = brokenBody{}
				case "no_body":
					body = http.NoBody
				case "status_failure":
					status = 503
				}
				return &http.Response{StatusCode: status, Header: make(http.Header), Body: body}, nil
			})}
			client := HTTPClient(base, "agent-acp-service")
			response, err := client.Do(request)
			if err != nil {
				t.Fatal(err)
			}
			if request.Header.Get("Traceparent") != "" || request.Header.Get("Baggage") == "" || base.Transport == client.Transport || client.Timeout != base.Timeout {
				t.Fatal("client wrapper mutated the caller or lost configuration")
			}
			if settlement != "no_body" && len(recorder.Ended()) != 0 {
				t.Fatal("CLIENT ended at response headers")
			}
			if settlement != "close" {
				_, err := io.ReadAll(response.Body)
				if (err != nil) != (settlement == "read_failure") {
					t.Fatalf("body error replaced: %v", err)
				}
			}
			if err := response.Body.Close(); err != nil {
				t.Fatal(err)
			}
			ended := recorder.Ended()
			if len(ended) != 1 || ended[0].SpanKind() != trace.SpanKindClient || ended[0].Parent().SpanID() != parent.SpanContext().SpanID() {
				t.Fatalf("CLIENT did not finish exactly once: %v", ended)
			}
			wantError := settlement == "read_failure" || settlement == "status_failure"
			if (ended[0].Status().Code == codes.Error) != wantError {
				t.Fatalf("unexpected CLIENT outcome: %v", ended[0].Status())
			}
			for _, attr := range ended[0].Attributes() {
				if strings.Contains(attr.Value.String(), "private-") {
					t.Fatalf("private HTTP value was recorded: %v", attr.Key)
				}
			}
			if len(ended[0].Events()) != 0 {
				t.Fatal("ordinary HTTP captured body/error content")
			}
		})
	}
}

func TestClientCancellationSettlesUnconsumedBody(t *testing.T) {
	recorder := nativeSpans(t)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	client := HTTPClient(&http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("body"))}, nil
	})}, "agent-acp-service")
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://source.invalid", nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	cancel()
	deadline := time.Now().Add(time.Second)
	for len(recorder.Ended()) == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if err := response.Body.Close(); err != nil {
		t.Fatal(err)
	}
	ended := recorder.Ended()
	if len(ended) != 1 || ended[0].Status().Code != codes.Error || ended[0].Status().Description != "cancelled" {
		t.Fatalf("cancelled HTTP did not settle: %v", ended)
	}
}

func TestServerFinishesOnFailureAndPreservesPanic(t *testing.T) {
	for _, kind := range []string{"failure", "panic", "cancelled"} {
		t.Run(kind, func(t *testing.T) {
			recorder := nativeSpans(t)
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			mux := http.NewServeMux()
			mux.HandleFunc("POST /known", func(w http.ResponseWriter, r *http.Request) {
				if kind == "panic" {
					panic("original private panic")
				}
				if kind == "cancelled" {
					cancel()
				} else {
					w.WriteHeader(503)
				}
			})
			request := httptest.NewRequest(http.MethodPost, "/known?private-query=secret", strings.NewReader("secret body")).WithContext(ctx)
			var recovered any
			func() {
				defer func() { recovered = recover() }()
				HTTPHandler(mux).ServeHTTP(httptest.NewRecorder(), request)
			}()
			if (recovered != nil) != (kind == "panic") || (recovered != nil && recovered != "original private panic") {
				t.Fatalf("panic changed: %v", recovered)
			}
			ended := recorder.Ended()
			if len(ended) != 1 || ended[0].SpanKind() != trace.SpanKindServer || ended[0].Status().Code != codes.Error || ended[0].Name() != "HTTP POST /known" || len(ended[0].Events()) != 0 {
				t.Fatalf("SERVER failure not settled safely: %v", ended)
			}
		})
	}
}
