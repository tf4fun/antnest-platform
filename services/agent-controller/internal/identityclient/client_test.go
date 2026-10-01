package identityclient

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/propagation"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	"go.opentelemetry.io/otel/trace"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func TestResolvePrincipalUsesIdentityContractAndPreservesEffectiveState(t *testing.T) {
	t.Parallel()

	type observedRequest struct {
		method string
		path   string
		body   map[string]string
		err    error
	}
	observed := make(chan observedRequest, 1)
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		var body map[string]string
		err := json.NewDecoder(request.Body).Decode(&body)
		observed <- observedRequest{method: request.Method, path: request.URL.Path, body: body, err: err}
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{"principal":{"user_id":"user-1","organization_id":"org-1","membership_id":"membership-1","active":false}}`))
	}))
	defer server.Close()

	client, err := New(server.URL, time.Second, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	principal, err := client.ResolvePrincipal(context.Background(), "org-1", "user-1")
	if err != nil {
		t.Fatalf("resolve principal: %v", err)
	}
	if principal.UserID != "user-1" || principal.OrganizationID != "org-1" ||
		principal.MembershipID != "membership-1" || principal.Active {
		t.Fatalf("principal = %#v", principal)
	}
	request := <-observed
	if request.err != nil || request.method != http.MethodPost ||
		request.path != "/rpc/identity/resolve-principal" ||
		request.body["user_id"] != "user-1" || request.body["organization_id"] != "org-1" {
		t.Fatalf("observed request = %#v", request)
	}
}

func TestResolvePrincipalMapsStableIdentityFailures(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		response.WriteHeader(http.StatusNotFound)
		_, _ = response.Write([]byte(`{"code":"not_found","message":"missing","retryable":false}`))
	}))
	defer server.Close()

	client, err := New(server.URL, time.Second, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.ResolvePrincipal(context.Background(), "org-1", "user-1")
	failure, ok := err.(*ports.DependencyError)
	if !ok || failure.Service != "identity" || failure.Code != "not_found" || failure.Retryable {
		t.Fatalf("failure = %#v", err)
	}
}

func TestResolvePrincipalPropagatesTraceContext(t *testing.T) {
	previous := otel.GetTextMapPropagator()
	otel.SetTextMapPropagator(propagation.TraceContext{})
	t.Cleanup(func() { otel.SetTextMapPropagator(previous) })

	traceparent := "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
	observedTraceparent := make(chan string, 1)
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		observedTraceparent <- request.Header.Get("traceparent")
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{"principal":{"user_id":"user-1","organization_id":"org-1","membership_id":"membership-1","active":true}}`))
	}))
	defer server.Close()

	client, err := New(server.URL, time.Second, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	carrier := propagation.MapCarrier{"traceparent": traceparent}
	ctx := propagation.TraceContext{}.Extract(context.Background(), carrier)
	if !trace.SpanContextFromContext(ctx).IsValid() {
		t.Fatal("test trace context is invalid")
	}
	if _, err := client.ResolvePrincipal(ctx, "org-1", "user-1"); err != nil {
		t.Fatal(err)
	}
	if actual := <-observedTraceparent; actual != traceparent {
		t.Fatalf("traceparent = %q, want %q", actual, traceparent)
	}
}

func TestResolvePrincipalRejectsInvalidSuccessEnvelope(t *testing.T) {
	t.Parallel()

	tests := map[string]string{
		"mismatched user":       `{"principal":{"user_id":"user-2","organization_id":"org-1","membership_id":"membership-1","active":true}}`,
		"missing membership":    `{"principal":{"user_id":"user-1","organization_id":"org-1","membership_id":"","active":true}}`,
		"invalid membership":    `{"principal":{"user_id":"user-1","organization_id":"org-1","membership_id":"membership/1","active":true}}`,
		"missing active":        `{"principal":{"user_id":"user-1","organization_id":"org-1","membership_id":"membership-1"}}`,
		"unexpected role field": `{"principal":{"user_id":"user-1","organization_id":"org-1","membership_id":"membership-1","system_role":"user","active":true}}`,
	}
	for name, payload := range tests {
		name, payload := name, payload
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
				response.Header().Set("Content-Type", "application/json")
				_, _ = response.Write([]byte(payload))
			}))
			defer server.Close()
			client, err := New(server.URL, time.Second, server.Client())
			if err != nil {
				t.Fatal(err)
			}
			_, err = client.ResolvePrincipal(context.Background(), "org-1", "user-1")
			failure, ok := err.(*ports.DependencyError)
			if !ok || failure.Code != "invalid_response" || !failure.Retryable {
				t.Fatalf("failure = %#v", err)
			}
		})
	}
}

func TestDecodeFailureRejectsResponsesOutsideResolvePrincipalContract(t *testing.T) {
	t.Parallel()

	for name, test := range map[string]struct {
		payload string
		status  int
	}{
		"unknown code":       {payload: `{"code":"secret_backend_detail","message":"bad","retryable":false}`, status: http.StatusTeapot},
		"wrong status":       {payload: `{"code":"not_found","message":"missing","retryable":false}`, status: http.StatusForbidden},
		"wrong retryability": {payload: `{"code":"internal_error","message":"failed","retryable":false}`, status: http.StatusInternalServerError},
		"missing message":    {payload: `{"code":"not_found","retryable":false}`, status: http.StatusNotFound},
		"missing retryable":  {payload: `{"code":"not_found","message":"missing"}`, status: http.StatusNotFound},
	} {
		name, test := name, test
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			failure, ok := decodeFailure([]byte(test.payload), test.status).(*ports.DependencyError)
			if !ok || failure.Code != "invalid_response" || !failure.Retryable {
				t.Fatalf("failure = %#v", failure)
			}
		})
	}
}

func TestResolvePrincipalRejectsInvalidTransportEnvelopes(t *testing.T) {
	t.Parallel()

	t.Run("content type", func(t *testing.T) {
		t.Parallel()
		server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
			response.Header().Set("Content-Type", "text/plain")
			_, _ = response.Write([]byte(
				`{"principal":{"user_id":"user-1","organization_id":"org-1","membership_id":"membership-1","active":true}}`,
			))
		}))
		defer server.Close()
		client, err := New(server.URL, time.Second, server.Client())
		if err != nil {
			t.Fatal(err)
		}
		_, err = client.ResolvePrincipal(context.Background(), "org-1", "user-1")
		assertDependencyFailure(t, err, "invalid_response", true)
	})

	t.Run("redirect", func(t *testing.T) {
		t.Parallel()
		var targetCalls atomic.Int32
		target := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
			targetCalls.Add(1)
			response.Header().Set("Content-Type", "application/json")
			_, _ = response.Write([]byte(
				`{"principal":{"user_id":"user-1","organization_id":"org-1","membership_id":"membership-1","active":true}}`,
			))
		}))
		defer target.Close()
		origin := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
			response.Header().Set("Location", target.URL)
			response.WriteHeader(http.StatusTemporaryRedirect)
		}))
		defer origin.Close()
		client, err := New(origin.URL, time.Second, origin.Client())
		if err != nil {
			t.Fatal(err)
		}
		_, err = client.ResolvePrincipal(context.Background(), "org-1", "user-1")
		assertDependencyFailure(t, err, "invalid_response", true)
		if targetCalls.Load() != 0 {
			t.Fatalf("Identity client followed redirect %d times", targetCalls.Load())
		}
	})
}

func TestResolvePrincipalRejectsInvalidIdentityWithoutSending(t *testing.T) {
	t.Parallel()

	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		calls.Add(1)
	}))
	defer server.Close()
	client, err := New(server.URL, time.Second, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.ResolvePrincipal(context.Background(), "org-1", " user-1 ")
	assertDependencyFailure(t, err, "invalid_request", false)
	if calls.Load() != 0 {
		t.Fatalf("invalid Identity request reached dependency %d times", calls.Load())
	}
}

func TestNewRejectsInvalidIdentityEndpoint(t *testing.T) {
	t.Parallel()

	for _, endpoint := range []string{"", "identity:8080", "ftp://identity.example", "http://user:pass@identity"} {
		if _, err := New(endpoint, time.Second, nil); err == nil || !strings.Contains(err.Error(), "identity service") {
			t.Fatalf("New(%q) error = %v", endpoint, err)
		}
	}
}

func TestResolvePrincipalEmitsBoundedDependencyMetrics(t *testing.T) {
	reader := sdkmetric.NewManualReader()
	provider := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))
	previous := otel.GetMeterProvider()
	otel.SetMeterProvider(provider)
	t.Cleanup(func() {
		otel.SetMeterProvider(previous)
		_ = provider.Shutdown(context.Background())
	})

	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		if calls.Add(1) == 1 {
			_, _ = response.Write([]byte(
				`{"principal":{"user_id":"user-1","organization_id":"org-1","membership_id":"membership-1","active":true}}`,
			))
			return
		}
		response.WriteHeader(http.StatusNotFound)
		_, _ = response.Write([]byte(`{"code":"not_found","message":"missing","retryable":false}`))
	}))
	defer server.Close()

	client, err := New(server.URL, time.Second, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.ResolvePrincipal(context.Background(), "org-1", "user-1"); err != nil {
		t.Fatalf("resolve active principal: %v", err)
	}
	if _, err := client.ResolvePrincipal(context.Background(), "org-1", "user-1"); err == nil {
		t.Fatal("missing principal response unexpectedly succeeded")
	}

	var collected metricdata.ResourceMetrics
	if err := reader.Collect(context.Background(), &collected); err != nil {
		t.Fatalf("collect Identity dependency metrics: %v", err)
	}
	wantErrorTypes := map[string]bool{"none": false, "not_found": false}
	seenMetrics := map[string]int{}
	for _, scope := range collected.ScopeMetrics {
		for _, metric := range scope.Metrics {
			switch data := metric.Data.(type) {
			case metricdata.Sum[int64]:
				for _, point := range data.DataPoints {
					assertDependencyMetricAttributes(t, point.Attributes, wantErrorTypes)
					seenMetrics[metric.Name]++
				}
			case metricdata.Histogram[float64]:
				for _, point := range data.DataPoints {
					assertDependencyMetricAttributes(t, point.Attributes, wantErrorTypes)
					seenMetrics[metric.Name]++
				}
			}
		}
	}
	if seenMetrics["antnest.agent_controller.dependency.requests"] != 2 ||
		seenMetrics["antnest.agent_controller.dependency.duration"] != 2 {
		t.Fatalf("Identity dependency metric points=%v", seenMetrics)
	}
	for errorType, seen := range wantErrorTypes {
		if !seen {
			t.Fatalf("Identity dependency metrics omit error.type=%q", errorType)
		}
	}
}

func assertDependencyMetricAttributes(
	t *testing.T, attributes attribute.Set, observedErrorTypes map[string]bool,
) {
	t.Helper()
	want := map[string]string{
		"rpc.service": "identity-service",
		"rpc.method":  "resolve_principal",
	}
	values := attributes.ToSlice()
	if len(values) != 4 {
		t.Fatalf("Identity dependency metric attributes=%v want four bounded fields", values)
	}
	for _, value := range values {
		key := string(value.Key)
		switch key {
		case "rpc.service", "rpc.method":
			if value.Value.AsString() != want[key] {
				t.Fatalf("Identity dependency metric %s=%q want=%q", key, value.Value.AsString(), want[key])
			}
		case "antnest.result":
			if result := value.Value.AsString(); result != "success" && result != "error" {
				t.Fatalf("Identity dependency metric result=%q", result)
			}
		case "error.type":
			if _, allowed := observedErrorTypes[value.Value.AsString()]; !allowed {
				t.Fatalf("Identity dependency metric error.type=%q", value.Value.AsString())
			}
			observedErrorTypes[value.Value.AsString()] = true
		default:
			t.Fatalf("Identity dependency metric exposes unbounded attribute %q", key)
		}
	}
}

func assertDependencyFailure(t *testing.T, err error, code string, retryable bool) {
	t.Helper()
	failure, ok := err.(*ports.DependencyError)
	if !ok || failure.Code != code || failure.Retryable != retryable {
		t.Fatalf("dependency failure=%#v want code=%q retryable=%t", err, code, retryable)
	}
}
