package identityclient

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func TestIdentityHTTPSpansDistinguishSuccessfulCallsFromDependencyFailures(t *testing.T) {
	for _, operation := range []struct {
		name, body string
		invoke     func(*Client, context.Context) error
	}{
		{"resolve_principal", `{"principal":{"user_id":"user-1","organization_id":"org-1","membership_id":"member-1","active":true}}`, func(client *Client, ctx context.Context) error {
			_, err := client.ResolvePrincipal(ctx, "org-1", "user-1")
			return err
		}},
		{"resolve_owner_authorization", `{"authorization":{"user_id":"user-1","organization_id":"org-1","membership_id":"member-1","active":true,"last_revocation_sequence":0}}`, func(client *Client, ctx context.Context) error {
			_, err := client.ResolveOwnerAuthorization(ctx, "org-1", "user-1")
			return err
		}},
		{"list_principal_revocations", `{"events":[],"next_sequence":0}`, func(client *Client, ctx context.Context) error {
			_, err := client.ListPrincipalRevocations(ctx, 0, 10)
			return err
		}},
	} {
		for _, scenario := range []struct {
			name    string
			status  int
			failure bool
		}{
			{"success", http.StatusOK, false},
			{"dependency_rejection", http.StatusNotFound, true},
			{"invalid_success_body", http.StatusOK, true},
		} {
			t.Run(operation.name+"/"+scenario.name, func(t *testing.T) {
				recorder := tracetest.NewSpanRecorder()
				provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
				previous := otel.GetTracerProvider()
				otel.SetTracerProvider(provider)
				t.Cleanup(func() {
					otel.SetTracerProvider(previous)
					if err := provider.Shutdown(context.Background()); err != nil {
						t.Error(err)
					}
				})
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
					w.Header().Set("Content-Type", "application/json")
					w.WriteHeader(scenario.status)
					body := operation.body
					if scenario.status == http.StatusNotFound {
						body = `{"code":"not_found","message":"missing","retryable":false}`
					} else if scenario.failure {
						body = `{}`
					}
					_, _ = w.Write([]byte(body))
				}))
				defer server.Close()
				client, err := New(server.URL, time.Second, server.Client())
				if err != nil {
					t.Fatal(err)
				}
				ctx, parent := provider.Tracer("identity-client-test").Start(t.Context(), "caller")
				err = operation.invoke(client, ctx)
				parent.End()
				if (err != nil) != scenario.failure {
					t.Fatalf("dependency result=%v want failure=%t", err, scenario.failure)
				}
				if scenario.failure {
					if _, ok := err.(*ports.DependencyError); !ok {
						t.Fatalf("dependency error type=%T", err)
					}
				}
				var clients []sdktrace.ReadOnlySpan
				for _, span := range recorder.Ended() {
					if span.SpanKind() == trace.SpanKindClient {
						clients = append(clients, span)
					}
				}
				if len(clients) != 1 {
					t.Fatalf("HTTP CLIENT spans=%d want one", len(clients))
				}
				span := clients[0]
				if span.Parent().SpanID() != parent.SpanContext().SpanID() {
					t.Fatal("Identity HTTP exchange lost caller parent")
				}
				attributes := map[string]string{}
				for _, attribute := range span.Attributes() {
					attributes[string(attribute.Key)] = attribute.Value.AsString()
				}
				if attributes["rpc.method"] != operation.name {
					t.Fatalf("RPC method=%q", attributes["rpc.method"])
				}
				if scenario.failure {
					if span.Status().Code != codes.Error || attributes["antnest.result"] != "error" || attributes["error.type"] == "" || attributes["error.type"] == "none" {
						t.Fatalf("dependency failure lost error diagnostics: status=%v attributes=%v", span.Status(), attributes)
					}
				} else {
					if span.Status().Code == codes.Error || attributes["antnest.result"] != "success" {
						t.Fatalf("successful dependency marked failed: status=%v attributes=%v", span.Status(), attributes)
					}
					if value, exists := attributes["error.type"]; exists {
						t.Fatalf("successful HTTP CLIENT carries error.type=%q", value)
					}
				}
			})
		}
	}
}
