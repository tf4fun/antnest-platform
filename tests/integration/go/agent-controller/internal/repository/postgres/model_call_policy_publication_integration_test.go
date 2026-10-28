package postgres

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/acpclient"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

// This is a Controller producer component test: PostgreSQL, ExecutionPublisher
// and the production HTTP client are real; the HTTP ACK peer is not an ACP
// service, authenticated deployment, or Docker acceptance fixture.
func TestModelCallPolicyMigrationPublicationWaitsForActualHTTPAcknowledgement(t *testing.T) {
	for _, outcome := range []string{"valid_ack", "http_failure", "old_revision_ack"} {
		t.Run(outcome, func(t *testing.T) {
			ctx := runtimeBarrierPolicyTestContext(t)
			store := modelPolicyMigrationPredecessor(t, ctx)
			seedModelPolicyMigrationHistory(t, ctx, store)
			// Set the predecessor fixture's observed compute state before taking
			// its immutable baseline; retain its original spec/execution binding.
			changed, err := store.pool.Exec(ctx, `UPDATE agent_controller.agents SET runtime_state=$2 WHERE id=$1`,
				"model-policy-legacy-agent", domain.RuntimeUnhealthy)
			require.NoError(t, err)
			require.EqualValues(t, 1, changed.RowsAffected())
			original, err := store.GetExecutionSynchronization(ctx, modelPolicyLegacyOrganization)
			require.NoError(t, err)
			require.EqualValues(t, 7, original.Revision)
			require.EqualValues(t, 7, original.AppliedRevision)
			require.NotNil(t, original.AppliedAt)
			history := modelPolicyMigrationBusinessSnapshot(t, ctx, store)

			require.NoError(t, store.Migrate(ctx))
			migrated, err := store.GetExecutionSynchronization(ctx, modelPolicyLegacyOrganization)
			require.NoError(t, err)
			require.EqualValues(t, 8, migrated.Revision)
			require.EqualValues(t, 7, migrated.AppliedRevision)
			require.Equal(t, original.AppliedAt, migrated.AppliedAt)
			require.Equal(t, history, modelPolicyMigrationBusinessSnapshot(t, ctx, store))

			type observation struct {
				snapshot receivedExecutionSnapshot
				err      error
			}
			observed := make(chan observation, 1)
			release := make(chan struct{})
			var releaseOnce sync.Once
			releaseACK := func() { releaseOnce.Do(func() { close(release) }) }
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
				calls.Add(1)
				var current observation
				if request.Method != http.MethodPost || request.URL.Path != "/rpc/agent-acp/apply-execution-snapshot" {
					current.err = fmt.Errorf("unexpected publication route %s %s", request.Method, request.URL.Path)
				} else {
					current.err = json.NewDecoder(http.MaxBytesReader(response, request.Body, 1<<20)).Decode(&current.snapshot)
				}
				select {
				case observed <- current:
				case <-request.Context().Done():
					return
				}
				if current.err != nil {
					response.WriteHeader(http.StatusBadRequest)
					return
				}
				select {
				case <-release:
				case <-request.Context().Done():
					return
				}
				response.Header().Set("Content-Type", "application/json")
				if outcome == "http_failure" {
					response.WriteHeader(http.StatusServiceUnavailable)
					if err := json.NewEncoder(response).Encode(map[string]string{"code": "configuration_unavailable"}); err != nil {
						t.Errorf("write failed publication response: %v", err)
					}
					return
				}
				acknowledgement := ports.ExecutionAcknowledgement{
					OrganizationID: current.snapshot.OrganizationID, AppliedRevision: current.snapshot.Revision,
				}
				if outcome == "old_revision_ack" {
					acknowledgement.AppliedRevision--
				}
				if err := json.NewEncoder(response).Encode(acknowledgement); err != nil {
					t.Errorf("write publication ACK: %v", err)
				}
			}))
			httpClient := server.Client()
			publicationContext, cancel := context.WithTimeout(ctx, 10*time.Second)
			type publicationResult struct {
				acknowledgement ports.ExecutionAcknowledgement
				err             error
			}
			finished := make(chan publicationResult, 1)
			started, joined := false, false
			defer func() {
				// Release before joining the client/server on every assertion path.
				releaseACK()
				cancel()
				if started && !joined {
					<-finished
				}
				httpClient.CloseIdleConnections()
				server.Close()
			}()
			client, err := acpclient.New(server.URL, 5*time.Second, httpClient)
			require.NoError(t, err)
			publisher := application.NewExecutionPublisher(store, mutationCredentialOpener{}, client)
			started = true
			go func() {
				acknowledgement, err := publisher.Publish(publicationContext, modelPolicyLegacyOrganization)
				finished <- publicationResult{acknowledgement: acknowledgement, err: err}
			}()

			var current observation
			select {
			case current = <-observed:
			case result := <-finished:
				joined = true
				t.Fatalf("publication ended before the HTTP request: %v", result.err)
			case <-publicationContext.Done():
				t.Fatalf("publication did not reach the HTTP peer: %v", publicationContext.Err())
			}
			require.NoError(t, current.err)
			require.Equal(t, modelPolicyLegacyOrganization, current.snapshot.OrganizationID)
			require.EqualValues(t, 8, current.snapshot.Revision)
			require.Len(t, current.snapshot.Agents, 1)
			var agent struct {
				AgentID           string                   `json:"agent_id"`
				AcceptingRuns     bool                     `json:"accepting_runs"`
				UnavailableReason *string                  `json:"unavailable_reason"`
				ModelRetry        *domain.ModelRetryPolicy `json:"model_retry"`
				Failover          string                   `json:"failover"`
				RunBudget         *domain.RunBudget        `json:"run_budget"`
			}
			require.NoError(t, json.Unmarshal(current.snapshot.Agents[0], &agent))
			require.Equal(t, "model-policy-legacy-agent", agent.AgentID)
			require.False(t, agent.AcceptingRuns, "the retained unavailable Agent still needs an explicit policy")
			require.NotNil(t, agent.UnavailableReason)
			require.Equal(t, &domain.ModelRetryPolicy{Max: 2, BaseMS: 200, CapMS: 30000}, agent.ModelRetry)
			require.Equal(t, "before_output", agent.Failover)
			require.Nil(t, agent.RunBudget, "projection must not invent a Run budget")
			pending, err := store.GetExecutionSynchronization(ctx, modelPolicyLegacyOrganization)
			require.NoError(t, err)
			require.Equal(t, migrated, pending, "held HTTP ACK cannot acknowledge the migration")
			require.Equal(t, history, modelPolicyMigrationBusinessSnapshot(t, ctx, store))
			select {
			case result := <-finished:
				joined = true
				t.Fatalf("publication completed while its HTTP ACK was held: %v", result.err)
			default:
			}

			releaseACK()
			var result publicationResult
			select {
			case result = <-finished:
				joined = true
			case <-publicationContext.Done():
				t.Fatalf("publication did not join after ACK release: %v", publicationContext.Err())
			}
			completed, err := store.GetExecutionSynchronization(ctx, modelPolicyLegacyOrganization)
			require.NoError(t, err)
			require.EqualValues(t, 8, completed.Revision)
			if outcome == "valid_ack" {
				require.NoError(t, result.err)
				require.Equal(t, ports.ExecutionAcknowledgement{OrganizationID: modelPolicyLegacyOrganization, AppliedRevision: 8}, result.acknowledgement)
				require.EqualValues(t, 8, completed.AppliedRevision)
				require.NotNil(t, completed.AppliedAt)
			} else {
				require.Error(t, result.err)
				require.Empty(t, result.acknowledgement)
				require.Equal(t, migrated, completed, "failed or invalid ACK must preserve the old applied revision and timestamp")
			}
			require.EqualValues(t, 1, calls.Load(), "the producer must not silently replay the HTTP request")
			require.Equal(t, history, modelPolicyMigrationBusinessSnapshot(t, ctx, store), "publication must not rewrite immutable or lifecycle history")
		})
	}
}
