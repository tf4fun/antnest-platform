package runtimeclient

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/contracttest"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

type schemaTransport func(*http.Request) (*http.Response, error)

func (fn schemaTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	return fn(request)
}

const contractSchema = "runtime-controller/control-api.schema.json#/$defs/"

func operationReply(kind, lifecycle string) []byte {
	health := "unknown"
	if lifecycle == "disabled" || lifecycle == "deleted" {
		health = "absent"
	}
	return []byte(fmt.Sprintf(`{
		"request_id":"request-1",
		"kind":%q,
		"agent_id":"agent-1",
		"target_revision":"rtv_11111111111111111111111111111111",
		"state":"completed",
		"effect":"completed",
		"inspection":{
			"agent_id":"agent-1",
			"runtime_revision":"rtv_11111111111111111111111111111111",
			"lifecycle_state":%q,
			"phase":"unknown",
			"health":%q,
			"restart_count":0,
			"observed_at":"2026-09-01T00:00:00Z"
		},
		"created_at":"2026-09-01T00:00:00Z",
		"updated_at":"2026-09-01T00:00:01Z"
	}`, kind, lifecycle, health))
}

type runtimeRequest struct {
	method, path, idempotencyKey string
	body                         []byte
}

func operationClient(t *testing.T, response []byte, captured *runtimeRequest) *Client {
	t.Helper()
	contracttest.Validate(t, contractSchema+"operation", response)
	client, err := New("http://upstream.internal", 5*time.Second, &http.Client{
		Transport: schemaTransport(func(request *http.Request) (*http.Response, error) {
			body, err := io.ReadAll(request.Body)
			if err != nil {
				t.Errorf("read request body: %v", err)
			}
			*captured = runtimeRequest{
				method:         request.Method,
				path:           request.URL.Path,
				idempotencyKey: request.Header.Get("Idempotency-Key"),
				body:           body,
			}
			return &http.Response{
				StatusCode: http.StatusOK,
				Header: http.Header{
					"Content-Type":  []string{"application/json"},
					"Cache-Control": []string{"no-store"},
				},
				Body:    io.NopCloser(strings.NewReader(string(response))),
				Request: request,
			}, nil
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func assertCanonicalRevision(t *testing.T, method string, captured runtimeRequest) {
	t.Helper()
	var body map[string]any
	if err := json.Unmarshal(captured.body, &body); err != nil {
		t.Fatalf("%s request not JSON: %v", method, err)
	}
	if body["expected_version"] != "rtv_11111111111111111111111111111111" {
		t.Fatalf("%s expected_version %v: %s", method, body["expected_version"], string(captured.body))
	}
	if _, ok := body["expected_revision"]; ok {
		t.Fatalf("%s emits legacy expected_revision: %s", method, string(captured.body))
	}
	if _, ok := body["expected_resource_version"]; ok {
		t.Fatalf("%s emits expected_resource_version: %s", method, string(captured.body))
	}
}

func TestRouteSchemaRuntimeRequests(t *testing.T) {
	ctx := context.Background()
	revision := "rtv_11111111111111111111111111111111"
	configuration := runtimeConfiguration()

	methods := []struct {
		name, schema, kind, lifecycle, path string
		invoke                              func(*Client) (ports.RuntimeOperation, error)
	}{
		{"initialize", "initialize_request", "initialize_runtime", "provisioned", "/internal/runtimes/agent-1/initialize",
			func(c *Client) (ports.RuntimeOperation, error) {
				return c.InitializeRuntime(ctx, "request-1", "agent-1", configuration)
			}},
		{"update", "revision_configuration_request", "update_runtime", "provisioned", "/internal/runtimes/agent-1/update",
			func(c *Client) (ports.RuntimeOperation, error) {
				return c.UpdateRuntime(ctx, "request-1", "agent-1", revision, configuration)
			}},
		{"enable", "revision_configuration_request", "enable_runtime", "provisioned", "/internal/runtimes/agent-1/enable",
			func(c *Client) (ports.RuntimeOperation, error) {
				return c.EnableRuntime(ctx, "request-1", "agent-1", revision, configuration)
			}},
		{"disable", "revision_request", "disable_runtime", "disabled", "/internal/runtimes/agent-1/disable",
			func(c *Client) (ports.RuntimeOperation, error) {
				return c.DisableRuntime(ctx, "request-1", "agent-1", revision)
			}},
		{"delete", "revision_request", "delete_runtime", "deleted", "/internal/runtimes/agent-1/delete",
			func(c *Client) (ports.RuntimeOperation, error) {
				return c.DeleteRuntime(ctx, "request-1", "agent-1", revision)
			}},
	}
	for _, item := range methods {
		t.Run(item.name, func(t *testing.T) {
			response := operationReply(item.kind, item.lifecycle)
			var captured runtimeRequest
			result, err := item.invoke(operationClient(t, response, &captured))
			if err != nil {
				t.Fatalf("%s: %v", item.name, err)
			}
			if result.State != "completed" || result.RuntimeRevision != revision || result.LifecycleState != item.lifecycle {
				t.Fatalf("%s decoded %+v", item.name, result)
			}
			if captured.method != http.MethodPost || captured.path != item.path {
				t.Fatalf("%s sent %s %s", item.name, captured.method, captured.path)
			}
			if captured.idempotencyKey != "request-1" {
				t.Fatalf("%s idempotency %q", item.name, captured.idempotencyKey)
			}
			contracttest.Validate(t, contractSchema+item.schema, captured.body)
			if item.name != "initialize" {
				assertCanonicalRevision(t, item.name, captured)
			}
		})
	}
}
