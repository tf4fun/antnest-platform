package agentcontroller

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/telemetry"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
)

func TestClientPropagatesTraceContext(t *testing.T) {
	var traceparent string
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		traceparent = request.Header.Get("traceparent")
		_, _ = response.Write([]byte(`{"agents":[],"next_cursor":null}`))
	}))
	defer server.Close()
	client, err := NewClient(server.URL, &http.Client{Transport: telemetry.NewHTTPTransport(server.Client().Transport)})
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
	ctx, span := otel.Tracer("agent-controller-client-test").Start(context.Background(), "root")
	defer span.End()

	_, err = client.ListWorkspaceAgents(ctx, ListWorkspaceAgentsInput{
		RequestID: "request", OrganizationID: "org-1", PrincipalID: "user-1",
	})
	if err != nil {
		t.Fatalf("ListWorkspaceAgents: %v", err)
	}
	if traceparent == "" {
		t.Fatal("traceparent was not injected")
	}
}

func TestClientCollectsWorkspacePagesWithoutChangingPrincipalScope(t *testing.T) {
	t.Parallel()

	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		requests++
		if request.URL.Path != "/rpc/agent-controller/list-workspace-agents" || request.Method != http.MethodPost {
			t.Fatalf("request = %s %s", request.Method, request.URL.Path)
		}
		var payload map[string]any
		if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if payload["organization_id"] != "org-1" || payload["principal_id"] != "user-1" {
			t.Fatalf("scope = %+v", payload)
		}
		response.Header().Set("Content-Type", "application/json")
		if requests == 1 {
			_, _ = response.Write([]byte(`{"agents":[{"agent_id":"agent-1","name":"One","lifecycle_state":"created","activation_state":"disabled","runtime_state":"exited"}],"next_cursor":"cursor-1"}`))
			return
		}
		if payload["cursor"] != "cursor-1" {
			t.Fatalf("cursor = %+v", payload["cursor"])
		}
		_, _ = response.Write([]byte(`{"agents":[{"agent_id":"agent-2","name":"Two","lifecycle_state":"not_created","runtime_state":"unknown"}],"next_cursor":null}`))
	}))
	defer server.Close()
	client, err := NewClient(server.URL, server.Client())
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}

	agents, err := client.ListWorkspaceAgents(context.Background(), ListWorkspaceAgentsInput{
		RequestID: "edge-request", OrganizationID: "org-1", PrincipalID: "user-1",
	})
	if err != nil {
		t.Fatalf("ListWorkspaceAgents: %v", err)
	}
	if len(agents) != 2 || agents[0].AgentID != "agent-1" || agents[1].Name != "Two" {
		t.Fatalf("agents = %+v", agents)
	}
	if agents[0].LifecycleState != "created" || agents[0].ActivationState != "disabled" || agents[0].RuntimeState != "exited" ||
		agents[1].LifecycleState != "not_created" || agents[1].ActivationState != "" || agents[1].RuntimeState != "unknown" {
		t.Fatalf("management state lost in pagination: %+v", agents)
	}
}

func TestClientRejectsInvalidOrRepeatedWorkspaceProjection(t *testing.T) {
	t.Parallel()

	for _, body := range []string{
		`{}`, `{"agents":null,"next_cursor":null}`,
		`{"agents":[{"agent_id":"agent-1","name":"One","availability":"unknown","agent_access_subject":"subject-1"}],"next_cursor":null}`,
		`{"agents":[{"agent_id":"agent-1","name":""}],"next_cursor":null}`,
		`{"agents":[{"agent_id":"agent-1","name":"One"}],"next_cursor":null}`,
		`{"agents":[{"agent_id":"agent-1","name":"One","lifecycle_state":"created","activation_state":"enabled","runtime_state":"busy"}],"next_cursor":null}`,
		`{"agents":[{"agent_id":"agent-1","name":"One","lifecycle_state":"created","runtime_state":"available"}],"next_cursor":null}`,
		`{"agents":[{"agent_id":"agent-1","name":"One","lifecycle_state":"not_created","activation_state":"enabled","runtime_state":"unknown"}],"next_cursor":null}`,
		`{"agents":[],"next_cursor":"same"}`,
	} {
		t.Run(body, func(t *testing.T) {
			calls := 0
			server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
				calls++
				_, _ = response.Write([]byte(body))
			}))
			defer server.Close()
			client, err := NewClient(server.URL, server.Client())
			if err != nil {
				t.Fatalf("NewClient: %v", err)
			}
			_, err = client.ListWorkspaceAgents(context.Background(), ListWorkspaceAgentsInput{
				RequestID: "request", OrganizationID: "org-1", PrincipalID: "user-1",
			})
			if err == nil {
				t.Fatal("invalid workspace projection was accepted")
			}
			if calls > 2 {
				t.Fatalf("pagination calls = %d", calls)
			}
		})
	}
}
