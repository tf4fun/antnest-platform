package postgres

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func TestCatalogReferencesRejectStaleTemplateDependency(t *testing.T) {
	repository := providerTestRepository(t)
	model := integrationModelRecord(t)
	seedProviderForModel(t, repository, model)
	_, err := repository.PutModelProfile(t.Context(), model)
	require.NoError(t, err)
	template := integrationTemplateRecord(t, model.Revision)
	_, err = repository.SetCatalogAvailability(t.Context(), availabilityChange(ports.CatalogModel, model.ModelProfileID, model.OrganizationID, "disable-model", true, false))
	require.NoError(t, err)
	_, err = repository.PutTemplate(t.Context(), template)
	require.ErrorIs(t, err, ports.ErrDisabledReference)
	_, found, err := repository.ReplayTemplateRequest(t.Context(), ports.CreateTemplateRequest, template.RequestID, template.RequestFingerprint)
	require.NoError(t, err)
	require.False(t, found)
}

func TestCatalogReferencesTemplateRevisionPreservesAvailability(t *testing.T) {
	repository := providerTestRepository(t)
	base, seed := seedAvailableAgentForRebuild(t, t.Context(), repository)
	template, err := repository.GetTemplate(t.Context(), seed.Revision.Snapshot().TemplateID)
	require.NoError(t, err)
	revision := integrationRevisedTemplateRecord(t, template, seed.Model.Revision)
	_, err = repository.SetCatalogAvailability(t.Context(), availabilityChange(ports.CatalogTemplate, template.TemplateID, base.Agent.OrganizationID, "disable-template", true, false))
	require.NoError(t, err)
	written, err := repository.ReviseTemplate(t.Context(), 1, revision)
	require.NoError(t, err)
	require.False(t, written.Enabled, "a stale metadata edit must not report implicit enablement")
	current, err := repository.GetTemplate(t.Context(), template.TemplateID)
	require.NoError(t, err)
	require.False(t, current.Enabled)
	agent, err := loadAgentRecord(t.Context(), repository.pool, base.Agent.AgentID)
	require.NoError(t, err)
	require.Equal(t, base.Agent.ActivationState, agent.ActivationState)
	_, _, err = repository.BeginAgentCreate(t.Context(), identityCreate(base, "new-agent", base.Agent.OrganizationID, 0))
	require.ErrorIs(t, err, ports.ErrDisabledReference, "historical template revision must not bypass template retirement")
	_, _, err = repository.BeginAgentRebuild(t.Context(), catalogRebuildInput(t, base, seed.Revision, seed.Model.Revision))
	require.ErrorIs(t, err, ports.ErrDisabledReference)
}

func TestCatalogReferencesRejectForeignAgentConfiguration(t *testing.T) {
	repository := providerTestRepository(t)
	base, _ := seedAvailableAgentForRebuild(t, t.Context(), repository)
	_, _, err := repository.BeginAgentCreate(t.Context(), identityCreate(base, "foreign-agent", "foreign-org", 0))
	require.ErrorIs(t, err, ports.ErrNotFound)
}

func TestCatalogReferencesModelRevisionPreservesAvailability(t *testing.T) {
	repository := providerTestRepository(t)
	model := integrationModelRecord(t)
	seedProviderForModel(t, repository, model)
	_, err := repository.PutModelProfile(t.Context(), model)
	require.NoError(t, err)
	_, err = repository.SetCatalogAvailability(t.Context(), availabilityChange(ports.CatalogModel, model.ModelProfileID, model.OrganizationID, "disable-model", true, false))
	require.NoError(t, err)
	written, err := repository.ReviseModelProfile(t.Context(), 1, integrationRevisedModelRecord(t, model))
	require.NoError(t, err)
	require.False(t, written.Enabled)
}

func TestCatalogReferencesCredentialRotationPreservesAvailability(t *testing.T) {
	repository := providerTestRepository(t)
	model := integrationModelRecord(t)
	seedProviderForModel(t, repository, model)
	source, err := repository.ReadExecutionSource(t.Context(), model.OrganizationID)
	require.NoError(t, err)
	connection := source.Providers[0]
	expected := connection.CredentialVersion
	connection.RequestID, connection.CredentialVersion, connection.CredentialRevision = "rotate-after-disable", "new-version", 2
	connection.RequestFingerprint = strings.Repeat("b", 64)
	_, err = repository.SetCatalogAvailability(t.Context(), availabilityChange(ports.CatalogProvider, connection.ConnectionID, model.OrganizationID, "disable-provider", true, false))
	require.NoError(t, err)
	rotated, err := repository.RotateProviderCredential(t.Context(), expected, connection)
	require.NoError(t, err)
	require.False(t, rotated.Enabled)
	current, err := repository.GetProviderConnection(t.Context(), model.OrganizationID, connection.ConnectionID)
	require.NoError(t, err)
	require.False(t, current.Enabled)
	require.Equal(t, "new-version", current.CredentialVersion)
}

func TestCatalogReferencesConcurrentTemplateAndModelDisable(t *testing.T) {
	repository := providerTestRepository(t)
	model := integrationModelRecord(t)
	seedProviderForModel(t, repository, model)
	_, err := repository.PutModelProfile(t.Context(), model)
	require.NoError(t, err)
	template := integrationTemplateRecord(t, model.Revision)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	blocker, err := repository.pool.Begin(ctx)
	require.NoError(t, err)
	defer func() { _ = blocker.Rollback(context.Background()) }()
	require.NoError(t, lockExecutionOrganization(ctx, blocker, model.OrganizationID))
	var blockerPID int
	require.NoError(t, blocker.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&blockerPID))
	var workers sync.WaitGroup
	defer func() { cancel(); workers.Wait() }()
	results := make(chan error, 2)
	workers.Add(2)
	go func() {
		defer workers.Done()
		_, failure := repository.PutTemplate(ctx, template)
		results <- failure
	}()
	go func() {
		defer workers.Done()
		_, failure := repository.SetCatalogAvailability(ctx, availabilityChange(ports.CatalogModel, model.ModelProfileID, model.OrganizationID, "disable-model", true, false))
		results <- failure
	}()
	require.Eventually(t, func() bool {
		var waiting int
		err := repository.pool.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))`, blockerPID).Scan(&waiting)
		return err == nil && waiting == 2
	}, 5*time.Second, 10*time.Millisecond)
	require.NoError(t, blocker.Commit(ctx))
	success, rejected := 0, 0
	for range 2 {
		failure := <-results
		var conflict *ports.CatalogReferenceConflict
		switch {
		case failure == nil:
			success++
		case errors.Is(failure, ports.ErrDisabledReference), errors.As(failure, &conflict):
			rejected++
		default:
			t.Errorf("unexpected reference mutation result: %v", failure)
		}
	}
	require.Equal(t, 1, success)
	require.Equal(t, 1, rejected)
}

func TestCatalogReferencesProtectActiveTargetButNotAbandonedHistory(t *testing.T) {
	repository := providerTestRepository(t)
	base, seed := seedAvailableAgentForRebuild(t, t.Context(), repository)
	model, template := catalogReplacement(t, repository, seed)
	begin := catalogRebuildInput(t, base, template.Revision, model.Revision)
	started, replayed, err := repository.BeginAgentRebuild(t.Context(), begin)
	require.NoError(t, err)
	require.False(t, replayed)
	_, err = repository.SetCatalogAvailability(t.Context(), availabilityChange(ports.CatalogTemplate, template.TemplateID, base.Agent.OrganizationID, "disable-template", true, false))
	require.NoError(t, err)
	_, replayed, err = repository.BeginAgentRebuild(t.Context(), begin)
	require.NoError(t, err, "an existing target is not a new derivation")
	require.True(t, replayed)
	change := availabilityChange(ports.CatalogModel, model.ModelProfileID, base.Agent.OrganizationID, "disable-target", true, false)
	_, err = repository.SetCatalogAvailability(t.Context(), change)
	var conflict *ports.CatalogReferenceConflict
	require.ErrorAs(t, err, &conflict)
	require.Equal(t, []ports.CatalogReference{{Kind: "lifecycle_operation", ResourceID: begin.Operation.RequestID, AgentID: base.Agent.AgentID, OperationID: begin.Operation.RequestID}}, conflict.References)
	_, err = repository.FailAgentRebuild(t.Context(), ports.FailAgentRebuild{
		RequestID: begin.Operation.RequestID, Fingerprint: begin.Operation.RequestFingerprint,
		ExpectedAggregateSequence: started.Agent.AggregateSequence, Stage: domain.PhaseDrain,
		Code: "drain_timeout", Detail: "synthetic timeout before runtime mutation", PreserveExecutable: true,
		FailedEvent: ports.AgentEventRecord{EventID: "abandon-target", AgentID: base.Agent.AgentID, SchemaVersion: 1,
			EventType: ports.EventAgentBuildFailed, OperationRequestID: begin.Operation.RequestID, Data: map[string]any{}, OccurredAt: begin.Now}, Now: begin.Now,
	})
	require.NoError(t, err)
	_, err = repository.SetCatalogAvailability(t.Context(), change)
	require.NoError(t, err, "abandoned target must not remain a permanent reference")
	_, err = repository.SetCatalogAvailability(t.Context(), availabilityChange(ports.CatalogModel, seed.Model.ModelProfileID, base.Agent.OrganizationID, "disable-source", true, false))
	require.ErrorAs(t, err, &conflict)
	require.Equal(t, []ports.CatalogReference{{Kind: "agent", ResourceID: base.Agent.AgentID, AgentID: base.Agent.AgentID}}, conflict.References)
}

func TestCatalogReferencesRegisteredTargetSurvivesTemplateRetirement(t *testing.T) {
	repository := providerTestRepository(t)
	base, seed := seedAvailableAgentForRebuild(t, t.Context(), repository)
	model, template := catalogReplacement(t, repository, seed)
	begin := catalogRebuildInput(t, base, template.Revision, model.Revision)
	_, _, err := repository.BeginAgentRebuild(t.Context(), begin)
	require.NoError(t, err)
	_, err = repository.SetCatalogAvailability(t.Context(), availabilityChange(ports.CatalogTemplate, template.TemplateID, base.Agent.OrganizationID, "disable-template", true, false))
	require.NoError(t, err)
	catalogPublishRebuild(t, repository, begin)
	state, err := repository.GetAgentLifecycleBase(t.Context(), base.Agent.AgentID)
	require.NoError(t, err)
	require.Equal(t, begin.TargetSpec.ID, state.ConfiguredSpec.ID)
	operation, err := loadLifecycleOperation(t.Context(), repository.pool, begin.Operation.RequestID, "")
	require.NoError(t, err)
	observeRuntimeForTest(t, t.Context(), repository, state.Agent, operation, "new-execution", "new-runtime-execution", "http://runtime:8091/mcp")
	current, err := loadAgentRecord(t.Context(), repository.pool, base.Agent.AgentID)
	require.NoError(t, err)
	require.True(t, current.ExecutionReady())
}

func TestCatalogReferencesEnableReusesConfigurationWithoutTemplate(t *testing.T) {
	repository := providerTestRepository(t)
	available, _ := seedAvailableAgentForRebuild(t, t.Context(), repository)
	disabled := seedDisabledAgentForEnable(t, t.Context(), repository, available)
	base, err := repository.GetAgentEnableBase(t.Context(), disabled.AgentID)
	require.NoError(t, err)
	_, err = repository.SetCatalogAvailability(t.Context(), availabilityChange(ports.CatalogTemplate, base.Spec.Snapshot.TemplateID, base.Agent.OrganizationID, "retire-template", true, false))
	require.NoError(t, err)
	now, request := time.Now().UTC(), "enable-existing"
	_, replayed, err := repository.BeginAgentEnable(t.Context(), ports.BeginAgentEnable{
		AgentID: base.Agent.AgentID, ExpectedAggregateSequence: base.Agent.AggregateSequence,
		ExpectedSpecRevisionID: base.Spec.ID, ExpectedExecutionRevisionID: base.LastSuccessfulExecution.ID,
		ExpectedRuntimeRevision: base.Agent.RuntimeRevision,
		Operation: ports.LifecycleOperationRecord{
			RequestID: request, RequestFingerprint: strings.Repeat("a", 64), AgentID: base.Agent.AgentID,
			Kind: domain.OperationEnable, Phase: domain.PhaseNetworkEnsure, State: domain.OperationRunning,
			SourceSpecRevisionID: base.Spec.ID, SourceExecutionRevisionID: base.LastSuccessfulExecution.ID,
			SourceRuntimeRevision: base.Agent.RuntimeRevision, TargetSpecRevisionID: base.Spec.ID,
			ChildRequestID: domain.ChildRequestID(request, domain.PhaseNetworkEnsure), CreatedAt: now, UpdatedAt: now,
		},
		RequestedEvent: ports.AgentEventRecord{EventID: "event-" + request, AgentID: base.Agent.AgentID, SchemaVersion: 1,
			EventType: ports.EventAgentEnableRequested, AggregateSequence: base.Agent.AggregateSequence + 1,
			OperationRequestID: request, Data: map[string]any{}, OccurredAt: now}, Now: now,
	})
	require.NoError(t, err)
	require.False(t, replayed)
}

func catalogRebuildInput(t *testing.T, base ports.AgentLifecycleBase, template domain.TemplateRevision, model domain.ModelProfileRevision) ports.BeginAgentRebuild {
	t.Helper()
	spec, err := domain.MaterializeAgentSpec(template, model)
	require.NoError(t, err)
	digest, err := spec.Digest()
	require.NoError(t, err)
	now := time.Now().UTC()
	request, specID := fmt.Sprintf("catalog-rebuild-%d", base.NextSpecRevision), fmt.Sprintf("catalog-target-spec-%d", base.NextSpecRevision)
	deadline := now.Add(time.Minute)
	return ports.BeginAgentRebuild{
		AgentID: base.Agent.AgentID, ExpectedAggregateSequence: base.Agent.AggregateSequence,
		ExpectedSpecRevisionID: base.ConfiguredSpec.ID, ExpectedExecutionRevisionID: base.SourceExecution.ID,
		ExpectedRuntimeRevision: base.Agent.RuntimeRevision,
		TargetSpec:              ports.AgentSpecRecord{ID: specID, AgentID: base.Agent.AgentID, Revision: base.NextSpecRevision, Snapshot: spec.Snapshot(), CanonicalDigest: digest, CreatedAt: now},
		Operation: ports.LifecycleOperationRecord{
			RequestID: request, RequestFingerprint: base.ConfiguredSpec.CanonicalDigest, AgentID: base.Agent.AgentID,
			Kind: domain.OperationRebuild, Phase: domain.PhaseDrain, State: domain.OperationRunning,
			DrainDeadlineAt:      &deadline,
			SourceSpecRevisionID: base.ConfiguredSpec.ID, SourceExecutionRevisionID: base.SourceExecution.ID,
			SourceRuntimeRevision: base.Agent.RuntimeRevision, TargetSpecRevisionID: specID,
			ChildRequestID: domain.ChildRequestID(request, domain.PhaseDrain), CreatedAt: now, UpdatedAt: now,
		},
		RequestedEvent: ports.AgentEventRecord{EventID: "event-" + request, AgentID: base.Agent.AgentID,
			AggregateSequence: base.Agent.AggregateSequence + 1, SchemaVersion: 1, EventType: ports.EventAgentRebuildRequested,
			OperationRequestID: request, Data: map[string]any{}, OccurredAt: now},
		Now: now,
	}
}
