package runtimeclient

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

const connectionRevision = "rtv_11111111111111111111111111111111"
const connectionToken = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"

func connectionBody() string {
	return `{"agent_id":"agent-1","runtime_revision":"` + connectionRevision + `","runtime_execution_id":"boot-1","connection_id":"rci_22222222222222222222222222222222","mcp_endpoint":"http://antnest-runtime-agent-1:8093/mcp","credential":{"caller":"agent-acp-service","token":"` + connectionToken + `"}}`
}

func TestResolveRuntimeConnectionUsesPrivateReadContract(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, http.MethodPost, r.Method)
		require.Equal(t, "/internal/runtimes/agent-1/connection", r.URL.Path)
		require.Empty(t, r.Header.Get("Idempotency-Key"))
		require.Empty(t, r.Header.Get("Antnest-Caller-Context"))
		require.Empty(t, r.Header.Get("Authorization"))
		var request map[string]string
		require.NoError(t, json.NewDecoder(r.Body).Decode(&request))
		require.Equal(t, map[string]string{"runtime_revision": connectionRevision, "expected_execution_id": "boot-1"}, request)
		w.Header().Set("Content-Type", "application/json; charset=UTF-8")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write([]byte(connectionBody()))
	}))
	defer server.Close()
	client, err := New(server.URL, time.Second, server.Client())
	require.NoError(t, err)
	connection, err := client.ResolveRuntimeConnection(t.Context(), "agent-1", connectionRevision, "boot-1")
	require.NoError(t, err)
	require.Equal(t, "agent-1", connection.AgentID)
	require.Equal(t, connectionRevision, connection.RuntimeRevision)
	require.Equal(t, "boot-1", connection.RuntimeExecutionID)
	require.Equal(t, "rci_22222222222222222222222222222222", connection.ConnectionID)
	require.Equal(t, connectionToken, connection.Credential.Token)
}

func TestResolveRuntimeConnectionRejectsAmbiguityAndWrongAuthority(t *testing.T) {
	for name, body := range map[string]string{
		"wrong agent":       strings.Replace(connectionBody(), `"agent_id":"agent-1"`, `"agent_id":"agent-2"`, 1),
		"wrong revision":    strings.Replace(connectionBody(), connectionRevision, "rtv_33333333333333333333333333333333", 1),
		"wrong execution":   strings.Replace(connectionBody(), "boot-1", "boot-old", 1),
		"wrong caller":      strings.Replace(connectionBody(), `"caller":"agent-acp-service"`, `"caller":"runtime-controller"`, 1),
		"userinfo":          strings.Replace(connectionBody(), "http://antnest-runtime-agent-1:", "http://user:secret@antnest-runtime-agent-1:", 1),
		"query":             strings.Replace(connectionBody(), ":8093/mcp", ":8093/mcp?token=other", 1),
		"padding":           strings.Replace(connectionBody(), connectionToken, connectionToken+"=", 1),
		"unused bits":       strings.Replace(connectionBody(), connectionToken, strings.Repeat("A", 42)+"B", 1),
		"duplicate":         strings.Replace(connectionBody(), `"agent_id":`, `"agent_id":"agent-2","agent_id":`, 1),
		"escaped duplicate": strings.Replace(connectionBody(), `"token":`, `"\u0074oken":"forged","token":`, 1),
		"case alias":        strings.Replace(connectionBody(), `"agent_id":`, `"AGENT_ID":`, 1),
		"unknown":           strings.Replace(connectionBody(), `"agent_id":`, `"raw_token":"private","agent_id":`, 1),
		"invalid utf8":      strings.Replace(connectionBody(), "boot-1", string([]byte{0xff}), 1),
		"bom":               "\ufeff" + connectionBody(),
		"trailing":          connectionBody() + " {}",
		"oversize":          strings.Repeat(" ", 8193),
		"null":              "null",
	} {
		t.Run(name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				w.Header().Set("Cache-Control", "no-store")
				_, _ = w.Write([]byte(body))
			}))
			defer server.Close()
			client, err := New(server.URL, time.Second, server.Client())
			require.NoError(t, err)
			connection, err := client.ResolveRuntimeConnection(t.Context(), "agent-1", connectionRevision, "boot-1")
			require.Error(t, err)
			require.Empty(t, connection)
			require.NotContains(t, err.Error(), connectionToken)
			var dependency *ports.DependencyError
			require.ErrorAs(t, err, &dependency)
			require.Equal(t, "invalid_response", dependency.Code)
		})
	}
}

func TestResolveRuntimeConnectionRejectsPrivateResponseHeaders(t *testing.T) {
	for _, headers := range []http.Header{
		{"Content-Type": {"text/plain"}, "Cache-Control": {"no-store"}},
		{"Content-Type": {"application/json", "application/json"}, "Cache-Control": {"no-store"}},
		{"Content-Type": {"application/json; charset=latin1"}, "Cache-Control": {"no-store"}},
		{"Content-Type": {"application/json; charset=utf-8; charset=utf-8"}, "Cache-Control": {"no-store"}},
		{"Content-Type": {"application/json"}},
		{"Content-Type": {"application/json"}, "Cache-Control": {"public"}},
		{"Content-Type": {"application/json"}, "Cache-Control": {"no-store"}, "Content-Encoding": {"gzip"}},
	} {
		t.Run(headers.Get("Content-Type")+headers.Get("Cache-Control")+headers.Get("Content-Encoding"), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				for name, values := range headers {
					w.Header()[name] = values
				}
				_, _ = w.Write([]byte(connectionBody()))
			}))
			defer server.Close()
			client, err := New(server.URL, time.Second, server.Client())
			require.NoError(t, err)
			connection, err := client.ResolveRuntimeConnection(t.Context(), "agent-1", connectionRevision, "boot-1")
			require.Error(t, err)
			require.Empty(t, connection)
		})
	}
}

func TestResolveRuntimeConnectionPreservesOnlyKnownFailureCodes(t *testing.T) {
	for _, vector := range []struct {
		status    int
		code      string
		retryable bool
	}{
		{400, "invalid_request", false}, {401, "service_unauthenticated", false}, {403, "caller_not_allowed", false},
		{404, "runtime_not_found", false}, {409, "runtime_connection_stale", false}, {503, "runtime_connection_unavailable", true},
	} {
		t.Run(vector.code, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(vector.status)
				_ = json.NewEncoder(w).Encode(map[string]any{"code": vector.code, "message": connectionToken, "retryable": vector.retryable})
			}))
			defer server.Close()
			client, err := New(server.URL, time.Second, server.Client())
			require.NoError(t, err)
			_, err = client.ResolveRuntimeConnection(t.Context(), "agent-1", connectionRevision, "boot-1")
			require.Error(t, err)
			require.NotContains(t, err.Error(), connectionToken)
			var dependency *ports.DependencyError
			require.ErrorAs(t, err, &dependency)
			require.Equal(t, vector.code, dependency.Code)
			require.Equal(t, vector.retryable, dependency.Retryable)
			require.Nil(t, dependency.Cause)
		})
	}
}

func TestResolveRuntimeConnectionDoesNotFollowRedirectsOrEchoErrors(t *testing.T) {
	var leaked atomic.Int32
	var redirect atomic.Bool
	redirect.Store(true)
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { leaked.Add(1); w.WriteHeader(500) }))
	defer other.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if redirect.Load() {
			http.Redirect(w, r, other.URL, http.StatusTemporaryRedirect)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(503)
		_, _ = w.Write([]byte(`{"code":"` + connectionToken + `","message":"` + connectionToken + `","retryable":true}`))
	}))
	defer server.Close()
	client, err := New(server.URL, time.Second, server.Client())
	require.NoError(t, err)
	connection, err := client.ResolveRuntimeConnection(t.Context(), "agent-1", connectionRevision, "boot-1")
	require.Error(t, err)
	require.Empty(t, connection)
	require.Zero(t, leaked.Load())
	redirect.Store(false)
	_, err = client.ResolveRuntimeConnection(t.Context(), "agent-1", connectionRevision, "boot-1")
	require.Error(t, err)
	require.NotContains(t, err.Error(), connectionToken)
}

func TestResolveRuntimeConnectionRejectsInvalidInputWithoutNetworkAndPreservesCancellation(t *testing.T) {
	var calls atomic.Int32
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		_, _ = io.Copy(io.Discard, r.Body)
		select {
		case <-r.Context().Done():
		case <-release:
		}
	}))
	defer func() { close(release); server.Close() }()
	client, err := New(server.URL, time.Second, server.Client())
	require.NoError(t, err)
	for _, input := range [][3]string{
		{"../agent-1", connectionRevision, "boot-1"},
		{"agent-1", "runtime-1", "boot-1"},
		{"agent-1", connectionRevision, ""},
		{"agent-1", connectionRevision, "boot\n"},
	} {
		_, err := client.ResolveRuntimeConnection(t.Context(), input[0], input[1], input[2])
		require.Error(t, err)
	}
	require.Zero(t, calls.Load())
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	_, err = client.ResolveRuntimeConnection(ctx, "agent-1", connectionRevision, "boot-1")
	require.True(t, errors.Is(err, context.Canceled))
	require.Zero(t, calls.Load())
	ctx, stop := context.WithTimeout(t.Context(), 100*time.Millisecond)
	defer stop()
	_, err = client.ResolveRuntimeConnection(ctx, "agent-1", connectionRevision, "boot-1")
	require.True(t, errors.Is(err, context.DeadlineExceeded))
}
