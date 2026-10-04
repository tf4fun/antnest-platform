package e2e

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/acpclient"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

type peerExecutionSnapshot struct {
	OrganizationID string                    `json:"organization_id"`
	Revision       int64                     `json:"revision"`
	Providers      []ports.ExecutionProvider `json:"providers"`
	Models         []json.RawMessage         `json:"models"`
	Agents         []ports.ExecutionAgent    `json:"agents"`
}

func executionPublicationPeer(t *testing.T, store ports.ExecutionPublicationStore, opener ports.CredentialOpener, runtime ports.RuntimeConnectionResolver) (*application.ExecutionPublisher, func() peerExecutionSnapshot) {
	t.Helper()
	var mu sync.Mutex
	var snapshot peerExecutionSnapshot
	peer := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if request.Method != http.MethodPost {
			response.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		var result any
		switch request.URL.Path {
		case "/rpc/agent-acp/apply-execution-snapshot":
			var current peerExecutionSnapshot
			if err := json.NewDecoder(request.Body).Decode(&current); err != nil {
				t.Error(err)
				response.WriteHeader(http.StatusBadRequest)
				return
			}
			snapshot = current
			result = ports.ExecutionAcknowledgement{OrganizationID: snapshot.OrganizationID, AppliedRevision: snapshot.Revision}
		case "/rpc/agent-acp/settle-agent":
			var settlement ports.AgentSettlementRequest
			if err := json.NewDecoder(request.Body).Decode(&settlement); err != nil {
				t.Error(err)
				response.WriteHeader(http.StatusBadRequest)
				return
			}
			if !closedPeerAgent(snapshot, settlement) {
				t.Error("settlement preceded configuration acknowledgement")
				response.WriteHeader(http.StatusConflict)
				return
			}
			result = ports.AgentSettlementResult{AppliedRevision: snapshot.Revision, Outcome: ports.ExecutionSettled}
		default:
			t.Errorf("unexpected ACP business RPC: %s", request.URL.Path)
			response.WriteHeader(http.StatusNotFound)
			return
		}
		response.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(response).Encode(result); err != nil {
			t.Error(err)
		}
	}))
	t.Cleanup(peer.Close)
	client, err := acpclient.New(peer.URL, time.Second, peer.Client())
	require.NoError(t, err)
	return application.NewExecutionPublisher(store, opener, client, application.WithRuntimeConnectionResolver(runtime)), func() peerExecutionSnapshot { mu.Lock(); defer mu.Unlock(); return snapshot }
}

func closedPeerAgent(snapshot peerExecutionSnapshot, request ports.AgentSettlementRequest) bool {
	if snapshot.OrganizationID != request.OrganizationID || snapshot.Revision < request.MinimumRevision {
		return false
	}
	for _, agent := range snapshot.Agents {
		if agent.AgentID == request.AgentID {
			return agent.OperationID != nil && *agent.OperationID == request.OperationID && !agent.AcceptingRuns
		}
	}
	return false
}
