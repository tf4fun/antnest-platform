package telemetry

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"

	"go.opentelemetry.io/otel"
)

type sharedRoundTripFunc func(*http.Request) (*http.Response, error)

func (f sharedRoundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) {
	return f(r)
}

func TestHTTPTransportClonesNilHeaderWithoutMutatingOriginal(t *testing.T) {
	boundaryRecorder(t)
	ctx, parent := otel.Tracer("fixture").Start(context.Background(), "caller")
	defer parent.End()
	var sent *http.Request
	transport := NewHTTPTransport(sharedRoundTripFunc(func(r *http.Request) (*http.Response, error) {
		sent = r
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     make(http.Header),
			Body:       io.NopCloser(strings.NewReader("")),
			Request:    r,
		}, nil
	}))
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://example.invalid/x", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header = nil
	response, err := transport.RoundTrip(request)
	if err != nil {
		t.Fatal(err)
	}
	if err := response.Body.Close(); err != nil {
		t.Fatal(err)
	}
	if sent == nil {
		t.Fatal("request never reached the transport")
	}
	traceparent := sent.Header.Get("traceparent")
	if traceparent == "" || !strings.Contains(traceparent, parent.SpanContext().TraceID().String()) {
		t.Fatalf("outgoing clone lost trace propagation: %v", sent.Header)
	}
	if request.Header != nil {
		t.Fatalf("original request header mutated: %v", request.Header)
	}
}
