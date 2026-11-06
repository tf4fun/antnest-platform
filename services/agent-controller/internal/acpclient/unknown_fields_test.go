package acpclient

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func TestGetExecutionDigestToleratesUnknownResponseFields(t *testing.T) {
	hex := strings.Repeat("a", 64)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"organization_id":"org-1","schema_version":2,"revision":3,"digest":"` + hex + `",` +
			`"providers":[{"id":"provider-1","digest":"` + hex + `","future_extension":{"nested":[1,2]}}],` +
			`"models":[],"agents":[],"organization_budget_digest":null,"future_top":{"cursor":"opaque"}}`))
	}))
	defer server.Close()
	client, err := New(server.URL, time.Second, server.Client())
	require.NoError(t, err)
	digest, err := client.GetExecutionDigest(context.Background(), "org-1")
	require.NoError(t, err)
	require.Equal(t, 2, digest.SchemaVersion)
	require.EqualValues(t, 3, digest.Revision)
	require.Equal(t, hex, *digest.Digest)
	require.Equal(t, "provider-1", digest.Providers[0].ID)
	require.Equal(t, hex, digest.Providers[0].Digest)
}

func TestApplyExecutionDeltaToleratesUnknownResponseFields(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"organization_id":"org-1","applied_revision":3,"future_extension":{"note":"n-1"}}`))
	}))
	defer server.Close()
	client, err := New(server.URL, time.Second, server.Client())
	require.NoError(t, err)
	ack, err := client.ApplyExecutionDelta(context.Background(), deltaFixture())
	require.NoError(t, err)
	require.Equal(t, "org-1", ack.OrganizationID)
	require.EqualValues(t, 3, ack.AppliedRevision)
}

func TestGetRuntimeBarrierToleratesUnknownResponseFields(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"organization_id":"org1","agent_id":"agent1","runtime_revision":"runtime1",` +
			`"barrier":{"barrier_id":"barrier1","reason":"runtime_barrier_required","runtime_execution_id":"retained-execution1","future_extension":{"v":2}},` +
			`"future_top":{"cursor":"opaque"}}`))
	}))
	defer server.Close()
	client, err := New(server.URL, time.Second, server.Client())
	require.NoError(t, err)
	result, err := client.GetRuntimeBarrier(context.Background(), ports.RuntimeBarrierQuery{
		OrganizationID: "org1", AgentID: "agent1", ExpectedRuntimeRevision: "runtime1",
	})
	require.NoError(t, err)
	require.Equal(t, "org1", result.OrganizationID)
	require.Equal(t, "agent1", result.AgentID)
	require.Equal(t, "runtime1", result.RuntimeRevision)
	require.Equal(t, &ports.RuntimeBarrier{
		BarrierID: "barrier1", Reason: "runtime_barrier_required", RuntimeExecutionID: "retained-execution1",
	}, result.Barrier)
}
