package acpclient_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"github.com/stretchr/testify/require"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/acpclient"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func snapshot() ports.ExecutionSnapshot {
	return ports.ExecutionSnapshot{OrganizationID: "org1", Revision: 7,
		Providers: []ports.ExecutionProvider{{ConnectionID: "provider1", ProviderKey: "deepseek", RequestProtocol: "openai_chat_completions", BaseURL: "https://api.deepseek.com", Enabled: true,
			CredentialRevision: "credential2", Credential: &ports.ExecutionCredential{Method: "api_key", Secret: "synthetic-current-secret"}}},
		Models: []ports.ExecutionModel{}, Agents: []ports.ExecutionAgent{}}
}

func settlement() ports.AgentSettlementRequest {
	return ports.AgentSettlementRequest{OrganizationID: "org1", AgentID: "agent1", MinimumRevision: 7, OperationID: "operation1", Mode: "wait",
		DeadlineAt: time.Date(2026, 9, 14, 19, 4, 5, 123000000, time.FixedZone("UTC+8", 8*60*60))}
}

func newClient(t *testing.T, handler http.HandlerFunc) *acpclient.Client {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	client, err := acpclient.New(server.URL, time.Second, server.Client())
	require.NoError(t, err)
	return client
}

func writeResponse(t *testing.T, writer http.ResponseWriter, status int, body string) {
	t.Helper()
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	_, err := io.WriteString(writer, body)
	require.NoError(t, err)
}

func assertContract(t *testing.T, name string, payload []byte) {
	t.Helper()
	body, err := os.ReadFile("../../../../contracts/agent-acp/" + name + ".schema.json")
	require.NoError(t, err)
	document, err := jsonschema.UnmarshalJSON(bytes.NewReader(body))
	require.NoError(t, err)
	compiler := jsonschema.NewCompiler()
	compiler.DefaultDraft(jsonschema.Draft2020)
	compiler.AssertFormat()
	identifier := "https://antnest.local/contracts/agent-acp/" + name + ".schema.json"
	require.NoError(t, compiler.AddResource(identifier, document))
	definition, err := compiler.Compile(identifier)
	require.NoError(t, err)
	instance, err := jsonschema.UnmarshalJSON(bytes.NewReader(payload))
	require.NoError(t, err)
	require.NoError(t, definition.Validate(instance))
}

func TestApplySnapshotUsesSharedContract(t *testing.T) {
	client := newClient(t, func(writer http.ResponseWriter, request *http.Request) {
		require.Equal(t, http.MethodPost, request.Method)
		require.Equal(t, "/rpc/agent-acp/apply-execution-snapshot", request.URL.Path)
		require.Equal(t, "application/json", request.Header.Get("Content-Type"))
		body, err := io.ReadAll(request.Body)
		require.NoError(t, err)
		assertContract(t, "execution-snapshot", body)
		var received ports.ExecutionSnapshot
		require.NoError(t, json.Unmarshal(body, &received))
		require.Equal(t, snapshot(), received)
		writeResponse(t, writer, http.StatusOK, `{"organization_id":"org1","applied_revision":8}`)
	})
	result, err := client.ApplyExecutionSnapshot(context.Background(), snapshot())
	require.NoError(t, err)
	require.Equal(t, ports.ExecutionAcknowledgement{OrganizationID: "org1", AppliedRevision: 8}, result)
}

func TestSettlementKeepsFixedDeadlineAndExplicitOutcomes(t *testing.T) {
	for _, outcome := range []string{ports.ExecutionSettled, ports.ExecutionNotSettled, ports.ExecutionRuntimeBarrierRequired} {
		t.Run(outcome, func(t *testing.T) {
			var receivedDeadline string
			client := newClient(t, func(writer http.ResponseWriter, request *http.Request) {
				require.Equal(t, "/rpc/agent-acp/settle-agent", request.URL.Path)
				body, err := io.ReadAll(request.Body)
				require.NoError(t, err)
				assertContract(t, "settle-agent-request", body)
				var received struct {
					DeadlineAt string `json:"deadline_at"`
				}
				require.NoError(t, json.Unmarshal(body, &received))
				receivedDeadline = received.DeadlineAt
				writeResponse(t, writer, http.StatusOK, `{"applied_revision":7,"outcome":"`+outcome+`"}`)
			})
			result, err := client.SettleAgent(context.Background(), settlement())
			require.NoError(t, err)
			require.Equal(t, "2026-09-14T11:04:05.123Z", receivedDeadline)
			require.Equal(t, outcome, result.Outcome)
			payload, err := json.Marshal(result)
			require.NoError(t, err)
			assertContract(t, "settle-agent-result", payload)
		})
	}
}

func TestApplySnapshotRejectsInvalidAcknowledgements(t *testing.T) {
	for name, body := range map[string]string{
		"other organization":  `{"organization_id":"org2","applied_revision":7}`,
		"stale revision":      `{"organization_id":"org1","applied_revision":6}`,
		"unsafe revision":     `{"organization_id":"org1","applied_revision":9007199254740992}`,
		"missing revision":    `{"organization_id":"org1"}`,
		"fractional revision": `{"organization_id":"org1","applied_revision":7.5}`,
		"trailing json":       `{"organization_id":"org1","applied_revision":7} {}`,
		"null":                `null`,
		"oversize":            strings.Repeat(" ", (1<<20)+1),
	} {
		t.Run(name, func(t *testing.T) {
			client := newClient(t, func(writer http.ResponseWriter, _ *http.Request) { writeResponse(t, writer, http.StatusOK, body) })
			result, err := client.ApplyExecutionSnapshot(context.Background(), snapshot())
			assertFailure(t, err, "invalid_response", true)
			require.Empty(t, result)
		})
	}
}

func TestSettlementCannotInterpretInvalidResponsesAsStopped(t *testing.T) {
	for _, body := range []string{`{"applied_revision":6,"outcome":"settled"}`, `{"applied_revision":7}`, `{"applied_revision":7,"outcome":"ready"}`, `null`} {
		t.Run(body, func(t *testing.T) {
			client := newClient(t, func(writer http.ResponseWriter, _ *http.Request) { writeResponse(t, writer, http.StatusOK, body) })
			result, err := client.SettleAgent(context.Background(), settlement())
			assertFailure(t, err, "invalid_response", true)
			require.Empty(t, result)
		})
	}
}

func assertFailure(t *testing.T, err error, code string, retryable bool) {
	t.Helper()
	var dependency *ports.DependencyError
	require.ErrorAs(t, err, &dependency)
	require.Equal(t, "agent-acp-service", dependency.Service)
	require.Equal(t, code, dependency.Code)
	require.Equal(t, retryable, dependency.Retryable)
}

func TestDependencyErrorsAreBoundedAndNotRetried(t *testing.T) {
	for _, test := range []struct {
		status    int
		body      string
		code      string
		retryable bool
	}{
		{400, `{"code":"invalid_execution_configuration","retryable":false}`, "invalid_execution_configuration", false},
		{409, `{"code":"configuration_conflict","retryable":false}`, "configuration_conflict", false},
		{413, `{"code":"configuration_too_large","retryable":false}`, "configuration_too_large", false},
		{503, `{"code":"configuration_unavailable","retryable":true}`, "configuration_unavailable", true},
		{500, `{"code":"synthetic-secret","message":"synthetic-secret"}`, "dependency_unavailable", true},
		{400, `{"code":"synthetic-secret","message":"synthetic-secret"}`, "invalid_response", true},
		{200, `{"code":"configuration_unavailable","retryable":true}`, "invalid_response", true},
	} {
		t.Run(test.code+test.body, func(t *testing.T) {
			var calls atomic.Int32
			client := newClient(t, func(writer http.ResponseWriter, _ *http.Request) {
				calls.Add(1)
				writeResponse(t, writer, test.status, test.body)
			})
			result, err := client.ApplyExecutionSnapshot(context.Background(), snapshot())
			assertFailure(t, err, test.code, test.retryable)
			require.Empty(t, result)
			require.NotContains(t, err.Error(), "synthetic-secret")
			require.Equal(t, int32(1), calls.Load())
		})
	}
}

func TestClientRefusesRedirectsAndInvalidLocalInputs(t *testing.T) {
	var leaked atomic.Int32
	destination := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		leaked.Add(1)
		writer.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(destination.Close)
	client := newClient(t, func(writer http.ResponseWriter, request *http.Request) {
		http.Redirect(writer, request, destination.URL, http.StatusTemporaryRedirect)
	})
	_, err := client.ApplyExecutionSnapshot(context.Background(), snapshot())
	assertFailure(t, err, "invalid_response", true)
	require.Zero(t, leaked.Load())

	client = newClient(t, func(writer http.ResponseWriter, _ *http.Request) {
		leaked.Add(1)
		writer.WriteHeader(http.StatusNoContent)
	})
	_, err = client.ApplyExecutionSnapshot(context.Background(), ports.ExecutionSnapshot{})
	require.ErrorIs(t, err, ports.ErrInvalidExecutionConfiguration)
	request := settlement()
	request.Mode = "force"
	_, err = client.SettleAgent(context.Background(), request)
	require.ErrorIs(t, err, ports.ErrInvalidExecutionConfiguration)
	require.Zero(t, leaked.Load())
}

type transportFunc func(*http.Request) (*http.Response, error)

func (transport transportFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return transport(request)
}

func TestClientHonorsCancellationAndTimeout(t *testing.T) {
	for _, test := range []struct {
		name    string
		timeout time.Duration
		cancel  bool
		want    error
	}{
		{"caller cancellation", time.Second, true, context.Canceled},
		{"client deadline", time.Millisecond, false, context.DeadlineExceeded},
	} {
		t.Run(test.name, func(t *testing.T) {
			transport := transportFunc(func(request *http.Request) (*http.Response, error) {
				<-request.Context().Done()
				return nil, request.Context().Err()
			})
			client, err := acpclient.New("http://acp.internal", test.timeout, &http.Client{Transport: transport})
			require.NoError(t, err)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if test.cancel {
				cancel()
			}
			result, err := client.ApplyExecutionSnapshot(ctx, snapshot())
			require.True(t, errors.Is(err, test.want), "error = %v", err)
			require.Empty(t, result)
		})
	}
}

func TestConstructorRejectsInvalidEndpointAndTimeout(t *testing.T) {
	for _, endpoint := range []string{"", "unix:///tmp/acp", "http://user:password@acp", "http://acp/rpc", "http://acp?key=value", "http://acp#part"} {
		_, err := acpclient.New(endpoint, time.Second, nil)
		require.Error(t, err)
	}
	_, err := acpclient.New("http://acp", 0, nil)
	require.Error(t, err)
}
