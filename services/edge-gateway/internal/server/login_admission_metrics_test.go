package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"go.opentelemetry.io/otel"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
)

func recordLoginAdmissionMetrics(t *testing.T) *sdkmetric.ManualReader {
	t.Helper()
	reader := sdkmetric.NewManualReader()
	provider := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))
	previous := otel.GetMeterProvider()
	otel.SetMeterProvider(provider)
	t.Cleanup(func() {
		if err := provider.Shutdown(context.Background()); err != nil {
			t.Error(err)
		}
		otel.SetMeterProvider(previous)
	})
	return reader
}

func collectLoginAdmissionMetrics(t *testing.T, reader *sdkmetric.ManualReader) map[string]int64 {
	t.Helper()
	var resource metricdata.ResourceMetrics
	if err := reader.Collect(context.Background(), &resource); err != nil {
		t.Fatal(err)
	}
	result := make(map[string]int64)
	for _, scope := range resource.ScopeMetrics {
		for _, metric := range scope.Metrics {
			if metric.Name != "antnest_edge_login_admission_total" {
				continue
			}
			sum, ok := metric.Data.(metricdata.Sum[int64])
			if !ok || !sum.IsMonotonic {
				t.Fatalf("admission metric is not a monotonic integer counter: %+v", metric)
			}
			for _, point := range sum.DataPoints {
				if point.Attributes.Len() != 2 {
					t.Fatalf("unexpected admission metric attributes: %v", point.Attributes)
				}
				flow, flowOK := point.Attributes.Value("flow")
				outcome, outcomeOK := point.Attributes.Value("outcome")
				if !flowOK || !outcomeOK {
					t.Fatalf("missing fixed admission labels: %v", point.Attributes)
				}
				result[flow.AsString()+"/"+outcome.AsString()] += point.Value
			}
		}
	}
	return result
}

func TestLoginAdmissionMetricsCountEachDecisionOnce(t *testing.T) {
	reader := recordLoginAdmissionMetrics(t)
	stub := &identityServiceStub{}
	handler := newTestHandlerWithConfig(t, stub, http.NotFoundHandler(), time.Now(), Config{
		LoginWindow: time.Minute, LoginSourceMax: 2, LoginAccountMax: 1,
	})
	for _, fixture := range []struct {
		source, email string
		status        int
	}{
		{"192.0.2.10:1234", "alpha@example.com", http.StatusUnauthorized},
		{"192.0.2.11:1234", "alpha@example.com", http.StatusTooManyRequests},
		{"192.0.2.10:1234", "beta@example.com", http.StatusUnauthorized},
		{"192.0.2.10:1234", "alpha@example.com", http.StatusTooManyRequests},
	} {
		body := `{"organization_slug":"engineering","email":"` + fixture.email + `","password":"wrong"}`
		response := loginAdmissionRequest(handler, "/api/session/login", fixture.source, body)
		if response.Code != fixture.status {
			t.Fatalf("login status=%d want=%d", response.Code, fixture.status)
		}
	}
	want := map[string]int64{"password/admitted": 2, "password/account_limited": 1, "password/source_limited": 1}
	if got := collectLoginAdmissionMetrics(t, reader); !reflect.DeepEqual(got, want) {
		t.Fatalf("admission decisions=%v want=%v", got, want)
	}
	if stub.loginCalls != 2 {
		t.Fatalf("Identity password calls=%d want=2", stub.loginCalls)
	}
}

func TestLoginAdmissionMetricsCountBothTableEvictionsAsOneDecision(t *testing.T) {
	reader := recordLoginAdmissionMetrics(t)
	stub := newOIDCAdmissionStub()
	handler := newTestHandlerWithConfig(t, stub, http.NotFoundHandler(), time.Now(), Config{
		LoginWindow: time.Minute, LoginSourceMax: 1, LoginAccountMax: 1,
		LoginMaxKeys: 1, OIDCStartSourceMax: 1,
	})
	for _, fixture := range []struct {
		source, email string
		status        int
	}{
		{"192.0.2.1:1234", "alpha@example.com", http.StatusUnauthorized},
		{"192.0.2.2:1234", "beta@example.com", http.StatusUnauthorized},
		{"192.0.2.2:1234", "beta@example.com", http.StatusTooManyRequests},
		{"192.0.2.3:1234", "beta@example.com", http.StatusTooManyRequests},
		{"192.0.2.2:1234", "gamma@example.com", http.StatusTooManyRequests},
	} {
		body := `{"organization_slug":"engineering","email":"` + fixture.email + `","password":"wrong"}`
		if response := loginAdmissionRequest(handler, "/api/session/login", fixture.source, body); response.Code != fixture.status {
			t.Fatalf("password status=%d want=%d", response.Code, fixture.status)
		}
	}
	for index, source := range []string{"192.0.2.1:1234", "192.0.2.1:1234", "192.0.2.2:1234"} {
		response := loginAdmissionRequest(handler, "/api/session/oidc/start", source, oidcAdmissionBody)
		want := http.StatusOK
		if index == 1 {
			want = http.StatusTooManyRequests
		}
		if response.Code != want {
			t.Fatalf("OIDC status=%d want=%d", response.Code, want)
		}
	}
	want := map[string]int64{
		"password/admitted": 1, "password/evicted": 1, "password/source_limited": 2, "password/account_limited": 1,
		"oidc_start/admitted": 1, "oidc_start/source_limited": 1, "oidc_start/evicted": 1,
	}
	if got := collectLoginAdmissionMetrics(t, reader); !reflect.DeepEqual(got, want) {
		t.Fatalf("admission decisions=%v want=%v", got, want)
	}
	if stub.loginCalls != 2 || stub.startOIDCCalls != 2 {
		t.Fatalf("upstream password/OIDC=%d/%d want=2/2", stub.loginCalls, stub.startOIDCCalls)
	}
}

func TestLoginAdmissionMetricsPruningIsNotEviction(t *testing.T) {
	reader := recordLoginAdmissionMetrics(t)
	now := time.Now()
	stub := &identityServiceStub{}
	h := newTestHandlerWithConfig(t, stub, http.NotFoundHandler(), now, Config{
		LoginWindow: time.Minute, LoginSourceMax: 1, LoginAccountMax: 1, LoginMaxKeys: 1,
	})
	h.(*handler).loginAdmission.now = func() time.Time { return now }
	for index, source := range []string{"192.0.2.1:1234", "192.0.2.2:1234"} {
		if index == 1 {
			now = now.Add(time.Minute)
		}
		body := `{"organization_slug":"engineering","email":"` + source + `","password":"wrong"}`
		if response := loginAdmissionRequest(h, "/api/session/login", source, body); response.Code != http.StatusUnauthorized {
			t.Fatalf("password status=%d", response.Code)
		}
	}
	if got := collectLoginAdmissionMetrics(t, reader); !reflect.DeepEqual(got, map[string]int64{"password/admitted": 2}) {
		t.Fatalf("expiry pruning was counted as an eviction: %v", got)
	}
}

func TestLoginAdmissionMetricsExcludeValidationFailures(t *testing.T) {
	reader := recordLoginAdmissionMetrics(t)
	stub := newOIDCAdmissionStub()
	h := newTestHandlerWithConfig(t, stub, http.NotFoundHandler(), time.Now(), Config{
		LoginSourceMax: 1, LoginAccountMax: 1, OIDCStartSourceMax: 1,
	})
	passwordBody := `{"organization_slug":"engineering","email":"alice@example.com","password":"wrong"}`
	for _, route := range []struct{ path, body string }{
		{"/api/session/login", passwordBody},
		{"/api/session/oidc/start", oidcAdmissionBody},
	} {
		for _, invalid := range []struct {
			body, origin string
			status       int
		}{
			{route.body, "https://attacker.example", http.StatusForbidden},
			{"{}", "", http.StatusBadRequest},
			{"{", "", http.StatusBadRequest},
		} {
			request := newBrowserRequest(http.MethodPost, route.path, strings.NewReader(invalid.body))
			request.RemoteAddr = "192.0.2.1:1234"
			request.Header.Set("Content-Type", "application/json")
			if invalid.origin != "" {
				request.Header.Set("Origin", invalid.origin)
			}
			response := httptest.NewRecorder()
			h.ServeHTTP(response, request)
			if response.Code != invalid.status {
				t.Fatalf("guard status=%d want=%d", response.Code, invalid.status)
			}
		}
	}
	if got := collectLoginAdmissionMetrics(t, reader); len(got) != 0 || stub.loginCalls != 0 || stub.startOIDCCalls != 0 {
		t.Fatalf("invalid requests reached admission or Identity: metrics=%v password/OIDC=%d/%d", got, stub.loginCalls, stub.startOIDCCalls)
	}
	for _, route := range []struct {
		path, body string
		status     int
	}{
		{"/api/session/login", passwordBody, http.StatusUnauthorized},
		{"/api/session/oidc/start", oidcAdmissionBody, http.StatusOK},
	} {
		if response := loginAdmissionRequest(h, route.path, "192.0.2.1:1234", route.body); response.Code != route.status {
			t.Fatalf("first valid attempt status=%d want=%d", response.Code, route.status)
		}
	}
	want := map[string]int64{"password/admitted": 1, "oidc_start/admitted": 1}
	if got := collectLoginAdmissionMetrics(t, reader); !reflect.DeepEqual(got, want) || stub.loginCalls != 1 || stub.startOIDCCalls != 1 {
		t.Fatalf("valid requests lost budgets: metrics=%v password/OIDC=%d/%d", got, stub.loginCalls, stub.startOIDCCalls)
	}
}

func TestLoginAdmissionMetricsRemainSingleAfterIdentityPasswordRefusal(t *testing.T) {
	for _, failure := range []browserRPCFailure{
		{503, passwordBusyJSON, []string{"1"}},
		{429, passwordRateJSON, []string{"900"}},
	} {
		t.Run(http.StatusText(failure.status), func(t *testing.T) {
			reader := recordLoginAdmissionMetrics(t)
			f := newBrowserControlFixture(t)
			f.mu.Lock()
			f.failures["local-login"] = failure
			f.mu.Unlock()
			response := httptest.NewRecorder()
			f.handler.ServeHTTP(response, f.request(http.MethodPost, "/api/session/login",
				`{"organization_slug":"engineering","email":"member@example.com","password":"wrong"}`))
			if response.Code != failure.status || strings.TrimSpace(response.Body.String()) != failure.body ||
				response.Header().Get("Cache-Control") != "no-store" || len(response.Header().Values("Set-Cookie")) != 0 ||
				!reflect.DeepEqual(response.Header().Values("Retry-After"), failure.retryAfter) {
				t.Fatal("Gateway admission changed the typed Identity refusal")
			}
			if calls := f.calls(); len(calls) != 1 || calls[0].Path != "local-login" {
				t.Fatal("Identity refusal replayed or performed unrelated work")
			}
			if got := collectLoginAdmissionMetrics(t, reader); !reflect.DeepEqual(got, map[string]int64{"password/admitted": 1}) {
				t.Fatalf("downstream refusal changed admission decision count: %v", got)
			}
		})
	}
}
