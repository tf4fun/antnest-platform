package upstream

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
)

func TestClientTargetsOnlyConfiguredServiceAndPropagatesTrace(t *testing.T) {
	var received *http.Request
	httpClient := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		received = request
		return &http.Response{
			StatusCode: http.StatusOK, Header: http.Header{"Content-Type": []string{"application/json"}},
			Body: io.NopCloser(strings.NewReader(`{"items":[]}`)),
		}, nil
	})}
	client, err := NewClient(Config{
		IdentityURL: "http://identity.internal", AgentControllerURL: "http://agent-controller.internal",
		HTTPClient: httpClient,
	})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}

	previousProvider := otel.GetTracerProvider()
	previousPropagator := otel.GetTextMapPropagator()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSampler(sdktrace.AlwaysSample()))
	otel.SetTracerProvider(provider)
	otel.SetTextMapPropagator(propagation.TraceContext{})
	t.Cleanup(func() {
		_ = provider.Shutdown(context.Background())
		otel.SetTracerProvider(previousProvider)
		otel.SetTextMapPropagator(previousPropagator)
	})
	ctx, span := otel.Tracer("admin-upstream-test").Start(context.Background(), "root")
	defer span.End()

	response, err := client.Do(ctx, AgentController, http.MethodGet,
		"/internal/agents", "organization_id=org-1", nil)
	if err != nil {
		t.Fatalf("Do: %v", err)
	}
	_ = response.Body.Close()
	if received.URL.Host != "agent-controller.internal" ||
		received.URL.Path != "/internal/agents" || received.URL.RawQuery != "organization_id=org-1" {
		t.Fatalf("request URL=%s", received.URL.String())
	}
	if received.Header.Get("traceparent") == "" {
		t.Fatal("traceparent missing")
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func TestClientDoesNotRedirectMutation(t *testing.T) {
	for _, status := range []int{301, 302, 303, 307, 308} {
		calls := 0
		httpClient := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			calls++
			return &http.Response{StatusCode: status, Header: http.Header{"Location": {"http://unexpected.internal/target"}}, Body: io.NopCloser(strings.NewReader("")), Request: request}, nil
		})}
		client, err := NewClient(Config{IdentityURL: "http://identity.internal", AgentControllerURL: "http://controller.internal", HTTPClient: httpClient})
		if err != nil {
			t.Fatal(err)
		}
		response, err := client.Do(context.Background(), AgentController, http.MethodPut, "/internal/agents/agent-1/network-policy", "", []byte(`{}`))
		if err != nil {
			t.Fatal(err)
		}
		_ = response.Body.Close()
		if calls != 1 || response.StatusCode != status || httpClient.CheckRedirect != nil {
			t.Fatalf("status=%d calls=%d client mutated=%v", response.StatusCode, calls, httpClient.CheckRedirect != nil)
		}
	}
}

func (function roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}
