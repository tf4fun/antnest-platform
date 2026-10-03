package upstream

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
	"github.com/tf4fun/antnest-platform/services/admin-console/internal/callercontext"
	"github.com/tf4fun/antnest-platform/services/admin-console/internal/principal"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
)

func TestClientForwardsVerifiedCallerContextUnchanged(t *testing.T) {
	actor := principal.Principal{UserID: "admin", OrganizationID: "org-1", MembershipID: "membership-1", SystemRole: "admin", OrganizationRole: "member"}
	ctx := callercontext.WithToken(principal.WithContext(t.Context(), actor), "verified-context-from-private-request-state")
	for _, target := range []Target{Identity, AgentController, AgentACP} {
		client, err := NewClient(Config{IdentityURL: "http://identity.internal", AgentControllerURL: "http://controller.internal", AgentACPURL: "http://acp.internal", HTTPClient: &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
			if r.Header.Get(callercontext.Header) != "verified-context-from-private-request-state" {
				t.Error("verified context was lost or replaced")
			}
			if r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" {
				t.Error("user credentials were leaked")
			}
			return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader("{}"))}, nil
		})}})
		if err != nil {
			t.Fatal(err)
		}
		res, err := client.Do(ctx, target, "POST", "/rpc/test", "", []byte("{}"))
		if err != nil {
			t.Fatal(err)
		}
		_ = res.Body.Close()
	}
}

func TestAuditUsesSignedContextWithoutLegacyHeaderEncoding(t *testing.T) {
	actor := principal.Principal{UserID: "用户,admin", OrganizationID: "组织-1", MembershipID: "成员-1", SystemRole: "user", OrganizationRole: "admin"}
	client, err := NewClient(Config{IdentityURL: "http://identity.internal", AgentControllerURL: "http://controller.internal", AgentACPURL: "http://acp.internal", HTTPClient: &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.Header.Get(callercontext.Header) != "verified-context" {
			t.Error("signed context was changed")
		}
		for name := range r.Header {
			if strings.HasPrefix(strings.ToLower(name), "x-antnest-") {
				t.Error("legacy identity headers were emitted")
			}
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader("{}"))}, nil
	})}})
	if err != nil {
		t.Fatal(err)
	}
	ctx := callercontext.WithToken(principal.WithContext(t.Context(), actor), "verified-context")
	res, err := client.Do(ctx, AgentACP, "POST", "/rpc/agent-acp/list-execution-audits", "", []byte("{}"))
	if err != nil {
		t.Fatal("verified actor was restricted by legacy header encoding")
	}
	_ = res.Body.Close()
}

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
		IdentityURL: "http://identity.internal", AgentControllerURL: "http://agent-controller.internal", AgentACPURL: "http://acp.internal",
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

func TestACPDispatchRequiresAnAdministratorContext(t *testing.T) {
	t.Parallel()
	requests := 0
	httpClient := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		requests++
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(`{}`))}, nil
	})}
	client, err := NewClient(Config{IdentityURL: "http://identity.internal", AgentControllerURL: "http://controller.internal", AgentACPURL: "http://acp.internal", HTTPClient: httpClient})
	require.NoError(t, err)
	_, err = client.Do(t.Context(), AgentACP, http.MethodPost, "/rpc/agent-acp/list-execution-audits", "", []byte(`{}`))
	require.Error(t, err)
	for _, actor := range []principal.Principal{
		{UserID: "user", OrganizationID: "org", MembershipID: "member", SystemRole: "user", OrganizationRole: "member"},
		{UserID: "user,other", OrganizationID: "org", MembershipID: "member", SystemRole: "admin", OrganizationRole: "member"},
		{UserID: "user", OrganizationID: "org", SystemRole: "admin", OrganizationRole: "member"},
	} {
		_, err := client.Do(principal.WithContext(t.Context(), actor), AgentACP, http.MethodPost, "/rpc/agent-acp/list-execution-audits", "", []byte(`{}`))
		require.Error(t, err)
	}
	require.Zero(t, requests)
}

func TestACPIdentityDoesNotLeakToOtherUpstreams(t *testing.T) {
	t.Parallel()
	actor := principal.Principal{UserID: "user", OrganizationID: "org", MembershipID: "member", SystemRole: "admin", OrganizationRole: "member"}
	httpClient := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		require.Empty(t, request.Header.Get(principal.HeaderUserID))
		require.Empty(t, request.Header.Get(principal.HeaderMembershipID))
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(`{}`))}, nil
	})}
	client, err := NewClient(Config{IdentityURL: "http://identity.internal", AgentControllerURL: "http://controller.internal", AgentACPURL: "http://acp.internal", HTTPClient: httpClient})
	require.NoError(t, err)
	for _, target := range []Target{Identity, AgentController} {
		response, err := client.Do(principal.WithContext(t.Context(), actor), target, http.MethodGet, "/status", "", nil)
		require.NoError(t, err)
		require.NoError(t, response.Body.Close())
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
		client, err := NewClient(Config{IdentityURL: "http://identity.internal", AgentControllerURL: "http://controller.internal", AgentACPURL: "http://acp.internal", HTTPClient: httpClient})
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
