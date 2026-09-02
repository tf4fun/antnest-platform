package identity

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

func TestClientCallsIdentityContractAndPropagatesTrace(t *testing.T) {
	var traceparent string
	httpClient := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		traceparent = request.Header.Get("traceparent")
		if request.URL.Path != "/rpc/identity/local-login" {
			t.Fatalf("path=%s", request.URL.Path)
		}
		return jsonResponse(http.StatusOK, `{
			"token_id":"token-1","access_token":"ant_api_secret","expires_at":"2026-09-02T13:00:00Z",
			"principal":{"user_id":"user-1","organization_id":"org-1","membership_id":"member-1","system_role":"admin","organization_role":"admin","active":true}
		}`), nil
	})}
	client, err := NewClient("http://identity.internal", httpClient)
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
	ctx, span := otel.Tracer("identity-client-test").Start(context.Background(), "root")
	defer span.End()

	result, err := client.Login(ctx, LoginInput{
		RequestID: "request-1", OrganizationSlug: "engineering",
		Email: "admin@example.com", Password: "secret",
	})
	if err != nil || result.Principal.UserID != "user-1" || result.AccessToken != "ant_api_secret" {
		t.Fatalf("Login result=%#v err=%v", result, err)
	}
	if traceparent == "" {
		t.Fatal("traceparent was not injected")
	}
}

func TestClientReturnsStableRemoteErrorWithoutCredentialLeak(t *testing.T) {
	httpClient := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return jsonResponse(http.StatusUnauthorized,
			`{"code":"unauthenticated","message":"invalid credentials","retryable":false}`), nil
	})}
	client, err := NewClient("http://identity.internal", httpClient)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	_, err = client.Resolve(context.Background(), "ant_api_do_not_leak")
	if err == nil || !IsCode(err, "unauthenticated") {
		t.Fatalf("Resolve error=%v", err)
	}
	if strings.Contains(err.Error(), "ant_api_do_not_leak") {
		t.Fatalf("credential leaked in error: %v", err)
	}
}

func TestClientRevokesByAccessTokenAndValidatesStatus(t *testing.T) {
	var requestBody string
	httpClient := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		payload, _ := io.ReadAll(request.Body)
		requestBody = string(payload)
		return jsonResponse(http.StatusOK, `{"status":"already_invalid"}`), nil
	})}
	client, err := NewClient("http://identity.internal", httpClient)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	status, err := client.RevokeByAccessToken(context.Background(), "ant_api_secret")
	if err != nil || status != RevokeStatusAlreadyInvalid {
		t.Fatalf("status=%q err=%v", status, err)
	}
	if !strings.Contains(requestBody, `"access_token":"ant_api_secret"`) ||
		strings.Contains(requestBody, "token_id") {
		t.Fatalf("revoke request=%s", requestBody)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (function roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}

func jsonResponse(status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       io.NopCloser(strings.NewReader(body)),
	}
}
