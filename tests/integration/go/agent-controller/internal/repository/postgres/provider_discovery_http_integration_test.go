package postgres

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"go.opentelemetry.io/otel"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	"github.com/stretchr/testify/require"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/authfixture"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/credentials"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/outbound"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/providerdiscovery"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/telemetry"
)

func TestDiscoveryHTTPBoundaryDoesNotExposeCredentialInResponseLogsOrSpans(t *testing.T) {
	repository := providerTestRepository(t)
	t.Setenv("ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT", "true")
	recorder := tracetest.NewSpanRecorder()
	previous := otel.GetTracerProvider()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	otel.SetTracerProvider(provider)
	t.Cleanup(func() { otel.SetTracerProvider(previous); require.NoError(t, provider.Shutdown(context.Background())) })
	secret := "synthetic-controller-provider-secret"
	received := []string{}
	status := http.StatusOK
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		received = append(received, r.Header.Get("Authorization"))
		if r.Header.Get("Antnest-Service-Authorization") != "" || r.Header.Get("Antnest-Caller-Context") != "" {
			t.Error("service authority reached Provider")
		}
		w.WriteHeader(status)
		if status == http.StatusOK {
			_, _ = io.WriteString(w, `{"data":[{"id":"fixture-model"}]}`)
		} else {
			_, _ = io.WriteString(w, secret)
		}
	}))
	defer upstream.Close()
	policy := outbound.NewPolicy(true)
	client := providerdiscovery.New(time.Second, policy)
	defer client.CloseIdleConnections()
	box, err := credentials.NewSecretBox(make([]byte, 32))
	require.NoError(t, err)
	catalog := application.NewCatalogService(repository, box, providerTestClock{},
		application.WithProviderCredentialReader(repository, box), application.WithProviderDiscovery(policy, client))
	input := providerTestInput("discovery-http-create", "org")
	input.BaseURL = upstream.URL
	input.Credential.APIKey = secret
	connection, err := catalog.CreateProviderConnection(t.Context(), input)
	require.NoError(t, err)
	unused := &unusedCatalogDependencies{}
	boundary, err := authfixture.NewHandler(t, catalog, unused, unused, unused, unused, unused, func(context.Context) error { return nil })
	require.NoError(t, err)
	var logs bytes.Buffer
	boundary = telemetry.HTTPHandler(boundary, slog.New(slog.NewJSONHandler(&logs, nil)))
	for _, scenario := range []struct {
		path, body     string
		expected       int
		upstreamStatus int
	}{
		{"/internal/provider-connections/" + connection.ConnectionID + "/access?organization_id=org", "", 404, 200},
		{"/internal/provider-connections/" + connection.ConnectionID + "/discover-models", `{"organization_id":"org"}`, 200, 200},
		{"/internal/provider-discovery/draft", `{"organization_id":"org","provider_key":"deepseek","base_url":"` + upstream.URL + `","credential":{"method":"api_key","api_key":"` + secret + `"}}`, 200, 200},
		{"/internal/provider-connections/" + connection.ConnectionID + "/discover-models", `{"organization_id":"org"}`, 502, 401},
	} {
		status = scenario.upstreamStatus
		method := http.MethodPost
		if scenario.body == "" {
			method = http.MethodGet
		}
		response := httptest.NewRecorder()
		boundary.ServeHTTP(response, httptest.NewRequest(method, scenario.path, strings.NewReader(scenario.body)))
		require.Equal(t, scenario.expected, response.Code, response.Body.String())
		require.NotContains(t, response.Body.String(), secret)
	}
	require.Equal(t, []string{"Bearer " + secret, "Bearer " + secret, "Bearer " + secret}, received)
	require.NotContains(t, logs.String(), secret)
	for _, span := range recorder.Ended() {
		require.NotContains(t, fmt.Sprint(span.Attributes()), secret)
		for _, event := range span.Events() {
			require.NotContains(t, fmt.Sprint(event.Attributes), secret)
			require.NotEqual(t, "antnest.request", event.Name)
			require.NotEqual(t, "antnest.response", event.Name)
		}
	}
}
