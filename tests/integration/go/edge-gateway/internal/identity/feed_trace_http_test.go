package identity

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/telemetry"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

func TestSessionRevocationMethodOnRealHTTPBoundary(t *testing.T) {
	for _, mode := range []string{"success", "unavailable", "deadline", "connection-refused", "redirect"} {
		t.Run(mode, func(t *testing.T) {
			recorder := recordFeedSpans(t)
			var redirected atomic.Int32
			peer := httptest.NewServer(telemetry.HTTPHandler(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
				if request.URL.Path == "/rpc/identity/resolve-access-token" {
					redirected.Add(1)
					response.WriteHeader(500)
					return
				}
				if request.Method != http.MethodPost || request.URL.Path != "/rpc/identity/list-session-revocations" || request.Header.Get(CallerContextHeader) != "" {
					t.Error("actual feed HTTP request changed")
				}
				var input map[string]int
				if err := json.NewDecoder(request.Body).Decode(&input); err != nil || input["after_sequence"] != 15 || input["limit"] != 500 || len(input) != 2 {
					t.Error("actual feed request body changed")
				}
				if mode == "deadline" {
					<-request.Context().Done()
					return
				}
				if mode == "unavailable" {
					response.WriteHeader(503)
					_, _ = io.WriteString(response, `{"code":"unavailable","message":"private-error"}`)
					return
				}
				if mode == "redirect" {
					response.Header().Set("Location", "/rpc/identity/resolve-access-token")
					response.WriteHeader(http.StatusTemporaryRedirect)
					return
				}
				response.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(response, `{"events":[],"next_sequence":15}`)
			}), nil))
			defer peer.Close()
			if mode == "connection-refused" {
				peer.Close()
			}
			client, err := NewClient(peer.URL, productionFeedHTTPClient(t, peer.URL))
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			page, err := client.ListSessionRevocations(ctx, 15, 500)
			if mode == "success" {
				if err != nil || page.NextSequence != 15 || len(page.Events) != 0 {
					t.Fatalf("actual response changed: %v", err)
				}
			} else if err == nil {
				t.Fatal("real HTTP failure disappeared")
			}
			if mode == "deadline" && !errors.Is(err, context.DeadlineExceeded) {
				t.Fatalf("real HTTP deadline was replaced: %v", err)
			}
			peer.Close() // Join the actual receiver before inspecting ended spans.
			if redirected.Load() != 0 {
				t.Fatal("feed context followed a redirect to a different RPC")
			}
			var clientSpan, serverSpan sdktrace.ReadOnlySpan
			for _, span := range recorder.Ended() {
				switch span.SpanKind() {
				case trace.SpanKindClient:
					if clientSpan != nil {
						t.Fatal("extra CLIENT created for one real feed attempt")
					}
					clientSpan = span
				case trace.SpanKindServer:
					if serverSpan != nil {
						t.Fatal("extra SERVER created for one real feed attempt")
					}
					serverSpan = span
				default:
					t.Fatal("feed method witness created a wrapper span")
				}
			}
			if clientSpan == nil || clientSpan.Parent().IsValid() {
				t.Fatal("independent feed attempt lost its actual CLIENT root")
			}
			assertFeedMethod(t, clientSpan, true)
			if (clientSpan.Status().Code == codes.Error) != (mode != "success" && mode != "redirect") {
				t.Fatal("actual failure status changed")
			}
			if mode == "connection-refused" {
				if serverSpan != nil {
					t.Fatal("receiver was invented for a refused connection")
				}
			} else if serverSpan == nil || serverSpan.Parent().SpanID() != clientSpan.SpanContext().SpanID() || serverSpan.SpanContext().TraceID() != clientSpan.SpanContext().TraceID() {
				t.Fatal("actual CLIENT -> HTTP SERVER propagation was lost")
			}
		})
	}
}

func productionFeedHTTPClient(t *testing.T, endpoint string) *http.Client {
	t.Helper()
	directory := t.TempDir()
	callers := filepath.Join(directory, "callers.json")
	if err := os.WriteFile(callers, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "identity-service"), []byte(strings.Repeat("Q", 43)), 0o600); err != nil {
		t.Fatal(err)
	}
	values := map[string]string{
		"ANTNEST_SERVICE_AUTH_MODE": "token", "ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT": "true",
		"ANTNEST_SERVICE_AUTH_CALLERS_FILE": callers, "ANTNEST_SERVICE_AUTH_TOKEN_DIR": directory,
	}
	auth, err := serviceauth.LoadOutbound("edge-gateway", serviceauth.GatewayHeaders, func(key string) (string, bool) {
		value, present := values[key]
		return value, present
	}, map[string]string{"identity-service": endpoint})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(auth.CloseIdleConnections)
	client := auth.HTTPClient()
	client.Transport = telemetry.NewHTTPTransport(client.Transport)
	return client
}
