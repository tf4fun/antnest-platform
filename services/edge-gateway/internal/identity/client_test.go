package identity

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/telemetry"
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
			"principal":{"user_id":"user-1","organization_id":"org-1","organization_slug":"engineering","organization_name":"Engineering","membership_id":"member-1","system_role":"admin","organization_role":"admin","active":true}
		}`), nil
	})}
	client, err := NewClient("http://identity.internal", &http.Client{Transport: telemetry.NewHTTPTransport(httpClient.Transport)})
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

func TestResolveRejectsIncompleteAuthorityResponse(t *testing.T) {
	for _, payload := range []string{
		`{}`, `{"principal":null}`, `{"principal":{}}`,
		`{"principal":{"user_id":"u","organization_id":"o","membership_id":"m"}}`,
		`{"principal":{"user_id":"u","organization_id":"o","membership_id":"m","active":null}}`,
		`{"principal":{"user_id":"u","organization_id":"","membership_id":"m","active":true}}`,
	} {
		t.Run(payload, func(t *testing.T) {
			client, err := NewClient("http://identity.internal", &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
				return jsonResponse(http.StatusOK, payload), nil
			})})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := client.Resolve(context.Background(), "secret"); err == nil || IsCode(err, "unauthenticated") {
				t.Fatalf("malformed authority must be unavailable, got %v", err)
			}
		})
	}
}

func TestResolvePreservesExplicitInactivePrincipal(t *testing.T) {
	contextJSON, _ := json.Marshal(testIssuerContext(t))
	client, err := NewClient("http://identity.internal", &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return jsonResponse(http.StatusOK, `{"caller_context":`+string(contextJSON)+`,"principal":{"user_id":"u","organization_id":"o","organization_slug":"engineering","organization_name":"Engineering","membership_id":"m","active":false}}`), nil
	})})
	if err != nil {
		t.Fatal(err)
	}
	principal, err := client.Resolve(context.Background(), "secret")
	if err != nil || principal.Active || principal.UserID != "u" {
		t.Fatalf("explicit inactive principal lost: %v %v", principal, err)
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

func TestClientSupportsBrowserOIDCFlow(t *testing.T) {
	type observedRequest struct {
		query   string
		payload []byte
	}
	requests := make([]observedRequest, 0, 3)
	httpClient := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		var payload []byte
		if request.Body != nil {
			payload, _ = io.ReadAll(request.Body)
		}
		requests = append(requests, observedRequest{
			query: request.URL.RawQuery, payload: payload,
		})
		switch request.URL.Path {
		case "/rpc/identity/list-login-methods":
			return jsonResponse(http.StatusOK, `{"methods":[{"name":"workforce","display_name":"Workforce"}]}`), nil
		case "/rpc/identity/start-oidc-login":
			return jsonResponse(http.StatusOK, `{"authorization_url":"https://id.example.test/authorize?state=secret-state","expires_at":"2026-09-02T13:00:00Z"}`), nil
		case "/protocol/oidc/callback":
			return jsonResponse(http.StatusOK, `{
				"token_id":"token-1","access_token":"ant_api_secret","expires_at":"2026-09-02T13:00:00Z",
				"principal":{"user_id":"user-1","organization_id":"org-1","organization_slug":"engineering","organization_name":"Engineering","membership_id":"member-1","system_role":"user","organization_role":"member","active":true}
			}`), nil
		default:
			t.Fatalf("unexpected path=%s", request.URL.Path)
			return nil, nil
		}
	})}
	client, err := NewClient("http://identity.internal", httpClient)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}

	methods, err := client.ListLoginMethods(context.Background(), "engineering")
	if err != nil || len(methods) != 1 || methods[0].Name != "workforce" {
		t.Fatalf("methods=%#v err=%v", methods, err)
	}
	start, err := client.StartOIDCLogin(context.Background(), StartOIDCLoginInput{
		RequestID: "request-oidc", OrganizationSlug: "engineering", ProviderName: "workforce",
	})
	if err != nil || !strings.Contains(start.AuthorizationURL, "state=secret-state") {
		t.Fatalf("start=%#v err=%v", start, err)
	}
	completed, err := client.CompleteOIDCLogin(context.Background(), OIDCCallbackInput{
		State: "secret-state", Code: "secret-code",
	})
	if err != nil || completed.AccessToken != "ant_api_secret" || completed.Principal.UserID != "user-1" {
		t.Fatalf("completed=%#v err=%v", completed, err)
	}

	var listBody, startBody map[string]any
	_ = json.Unmarshal(requests[0].payload, &listBody)
	_ = json.Unmarshal(requests[1].payload, &startBody)
	if listBody["organization_slug"] != "engineering" ||
		startBody["provider_name"] != "workforce" || startBody["request_id"] != "request-oidc" {
		t.Fatalf("list=%v start=%v", listBody, startBody)
	}
	callbackQuery, err := url.ParseQuery(requests[2].query)
	if err != nil {
		t.Fatalf("parse callback query: %v", err)
	}
	if callbackQuery.Get("state") != "secret-state" ||
		callbackQuery.Get("code") != "secret-code" || requests[2].query == "" {
		t.Fatalf("callback query was not forwarded")
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
