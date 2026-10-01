package postgres

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func TestCatalogFailureKeepsCurrentConfiguration(t *testing.T) {
	for _, history := range []struct {
		name  string
		ready bool
	}{{"last-successful", true}, {"never-ready", false}} {
		for _, kind := range []domain.OperationKind{domain.OperationRebuild, domain.OperationDisable} {
			t.Run(history.name+"/"+string(kind), func(t *testing.T) {
				repository := providerTestRepository(t)
				base, seed := seedConfiguredAgentForTest(t, t.Context(), repository, history.ready)
				model, template := catalogReplacement(t, repository, seed)
				begin := catalogRebuildInput(t, base, template.Revision, model.Revision)
				_, _, err := repository.BeginAgentRebuild(t.Context(), begin)
				require.NoError(t, err)
				catalogPublishRebuild(t, repository, begin)
				current, err := repository.GetAgentLifecycleBase(t.Context(), base.Agent.AgentID)
				require.NoError(t, err)
				require.Equal(t, begin.TargetSpec.ID, current.ConfiguredSpec.ID)
				_, err = repository.SetCatalogAvailability(t.Context(), availabilityChange(ports.CatalogProvider, seed.Model.ProviderConnectionID, base.Agent.OrganizationID, "retire-old-provider", true, false))
				require.NoError(t, err, "historical execution must not reserve its Provider")
				catalogFailCurrent(t, repository, current, template, model, kind)
				source, err := repository.ReadExecutionSource(t.Context(), base.Agent.OrganizationID)
				require.NoError(t, err)
				require.Len(t, source.Agents, 1)
				agent := source.Agents[0]
				require.Equal(t, begin.TargetSpec.ID, agent.Spec.ID, "failure must not select historical configuration")
				require.Equal(t, model.ModelProfileID, agent.Spec.Snapshot.ModelProfileID)
				require.Equal(t, begin.TargetSpec.ID, agent.Agent.AgentSpecRevisionID)
				require.Empty(t, agent.Agent.ExecutionRevisionID)
				require.Empty(t, agent.Agent.RuntimeRevision)
				require.False(t, agent.Agent.ExecutionReady())
				_, err = repository.SetCatalogAvailability(t.Context(), availabilityChange(ports.CatalogTemplate, template.TemplateID, base.Agent.OrganizationID, "retire-template", true, false))
				require.NoError(t, err)
				_, err = repository.SetCatalogAvailability(t.Context(), availabilityChange(ports.CatalogModel, model.ModelProfileID, base.Agent.OrganizationID, "retire-current-model", true, false))
				var conflict *ports.CatalogReferenceConflict
				require.ErrorAs(t, err, &conflict)
				require.Equal(t, []ports.CatalogReference{{Kind: "agent", ResourceID: base.Agent.AgentID, AgentID: base.Agent.AgentID}}, conflict.References)
			})
		}
	}
}

func catalogReplacement(t *testing.T, repository *Repository, seed rebuildSeed) (ports.ModelProfileRecord, ports.TemplateRecord) {
	t.Helper()
	model := seed.Model
	model.RequestID, model.ModelProfileID, model.ProviderConnectionID, model.ProfileKey = "new-model", "model-new", "provider-new", "new-model-key"
	input := domain.ModelProfileRevisionInput(seed.Model.Revision.Snapshot())
	input.ID, input.ModelProfileID = "modelrev-new", model.ModelProfileID
	var err error
	model.Revision, err = domain.NewModelProfileRevision(input)
	require.NoError(t, err)
	seedProviderForModel(t, repository, model)
	_, err = repository.PutModelProfile(t.Context(), model)
	require.NoError(t, err)
	template, err := repository.GetTemplate(t.Context(), seed.Revision.Snapshot().TemplateID)
	require.NoError(t, err)
	template = integrationRevisedTemplateRecord(t, template, model.Revision)
	template, err = repository.ReviseTemplate(t.Context(), 1, template)
	require.NoError(t, err)
	return model, template
}

func catalogPublishRebuild(t *testing.T, repository *Repository, begin ports.BeginAgentRebuild) {
	t.Helper()
	ctx := t.Context()
	request, fingerprint, now := begin.Operation.RequestID, begin.Operation.RequestFingerprint, begin.Now
	_, err := repository.ConfirmLifecycleDrain(ctx, ports.ConfirmLifecycleDrain{RequestID: request, Fingerprint: fingerprint, Kind: domain.OperationRebuild, Outcome: ports.ExecutionSettled, Now: now})
	require.NoError(t, err)
	attachment := closedNetworkAttachment(begin.AgentID)
	_, err = repository.AdvanceAgentRebuild(ctx, ports.AdvanceAgentRebuild{RequestID: request, Fingerprint: fingerprint,
		ExpectedPhase: domain.PhaseNetworkFence, NextPhase: domain.PhaseRuntimeUpdate, NextChildRequestID: domain.ChildRequestID(request, domain.PhaseRuntimeUpdate), NetworkAttachment: attachment, Now: now})
	require.NoError(t, err)
	runtime := ports.RuntimeOperation{State: "completed", Effect: "completed", RuntimeRevision: "rtv_22222222222222222222222222222222", LifecycleState: "provisioned", Health: "unknown"}
	_, err = repository.AdvanceAgentRebuild(ctx, ports.AdvanceAgentRebuild{RequestID: request, Fingerprint: fingerprint,
		ExpectedPhase: domain.PhaseRuntimeUpdate, NextPhase: domain.PhaseNetworkEnsure, NextChildRequestID: domain.ChildRequestID(request, domain.PhaseNetworkEnsure),
		RuntimeResult: &runtime, Now: now})
	require.NoError(t, err)
	attachment.AttachmentState, attachment.AttachmentResourceVersion = ports.NetworkAttachmentOpen, attachment.AttachmentResourceVersion+1
	state, err := repository.AdvanceAgentRebuild(ctx, ports.AdvanceAgentRebuild{RequestID: request, Fingerprint: fingerprint,
		ExpectedPhase: domain.PhaseNetworkEnsure, NextPhase: domain.PhasePublish, NextChildRequestID: domain.ChildRequestID(request, domain.PhasePublish), NetworkAttachment: attachment, Now: now})
	require.NoError(t, err)
	_, err = repository.PublishAgentRebuild(ctx, ports.PublishAgentRebuild{RequestID: request, Fingerprint: fingerprint, AccessRevision: state.Agent.AccessRevision,
		RebuiltEvent: ports.AgentEventRecord{EventID: "published-" + request, AgentID: begin.AgentID, AggregateSequence: state.Agent.AggregateSequence + 1,
			SchemaVersion: 1, EventType: ports.EventAgentRebuilt, OperationRequestID: request, Data: map[string]any{}, OccurredAt: now}, Now: now})
	require.NoError(t, err)
}

func catalogFailCurrent(t *testing.T, repository *Repository, base ports.AgentLifecycleBase, template ports.TemplateRecord, model ports.ModelProfileRecord, kind domain.OperationKind) {
	t.Helper()
	ctx, now := t.Context(), time.Now().UTC()
	if kind == domain.OperationRebuild {
		begin := catalogRebuildInput(t, base, template.Revision, model.Revision)
		started, _, err := repository.BeginAgentRebuild(ctx, begin)
		require.NoError(t, err)
		input := ports.FailAgentRebuild{RequestID: begin.Operation.RequestID, Fingerprint: begin.Operation.RequestFingerprint,
			ExpectedAggregateSequence: started.Agent.AggregateSequence, Stage: domain.PhaseDrain, Code: "runtime_absent", Detail: "synthetic runtime loss",
			FailedEvent: ports.AgentEventRecord{EventID: "failed-rebuild", AgentID: base.Agent.AgentID, SchemaVersion: 1, EventType: ports.EventAgentBuildFailed,
				OperationRequestID: begin.Operation.RequestID, Data: map[string]any{}, OccurredAt: now}, Now: now}
		_, err = repository.FailAgentRebuild(ctx, input)
		require.NoError(t, err)
		_, err = repository.FailAgentRebuild(ctx, input)
		require.NoError(t, err, "terminal replay must preserve current configuration")
		return
	}
	fingerprint := base.ConfiguredSpec.CanonicalDigest
	started, _ := prepareDisableRuntimeFailure(t, ctx, repository, base, "fail-disable", fingerprint, now)
	input := ports.FailAgentDisable{RequestID: "fail-disable", Fingerprint: fingerprint, ExpectedAggregateSequence: started.Agent.AggregateSequence,
		Stage: domain.PhaseRuntimeDisable, Code: "runtime_absent", Detail: "synthetic runtime loss",
		FailedEvent: ports.AgentEventRecord{EventID: "failed-disable", AgentID: base.Agent.AgentID, SchemaVersion: 1, EventType: ports.EventAgentDisableFailed,
			OperationRequestID: "fail-disable", Data: map[string]any{}, OccurredAt: now}, Now: now}
	_, err := repository.FailAgentDisable(ctx, input)
	require.NoError(t, err)
	_, err = repository.FailAgentDisable(ctx, input)
	require.NoError(t, err)
}
