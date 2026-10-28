package postgres

// Controller producer component test: PostgreSQL, ExecutionPublisher and the
// production acpclient HTTP path are real; the ACK peer is an httptest
// fixture, not an ACP service, authenticated deployment, or Docker fixture.

import (
	"context"
	"encoding/json"
	"errors"
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
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/outbound"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/providerdiscovery"
)

func observedDiscoveryModels() []ports.DiscoveredModel {
	contextWindow, maxOutput := 128000, 8192
	tools := true
	return []ports.DiscoveredModel{
		{ModelID: "integration-model", DisplayName: "Integration", ContextWindow: &contextWindow, MaxOutputTokens: &maxOutput, SupportsTools: &tools},
		{ModelID: "other-model", DisplayName: "Other"},
	}
}

func seedProviderObservationTarget(t *testing.T, repository *Repository) (ports.ModelProfileRecord, ports.ProviderConnectionRecord) {
	t.Helper()
	return seedProviderObservationTargetAtURL(t, repository, "https://api.example.com/v1")
}

func seedProviderObservationTargetAtURL(t *testing.T, repository *Repository, baseURL string) (ports.ModelProfileRecord, ports.ProviderConnectionRecord) {
	t.Helper()
	ctx := context.Background()
	model := integrationModelRecord(t)
	revision, err := domain.NewModelProfileRevision(domain.ModelProfileRevisionInput{
		ID: "modelrev_observations", ModelProfileID: model.ModelProfileID, OrganizationID: model.OrganizationID,
		Revision: 1,
		Model:    domain.ModelSpec{BaseURL: baseURL, Model: "integration-model", ContextWindow: 32000, MaxOutputTokens: 2048},
	})
	require.NoError(t, err)
	model.Revision = revision
	seedProviderForModel(t, repository, model)
	_, err = repository.PutModelProfile(ctx, model)
	require.NoError(t, err)
	original, err := repository.GetProviderAccess(ctx, model.OrganizationID, model.ProviderConnectionID)
	require.NoError(t, err)
	return model, original
}

func TestProviderObservationsPersistReadAndPublishFacts(t *testing.T) {
	ctx := context.Background()
	repository := providerTestRepository(t)
	model, original := seedProviderObservationTarget(t, repository)
	revision, err := repository.ReplaceProviderObservations(ctx, original, observedDiscoveryModels())
	require.NoError(t, err)
	require.EqualValues(t, 1, revision)

	before, err := repository.GetExecutionSynchronization(ctx, model.OrganizationID)
	require.NoError(t, err)
	source, err := repository.ReadExecutionSource(ctx, model.OrganizationID)
	require.NoError(t, err)
	require.Len(t, source.ProviderObservations, 1)
	set := source.ProviderObservations[0]
	require.Equal(t, model.OrganizationID, set.Binding.OrganizationID)
	require.Equal(t, model.ProviderConnectionID, set.Binding.ConnectionID)
	require.Equal(t, "deepseek", set.Binding.ProviderKey)
	require.Equal(t, "openai_chat_completions", set.Binding.RequestProtocol)
	require.Equal(t, original.CredentialVersion, set.Binding.CredentialRevision)
	require.Len(t, set.Models, 2)
	// Read-only source reads must not write the execution revision.
	after, err := repository.GetExecutionSynchronization(ctx, model.OrganizationID)
	require.NoError(t, err)
	require.Equal(t, before, after)

	snapshot, err := application.BuildExecutionSnapshot(ctx, source, mutationCredentialOpener{})
	require.NoError(t, err)
	require.Len(t, snapshot.Models, 1)
	emitted := snapshot.Models[0]
	require.NotNil(t, emitted.ProviderTokenLimits)
	require.Equal(t, domain.ProviderTokenLimitsSource, emitted.ProviderTokenLimits.Source)
	require.EqualValues(t, 1, emitted.ProviderTokenLimits.SourceRevision)
	require.Equal(t, "integration-model", emitted.ProviderTokenLimits.Binding.Model)
	require.EqualValues(t, 128000, *emitted.ProviderTokenLimits.ContextTokens)
	require.EqualValues(t, 8192, *emitted.ProviderTokenLimits.MaxOutputTokens)
	require.NotNil(t, emitted.SupportsTools)
	require.True(t, *emitted.SupportsTools)
	require.NoError(t, snapshot.Validate())
}

func TestProviderObservationsReplacementClearsOmittedAndEmptyResults(t *testing.T) {
	ctx := context.Background()
	repository := providerTestRepository(t)
	model, original := seedProviderObservationTarget(t, repository)
	_, err := repository.ReplaceProviderObservations(ctx, original, observedDiscoveryModels())
	require.NoError(t, err)

	revision, err := repository.ReplaceProviderObservations(ctx, original,
		[]ports.DiscoveredModel{{ModelID: "other-model"}})
	require.NoError(t, err)
	require.EqualValues(t, 2, revision)
	source, err := repository.ReadExecutionSource(ctx, model.OrganizationID)
	require.NoError(t, err)
	require.Len(t, source.ProviderObservations, 1)
	require.Len(t, source.ProviderObservations[0].Models, 1)
	require.Equal(t, "other-model", source.ProviderObservations[0].Models[0].Model)

	// An empty but complete discovery clears the set.
	revision, err = repository.ReplaceProviderObservations(ctx, original, []ports.DiscoveredModel{})
	require.NoError(t, err)
	require.EqualValues(t, 3, revision)
	source, err = repository.ReadExecutionSource(ctx, model.OrganizationID)
	require.NoError(t, err)
	require.Len(t, source.ProviderObservations, 1)
	require.Empty(t, source.ProviderObservations[0].Models)
	snapshot, err := application.BuildExecutionSnapshot(ctx, source, mutationCredentialOpener{})
	require.NoError(t, err)
	require.Nil(t, snapshot.Models[0].ProviderTokenLimits)
	require.Nil(t, snapshot.Models[0].SupportsTools)
}

func TestProviderObservationsScopeIndependentConnectionsAndOrganizations(t *testing.T) {
	ctx := context.Background()
	repository := providerTestRepository(t)
	model, first := seedProviderObservationTarget(t, repository)
	secondConnection := ports.ProviderConnectionRecord{
		RequestID: "provider-observations-second", RequestFingerprint: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		ConnectionID: "provider-second", OrganizationID: "org-integration-second",
		ProviderKey: "deepseek", DisplayName: "Provider", BaseURL: "https://api.example.com/v1",
		CredentialMethod: "api_key", CredentialVersion: "version-second", CredentialRevision: 1,
		SealedCredential: ports.SealedSecret{Ciphertext: []byte("ciphertext"), Nonce: []byte("nonce")},
		Enabled:          true, CreatedAt: model.CreatedAt, UpdatedAt: model.UpdatedAt,
	}
	_, err := repository.PutProviderConnection(ctx, secondConnection, nil)
	require.NoError(t, err)
	secondOriginal, err := repository.GetProviderAccess(ctx, "org-integration-second", "provider-second")
	require.NoError(t, err)

	var wait sync.WaitGroup
	results := make(chan error, 2)
	for _, original := range []ports.ProviderConnectionRecord{first, secondOriginal} {
		wait.Add(1)
		go func(record ports.ProviderConnectionRecord) {
			defer wait.Done()
			_, err := repository.ReplaceProviderObservations(ctx, record, observedDiscoveryModels())
			results <- err
		}(original)
	}
	wait.Wait()
	close(results)
	for err := range results {
		require.NoError(t, err)
	}
	firstSource, err := repository.ReadExecutionSource(ctx, first.OrganizationID)
	require.NoError(t, err)
	require.Len(t, firstSource.ProviderObservations, 1)
	secondSource, err := repository.ReadExecutionSource(ctx, second.OrganizationID)
	require.NoError(t, err)
	require.Len(t, secondSource.ProviderObservations, 1)
	require.NotEqual(t, firstSource.ProviderObservations[0].Binding.OrganizationID,
		secondSource.ProviderObservations[0].Binding.OrganizationID)
}

func TestProviderObservationsCredentialRotationRejectsStaleBinding(t *testing.T) {
	ctx := context.Background()
	repository := providerTestRepository(t)
	model, original := seedProviderObservationTarget(t, repository)
	_, err := repository.ReplaceProviderObservations(ctx, original, observedDiscoveryModels())
	require.NoError(t, err)
	head, err := repository.GetExecutionSynchronization(ctx, model.OrganizationID)
	require.NoError(t, err)

	// Simulate an old in-flight HTTP discovery released after rotation; the
	// rotation itself uses a distinct request identity like any catalog write.
	rotated := original
	rotated.RequestID = "provider-observations-rotate"
	rotated.RequestFingerprint = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
	rotated.CredentialVersion = "version-rotated"
	rotated.CredentialRevision = original.CredentialRevision + 1
	rotated.UpdatedAt = rotated.UpdatedAt.Add(time.Minute)
	rotated.SealedCredential = ports.SealedSecret{Ciphertext: []byte("rotated"), Nonce: []byte("rotated-nonce")}
	current, err := repository.RotateProviderCredential(ctx, original.CredentialVersion, rotated)
	require.NoError(t, err)
	headAfterRotation, err := repository.GetExecutionSynchronization(ctx, model.OrganizationID)
	require.NoError(t, err)
	require.Greater(t, headAfterRotation.Revision, head.Revision)

	_, err = repository.ReplaceProviderObservations(ctx, original, observedDiscoveryModels())
	require.ErrorIs(t, err, ports.ErrConcurrentChange)
	source, err := repository.ReadExecutionSource(ctx, model.OrganizationID)
	require.NoError(t, err)
	require.Len(t, source.ProviderObservations, 1, "stale bound set stays stored until a fresh discovery replaces it")
	snapshot, err := application.BuildExecutionSnapshot(ctx, source, mutationCredentialOpener{})
	require.NoError(t, err)
	require.Nil(t, snapshot.Models[0].ProviderTokenLimits, "rotated binding must drop stale facts immediately")
	require.Nil(t, snapshot.Models[0].SupportsTools)
	headAfterReject, err := repository.GetExecutionSynchronization(ctx, model.OrganizationID)
	require.NoError(t, err)
	require.Equal(t, headAfterRotation, headAfterReject, "CAS rejection must not write the execution revision")

	// A fresh discovery against the rotated binding succeeds and republishes.
	fresh, err := repository.GetProviderAccess(ctx, model.OrganizationID, model.ProviderConnectionID)
	require.NoError(t, err)
	revision, err := repository.ReplaceProviderObservations(ctx, fresh, observedDiscoveryModels())
	require.NoError(t, err)
	require.EqualValues(t, 2, revision)
	require.Equal(t, current.CredentialVersion, fresh.CredentialVersion)
	source, err = repository.ReadExecutionSource(ctx, model.OrganizationID)
	require.NoError(t, err)
	snapshot, err = application.BuildExecutionSnapshot(ctx, source, mutationCredentialOpener{})
	require.NoError(t, err)
	require.NotNil(t, snapshot.Models[0].ProviderTokenLimits)
	require.Equal(t, fresh.CredentialVersion, snapshot.Models[0].ProviderTokenLimits.Binding.CredentialRevision)
}

func TestProviderObservationsOverflowRollsBackSetAndHead(t *testing.T) {
	ctx := context.Background()
	repository := providerTestRepository(t)
	model, original := seedProviderObservationTarget(t, repository)
	_, err := repository.ReplaceProviderObservations(ctx, original, observedDiscoveryModels())
	require.NoError(t, err)

	// source_revision at the safe-integer ceiling: the next replace fails
	// inside its transaction; set and head stay untouched.
	_, err = repository.pool.Exec(ctx, `UPDATE agent_controller.provider_observations
SET source_revision=9007199254740991 WHERE connection_id=$1`, original.ConnectionID)
	require.NoError(t, err)
	head, err := repository.GetExecutionSynchronization(ctx, model.OrganizationID)
	require.NoError(t, err)
	_, err = repository.ReplaceProviderObservations(ctx, original, observedDiscoveryModels())
	require.ErrorIs(t, err, ports.ErrConcurrentChange)
	headAfter, err := repository.GetExecutionSynchronization(ctx, model.OrganizationID)
	require.NoError(t, err)
	require.Equal(t, head, headAfter)
	source, err := repository.ReadExecutionSource(ctx, model.OrganizationID)
	require.NoError(t, err)
	require.EqualValues(t, 9007199254740991, source.ProviderObservations[0].SourceRevision)

}

// Execution head overflow must roll the observation upsert back too: the
// stored set keeps its prior source_revision and payload, and the
// desired/applied head stays untouched.
func TestProviderObservationsExecutionRevisionOverflowRollsBack(t *testing.T) {
	ctx := context.Background()
	repository := providerTestRepository(t)
	model, original := seedProviderObservationTarget(t, repository)
	_, err := repository.ReplaceProviderObservations(ctx, original, observedDiscoveryModels())
	require.NoError(t, err)
	head, err := repository.GetExecutionSynchronization(ctx, model.OrganizationID)
	require.NoError(t, err)

	_, err = repository.pool.Exec(ctx, `UPDATE agent_controller.execution_configuration_sync
SET revision=$2 WHERE organization_id=$1`, model.OrganizationID, ports.MaximumExecutionRevision)
	require.NoError(t, err)
	_, err = repository.ReplaceProviderObservations(ctx, original,
		[]ports.DiscoveredModel{{ModelID: "different-model"}})
	require.ErrorIs(t, err, ports.ErrConcurrentChange)
	source, err := repository.ReadExecutionSource(ctx, model.OrganizationID)
	require.NoError(t, err)
	require.Len(t, source.ProviderObservations, 1)
	require.EqualValues(t, 1, source.ProviderObservations[0].SourceRevision,
		"the failed transaction must leave the stored set at its prior revision")
	require.Equal(t, "integration-model", source.ProviderObservations[0].Models[0].Model,
		"the failed transaction must leave the stored payload unchanged")
	headAfter, err := repository.GetExecutionSynchronization(ctx, model.OrganizationID)
	require.NoError(t, err)
	head.Revision = ports.MaximumExecutionRevision
	require.Equal(t, head, headAfter, "desired/applied head unchanged apart from the forced max")
}

// End-to-end saved discovery through the real providerdiscovery client,
// endpoint policy, catalog service and repository. The /models upstream is an
// httptest fixture, not an external provider or ACP acceptance.
func TestSavedDiscoveryHeldResponseLosesBindingCASAfterRotation(t *testing.T) {
	ctx := context.Background()
	repository := providerTestRepository(t)

	release := make(chan struct{})
	var releaseOnce sync.Once
	releaseResponse := func() { releaseOnce.Do(func() { close(release) }) }
	var calls atomic.Int32
	var authorization atomic.Value
	upstream := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		calls.Add(1)
		authorization.Store(request.Header.Get("Authorization"))
		if calls.Load() == 1 {
			select {
			case <-release:
			case <-request.Context().Done():
				return
			}
		}
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{"data":[{"id":"integration-model","context_length":128000,"top_provider":{"max_completion_tokens":8192},"supported_parameters":["tools"]}]}`))
	}))
	t.Cleanup(func() {
		releaseResponse()
		upstream.Close()
	})
	model, original := seedProviderObservationTargetAtURL(t, repository, upstream.URL)
	client := providerdiscovery.New(10*time.Second, outbound.NewPolicy(true))
	service := application.NewCatalogService(repository, nil, providerTestClock{},
		application.WithProviderCredentialReader(repository, mutationCredentialOpener{}),
		application.WithProviderDiscovery(outbound.NewPolicy(true), client),
		application.WithProviderRequestTimeout(30*time.Second))
	type discoveryResult struct {
		result application.ProviderDiscoveryResult
		err    error
	}
	finished := make(chan discoveryResult, 1)
	started, joined := false, false
	defer func() {
		releaseResponse()
		client.CloseIdleConnections()
		if started && !joined {
			<-finished
		}
	}()
	started = true
	go func() {
		result, err := service.DiscoverProviderModels(ctx, model.OrganizationID, model.ProviderConnectionID)
		finished <- discoveryResult{result: result, err: err}
	}()

	// Wait until the first request is actually held upstream, then rotate the
	// saved credential with a distinct request identity.
	require.Eventually(t, func() bool { return calls.Load() >= 1 }, 5*time.Second, 10*time.Millisecond)
	rotated := original
	rotated.RequestID = "provider-observations-held-rotate"
	rotated.RequestFingerprint = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
	rotated.CredentialVersion = "version-rotated-held"
	rotated.CredentialRevision = original.CredentialRevision + 1
	rotated.UpdatedAt = rotated.UpdatedAt.Add(time.Minute)
	rotated.SealedCredential = ports.SealedSecret{Ciphertext: []byte("rotated"), Nonce: []byte("rotated-nonce")}
	_, err := repository.RotateProviderCredential(ctx, original.CredentialVersion, rotated)
	require.NoError(t, err)
	headAfterRotation, err := repository.GetExecutionSynchronization(ctx, model.OrganizationID)
	require.NoError(t, err)

	releaseResponse()
	var result discoveryResult
	select {
	case result = <-finished:
		joined = true
	case <-time.After(30 * time.Second):
		t.Fatal("held discovery never finished")
	}
	require.ErrorIs(t, result.err, ports.ErrConcurrentChange,
		"a response observed under the rotated credential must lose the binding CAS")
	require.Equal(t, "Bearer synthetic-revision-test-secret", authorization.Load().(string))

	source, err := repository.ReadExecutionSource(ctx, model.OrganizationID)
	require.NoError(t, err)
	require.Empty(t, source.ProviderObservations, "a CAS-losing discovery must not persist its set")
	headAfterReject, err := repository.GetExecutionSynchronization(ctx, model.OrganizationID)
	require.NoError(t, err)
	require.Equal(t, headAfterRotation, headAfterReject, "CAS rejection must not advance the execution head")
	snapshot, err := application.BuildExecutionSnapshot(ctx, source, mutationCredentialOpener{})
	require.NoError(t, err)
	require.Nil(t, snapshot.Models[0].ProviderTokenLimits)
	require.Nil(t, snapshot.Models[0].SupportsTools)

	// A fresh saved discovery under the rotated credential binds and persists.
	freshResult, err := service.DiscoverProviderModels(ctx, model.OrganizationID, model.ProviderConnectionID)
	require.NoError(t, err)
	require.Len(t, freshResult.Models, 1)
	source, err = repository.ReadExecutionSource(ctx, model.OrganizationID)
	require.NoError(t, err)
	require.Len(t, source.ProviderObservations, 1)
	require.Equal(t, "version-rotated-held", source.ProviderObservations[0].Binding.CredentialRevision)
	snapshot, err = application.BuildExecutionSnapshot(ctx, source, mutationCredentialOpener{})
	require.NoError(t, err)
	require.NotNil(t, snapshot.Models[0].ProviderTokenLimits)
	require.NotNil(t, snapshot.Models[0].SupportsTools)
}

func TestProviderObservationPublicationWaitsForActualHTTPAcknowledgement(t *testing.T) {
	for _, outcome := range []string{"valid_ack", "http_failure", "old_revision_ack"} {
		t.Run(outcome, func(t *testing.T) {
			ctx := context.Background()
			repository := providerTestRepository(t)
			model, original := seedProviderObservationTarget(t, repository)
			_, err := repository.ReplaceProviderObservations(ctx, original, observedDiscoveryModels())
			require.NoError(t, err)
			head, err := repository.GetExecutionSynchronization(ctx, model.OrganizationID)
			require.NoError(t, err)

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
					current.err = errors.New("unexpected publication route")
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
					_ = json.NewEncoder(response).Encode(map[string]string{"code": "configuration_unavailable"})
					return
				}
				acknowledgement := ports.ExecutionAcknowledgement{
					OrganizationID: current.snapshot.OrganizationID, AppliedRevision: current.snapshot.Revision,
				}
				if outcome == "old_revision_ack" {
					acknowledgement.AppliedRevision--
				}
				_ = json.NewEncoder(response).Encode(acknowledgement)
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
			publisher := application.NewExecutionPublisher(repository, mutationCredentialOpener{}, client)
			started = true
			go func() {
				acknowledgement, err := publisher.Publish(publicationContext, model.OrganizationID)
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
			require.Equal(t, model.OrganizationID, current.snapshot.OrganizationID)
			require.Equal(t, head.Revision, current.snapshot.Revision)
			require.Len(t, current.snapshot.Models, 1)
			var emitted struct {
				ProviderTokenLimits *domain.ProviderTokenLimits `json:"provider_token_limits"`
				SupportsTools       *bool                       `json:"supports_tools"`
			}
			require.NoError(t, json.Unmarshal(current.snapshot.Models[0], &emitted))
			require.NotNil(t, emitted.ProviderTokenLimits)
			require.Equal(t, domain.ProviderTokenLimitsSource, emitted.ProviderTokenLimits.Source)
			require.NotNil(t, emitted.SupportsTools)
			require.True(t, *emitted.SupportsTools)

			pending, err := repository.GetExecutionSynchronization(ctx, model.OrganizationID)
			require.NoError(t, err)
			require.Equal(t, head, pending, "held HTTP ACK cannot acknowledge the revision")
			releaseACK()
			var result publicationResult
			select {
			case result = <-finished:
				joined = true
			case <-publicationContext.Done():
				t.Fatalf("released ACK never completed: %v", publicationContext.Err())
			}
			if outcome == "valid_ack" {
				require.NoError(t, result.err)
				require.EqualValues(t, head.Revision, result.acknowledgement.AppliedRevision)
			} else {
				require.Error(t, result.err)
			}
			applied, err := repository.GetExecutionSynchronization(ctx, model.OrganizationID)
			require.NoError(t, err)
			if outcome == "valid_ack" {
				require.EqualValues(t, head.Revision, applied.AppliedRevision)
				require.NotNil(t, applied.AppliedAt, "a valid ACK must persist the applied watermark")
			} else {
				require.Equal(t, head.AppliedRevision, applied.AppliedRevision, "failed publications leave applied unchanged")
				require.Equal(t, head.AppliedAt, applied.AppliedAt, "failed publications leave the applied timestamp unchanged")
			}
			require.Equal(t, head.Revision, applied.Revision, "publication never writes the desired head")
		})
	}
}
