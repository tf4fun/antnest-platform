package postgres

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/require"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/credentials"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func TestExecutionCapacityRejectsWholeCatalogTransaction(t *testing.T) {
	repository := providerTestRepository(t)
	box, err := credentials.NewSecretBox(make([]byte, 32))
	require.NoError(t, err)
	guard, err := application.NewExecutionCapacity(box, 1)
	require.NoError(t, err)
	WithExecutionCapacityGuard(guard)(repository)
	catalog := application.NewCatalogService(repository, box, providerTestClock{})
	_, err = catalog.CreateProviderConnection(t.Context(), providerTestInput("capacity-reject", "org1"))
	require.ErrorIs(t, err, ports.ErrExecutionCapacityExceeded)
	for _, table := range []string{"provider_connections", "model_profiles", "catalog_requests", "execution_configuration_sync"} {
		var count int
		require.NoError(t, repository.pool.QueryRow(t.Context(), "SELECT count(*) FROM agent_controller."+table).Scan(&count))
		require.Zero(t, count, table)
	}
	require.Zero(t, repository.pool.Stat().AcquiredConns())
}

func TestExecutionCapacityConcurrentWritersCannotExceedOrganization(t *testing.T) {
	for _, mixed := range []bool{false, true} {
		t.Run(map[bool]string{false: "providers", true: "provider-model"}[mixed], func(t *testing.T) {
			testConcurrentExecutionCapacity(t, mixed)
		})
	}
}

func testConcurrentExecutionCapacity(t *testing.T, mixed bool) {
	t.Helper()
	repository := providerTestRepository(t)
	box, err := credentials.NewSecretBox(make([]byte, 32))
	require.NoError(t, err)
	catalog := application.NewCatalogService(repository, box, providerTestClock{})
	input := providerTestInput("capacity-first", "org1")
	input.Models = []application.ProviderModelInput{}
	provider, err := catalog.CreateProviderConnection(t.Context(), input)
	require.NoError(t, err)
	source, err := repository.ReadExecutionSource(t.Context(), "org1")
	require.NoError(t, err)
	candidate := source.Providers[0]
	candidate.ConnectionID = strings.Repeat("x", len(candidate.ConnectionID))
	source.Providers = append(source.Providers, candidate)
	// The synthetic second identity must use ciphertext sealed for that identity.
	candidateIdentity := ports.CredentialIdentity{OrganizationID: candidate.OrganizationID, CredentialRef: candidate.ConnectionID, CredentialVersion: candidate.CredentialVersion}
	source.Providers[1].SealedCredential, err = box.Seal(t.Context(), candidateIdentity, input.Credential.APIKey)
	require.NoError(t, err)
	measurement, err := application.NewExecutionCapacity(box, ports.DefaultExecutionSnapshotMaxBytes)
	require.NoError(t, err)
	limit, err := measurement.RequiredBytes(t.Context(), ports.ExecutionCapacityInput{Current: source})
	require.NoError(t, err)
	guard, err := application.NewExecutionCapacity(box, limit)
	require.NoError(t, err)
	WithExecutionCapacityGuard(guard)(repository)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	blocker, err := repository.pool.Begin(ctx)
	require.NoError(t, err)
	defer func() { _ = blocker.Rollback(context.Background()) }()
	require.NoError(t, lockExecutionOrganization(ctx, blocker, "org1"))
	var blockerPID int
	require.NoError(t, blocker.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&blockerPID))
	var workers sync.WaitGroup
	defer func() { cancel(); workers.Wait() }()
	results := make(chan error, 2)
	for index, requestID := range []string{"capacity-second", "capacity-third"} {
		workers.Add(1)
		go func() {
			defer workers.Done()
			if mixed && index == 1 {
				_, failure := catalog.CreateModelProfile(ctx, application.CreateModelProfileInput{
					RequestID: requestID, OrganizationID: "org1", ProfileKey: "new", DisplayName: "new",
					ProviderConnectionID: provider.ConnectionID, Model: domain.ModelParameters{Model: "new", ContextWindow: 8192, MaxOutputTokens: 1024},
				})
				results <- failure
				return
			}
			next := input
			next.RequestID = requestID
			_, failure := catalog.CreateProviderConnection(ctx, next)
			results <- failure
		}()
	}
	require.Eventually(t, func() bool {
		var waiting int
		err := repository.pool.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity
WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))`, blockerPID).Scan(&waiting)
		return err == nil && waiting == 2
	}, 5*time.Second, 10*time.Millisecond, "both mutations must wait for the same organization boundary")
	require.NoError(t, blocker.Commit(ctx))
	success, rejected := 0, 0
	for range 2 {
		failure := <-results
		switch {
		case failure == nil:
			success++
		case errors.Is(failure, ports.ErrExecutionCapacityExceeded):
			rejected++
		default:
			t.Errorf("unexpected write result: %v", failure)
		}
	}
	require.Equal(t, 1, success)
	require.Equal(t, 1, rejected)
	current, err := repository.ReadExecutionSource(t.Context(), "org1")
	require.NoError(t, err)
	require.Equal(t, 2, len(current.Providers)+len(current.Models))
	require.EqualValues(t, 2, current.Revision)
	require.NoError(t, guard.ValidateExecutionCapacity(t.Context(), ports.ExecutionCapacityInput{Current: current}))
}

func TestExecutionCapacityRejectsRotationAndModelWriteWithoutChangingCurrent(t *testing.T) {
	repository := providerTestRepository(t)
	box, err := credentials.NewSecretBox(make([]byte, 32))
	require.NoError(t, err)
	catalog := application.NewCatalogService(repository, box, providerTestClock{})
	input := providerTestInput("capacity-seed", "org1")
	provider, err := catalog.CreateProviderConnection(t.Context(), input)
	require.NoError(t, err)
	before, err := repository.ReadExecutionSource(t.Context(), "org1")
	require.NoError(t, err)
	measurement, err := application.NewExecutionCapacity(box, ports.DefaultExecutionSnapshotMaxBytes)
	require.NoError(t, err)
	limit, err := measurement.RequiredBytes(t.Context(), ports.ExecutionCapacityInput{Current: before})
	require.NoError(t, err)
	guard, err := application.NewExecutionCapacity(box, limit)
	require.NoError(t, err)
	WithExecutionCapacityGuard(guard)(repository)
	_, err = catalog.RotateProviderCredential(t.Context(), application.RotateProviderCredentialInput{
		RequestID: "capacity-rotate", OrganizationID: "org1", ConnectionID: provider.ConnectionID,
		ExpectedVersion: provider.CredentialVersion, Credential: application.ProviderCredentialInput{Method: "api_key", APIKey: strings.Repeat("x", 2048)},
	})
	require.ErrorIs(t, err, ports.ErrExecutionCapacityExceeded)
	_, err = catalog.CreateModelProfile(t.Context(), application.CreateModelProfileInput{
		RequestID: "capacity-model", OrganizationID: "org1", ProfileKey: "new-model", DisplayName: "new-model",
		ProviderConnectionID: provider.ConnectionID, Model: domain.ModelParameters{Model: "new-model", ContextWindow: 8192, MaxOutputTokens: 1024},
	})
	require.ErrorIs(t, err, ports.ErrExecutionCapacityExceeded)
	model := before.Models[0]
	_, err = catalog.ReviseModelProfile(t.Context(), application.ReviseModelProfileInput{
		RequestID: "capacity-model-revise", OrganizationID: "org1", ModelProfileID: model.ModelProfileID,
		ExpectedVersion: model.Revision.Revision(), DisplayName: strings.Repeat("x", 200), Model: model.Revision.Snapshot().Model.Parameters(),
	})
	require.ErrorIs(t, err, ports.ErrExecutionCapacityExceeded)
	after, err := repository.ReadExecutionSource(t.Context(), "org1")
	require.NoError(t, err)
	require.Equal(t, before, after)
	var rejectedReceipts int
	require.NoError(t, repository.pool.QueryRow(t.Context(), `SELECT count(*) FROM agent_controller.catalog_requests
WHERE request_id IN ('capacity-rotate', 'capacity-model', 'capacity-model-revise')`).Scan(&rejectedReceipts))
	require.Zero(t, rejectedReceipts)
	_, err = catalog.CreateProviderConnection(t.Context(), input)
	require.NoError(t, err, "existing command replay does not create a new configuration")
}

func TestExecutionCapacityReadsNeverReadyConfigurationAfterDisableFailure(t *testing.T) {
	repository := providerTestRepository(t)
	base, _ := seedConfiguredAgentForTest(t, t.Context(), repository, false)
	require.Empty(t, base.Agent.LastSuccessfulExecutionRevisionID)
	now := time.Now().Add(-15 * time.Second).UTC().Truncate(time.Microsecond)
	requestID, fingerprint := "capacity-disable-never-ready", strings.Repeat("7", 64)
	started, ctx := prepareDisableRuntimeFailure(t, t.Context(), repository, base, requestID, fingerprint, now)
	_, err := repository.FailAgentDisable(ctx, ports.FailAgentDisable{
		RequestID: requestID, Fingerprint: fingerprint, ExpectedAggregateSequence: started.Agent.AggregateSequence,
		Stage: domain.PhaseRuntimeDisable, Code: "runtime_lifecycle_conflict", Detail: "runtime unconfirmed",
		FailedEvent: ports.AgentEventRecord{
			EventID: "capacity-disable-failed", AgentID: base.Agent.AgentID, SchemaVersion: 1,
			EventType: ports.EventAgentDisableFailed, OperationRequestID: requestID, Data: map[string]any{}, OccurredAt: now.Add(4 * time.Second),
		}, Now: now.Add(4 * time.Second),
	})
	require.NoError(t, err)
	assertRetainedExecutionConfiguration(t, repository, base)
}

type capacitySourceCapture struct {
	input ports.ExecutionCapacityInput
}

func (capture *capacitySourceCapture) ValidateExecutionCapacity(_ context.Context, input ports.ExecutionCapacityInput) error {
	capture.input = input
	return nil
}

func TestExecutionCapacityReadsOwnedActiveTargetAndRetainedSpec(t *testing.T) {
	repository := providerTestRepository(t)
	base, _ := seedAvailableAgentForRebuild(t, t.Context(), repository)
	candidate := base.ConfiguredSpec
	candidate.ID, candidate.Revision = "capacity-smaller-spec", 2
	candidate.Snapshot.SystemPrompt = ""
	tx, err := repository.pool.Begin(t.Context())
	require.NoError(t, err)
	defer func() { _ = tx.Rollback(context.Background()) }()
	require.NoError(t, insertAgentSpec(t.Context(), tx, candidate))
	_, err = tx.Exec(t.Context(), `UPDATE agent_controller.agents SET executable_spec_revision_id=$2, executable_execution_revision_id='' WHERE id=$1`, base.Agent.AgentID, candidate.ID)
	require.NoError(t, err)
	require.NoError(t, tx.Commit(t.Context()))
	current, err := repository.ReadExecutionSource(t.Context(), base.Agent.OrganizationID)
	require.NoError(t, err)
	require.Len(t, current.Agents, 1)
	require.Equal(t, candidate.ID, current.Agents[0].Spec.ID)
	require.Equal(t, base.ConfiguredSpec.ID, current.Agents[0].RetainedSpec.ID)
	require.Equal(t, base.ConfiguredSpec.Snapshot.SystemPrompt, current.Agents[0].RetainedSpec.Snapshot.SystemPrompt)
	_, err = repository.pool.Exec(t.Context(), `UPDATE agent_controller.agents SET executable_spec_revision_id='', executable_execution_revision_id='' WHERE id=$1`, base.Agent.AgentID)
	require.NoError(t, err)
	source, err := repository.ReadExecutionSource(t.Context(), base.Agent.OrganizationID)
	require.NoError(t, err)
	require.Len(t, source.Agents, 1)
	require.Equal(t, base.Agent.AgentSpecRevisionID, source.Agents[0].RetainedSpec.ID)
	require.Equal(t, base.Agent.AgentSpecRevisionID, source.Agents[0].Spec.ID)
	require.Empty(t, source.Agents[0].Agent.AgentSpecRevisionID)
	var requestID string
	require.NoError(t, repository.pool.QueryRow(t.Context(), `SELECT request_id FROM agent_controller.agent_lifecycle_operations WHERE agent_id=$1 AND kind='create'`, base.Agent.AgentID).Scan(&requestID))
	_, err = repository.pool.Exec(t.Context(), `UPDATE agent_controller.agent_lifecycle_operations SET state='running', phase='publish' WHERE request_id=$1`, requestID)
	require.NoError(t, err)
	_, err = repository.pool.Exec(t.Context(), `UPDATE agent_controller.agents SET active_operation_request_id=$2 WHERE id=$1`, base.Agent.AgentID, requestID)
	require.NoError(t, err)
	capture := &capacitySourceCapture{}
	WithExecutionCapacityGuard(capture)(repository)
	provider := executionProvider(base.Agent.OrganizationID, "capacity-observer")
	_, err = repository.PutProviderConnection(t.Context(), provider, nil)
	require.NoError(t, err)
	require.Len(t, capture.input.Targets, 1)
	require.Equal(t, source.Agents[0].Spec.ID, capture.input.Targets[0].ID)
	require.Equal(t, base.Agent.AgentID, capture.input.Targets[0].AgentID)
	require.EqualValues(t, ports.MaximumExecutionRevision, capture.input.Current.Revision)
	_, err = repository.pool.Exec(t.Context(), `UPDATE agent_controller.agent_lifecycle_operations SET state='completed', phase='completed' WHERE request_id=$1`, requestID)
	require.NoError(t, err)
	provider.ConnectionID, provider.RequestID = "capacity-after-target", "capacity-after-target"
	_, err = repository.PutProviderConnection(t.Context(), provider, nil)
	require.NoError(t, err)
	require.Empty(t, capture.input.Targets, "completed history is not reserved forever")
}

func TestExecutionCapacitySourceRejectsDanglingRetainedExecution(t *testing.T) {
	repository := providerTestRepository(t)
	base, _ := seedAvailableAgentForRebuild(t, t.Context(), repository)
	_, err := repository.pool.Exec(t.Context(), `UPDATE agent_controller.agents SET last_successful_execution_revision_id='missing' WHERE id=$1`, base.Agent.AgentID)
	require.NoError(t, err)
	_, err = repository.ReadExecutionSource(t.Context(), base.Agent.OrganizationID)
	require.Error(t, err, "a valid active spec must not hide a broken fallback")
}

func TestExecutionCapacitySourceRejectsForeignRetainedExecution(t *testing.T) {
	repository := providerTestRepository(t)
	base, _ := seedAvailableAgentForRebuild(t, t.Context(), repository)
	foreign := base.Agent
	foreign.AgentID, foreign.OrganizationID = "foreign-agent", "foreign-organization"
	foreign.LifecycleState, foreign.ActivationState = domain.AgentNotCreated, ""
	spec := base.ConfiguredSpec
	spec.ID, spec.AgentID = "foreign-spec", foreign.AgentID
	execution := base.SourceExecution
	execution.ID, execution.AgentID, execution.AgentSpecRevisionID = "foreign-execution", foreign.AgentID, spec.ID
	tx, err := repository.pool.Begin(t.Context())
	require.NoError(t, err)
	defer func() { _ = tx.Rollback(context.Background()) }()
	require.NoError(t, insertAgent(t.Context(), tx, foreign))
	require.NoError(t, insertAgentSpec(t.Context(), tx, spec))
	require.NoError(t, insertExecutionRevision(t.Context(), tx, execution))
	_, err = tx.Exec(t.Context(), `UPDATE agent_controller.agents SET last_successful_execution_revision_id=$2 WHERE id=$1`, base.Agent.AgentID, execution.ID)
	require.NoError(t, err)
	require.NoError(t, tx.Commit(t.Context()))
	_, err = repository.ReadExecutionSource(t.Context(), base.Agent.OrganizationID)
	require.Error(t, err, "an existing foreign execution must not supply the retained configuration")
	_, err = repository.pool.Exec(t.Context(), `UPDATE agent_controller.execution_revisions SET agent_spec_revision_id=$2 WHERE id=$1`, base.SourceExecution.ID, spec.ID)
	var constraint *pgconn.PgError
	require.ErrorAs(t, err, &constraint)
	require.Equal(t, "23503", constraint.Code, "a retained execution cannot point at another Agent's spec")
}

func assertRetainedExecutionConfiguration(t *testing.T, repository *Repository, base ports.AgentLifecycleBase) {
	t.Helper()
	source, err := repository.ReadExecutionSource(t.Context(), base.Agent.OrganizationID)
	require.NoError(t, err)
	require.Len(t, source.Agents, 1)
	require.Equal(t, base.Agent.AgentSpecRevisionID, source.Agents[0].Spec.ID)
	require.Equal(t, base.Agent.AgentSpecRevisionID, source.Agents[0].RetainedSpec.ID)
	require.Equal(t, base.Agent.AgentSpecRevisionID, source.Agents[0].Agent.AgentSpecRevisionID)
	require.Empty(t, source.Agents[0].Agent.ExecutionRevisionID)
}
