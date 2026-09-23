package postgres

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestDeleteUnpublishedRuntimeSourceFrozenTransactionally(t *testing.T) {
	for _, source := range []string{"failed", "runtime_not_found", "runtime_deleted"} {
		t.Run(source, func(t *testing.T) { testDeleteSourceTransaction(t, source) })
	}
}

func testDeleteSourceTransaction(t *testing.T, source string) {
	t.Helper()
	databaseURL := os.Getenv("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	repository, err := Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(repository.Close)
	base, _ := seedAvailableAgentForRebuild(t, ctx, repository)
	now := time.Now().UTC()
	if _, err := repository.pool.Exec(ctx, `UPDATE agent_controller.agents SET runtime_state='unknown', runtime_revision='', runtime_execution_id='', runtime_mcp_endpoint='' WHERE id=$1`, base.Agent.AgentID); err != nil {
		t.Fatal(err)
	}
	base.Agent.LifecycleState, base.Agent.ActivationState, base.Agent.RuntimeState = domain.AgentCreated, domain.ActivationEnabled, domain.RuntimeUnknown
	base.Agent.RuntimeRevision, base.Agent.RuntimeExecutionID, base.Agent.RuntimeMCPEndpoint = "", "", ""
	requestID, fingerprint := "delete-unpublished", strings.Repeat("f", 64)
	if _, _, err := repository.BeginAgentDelete(ctx, deleteBegin(base.Agent, requestID, fingerprint, now)); err != nil {
		t.Fatal(err)
	}
	if _, err := repository.ConfirmLifecycleDrain(ctx, ports.ConfirmLifecycleDrain{RequestID: requestID, Fingerprint: fingerprint, Kind: domain.OperationDelete, Outcome: ports.ExecutionSettled, Now: now}); err != nil {
		t.Fatal(err)
	}
	input := ports.AdvanceAgentDelete{RequestID: requestID, Fingerprint: fingerprint, ExpectedPhase: domain.PhaseNetworkFence,
		NextPhase: domain.PhaseRuntimeDelete, Now: now,
		NetworkAttachment: &ports.NetworkAttachment{AgentID: base.Agent.AgentID, State: ports.NetworkStateActive, AttachmentState: ports.NetworkAttachmentClosed},
	}
	if source == "failed" {
		input.SourceRuntimeInspection = &ports.RuntimeInspection{AgentID: base.Agent.AgentID, RuntimeRevision: "rtv_retained", LifecycleState: "failed", Health: "unhealthy"}
	} else {
		input.NextPhase = domain.PhaseNetworkRelease
		input.SourceRuntimeAbsenceProof = &ports.RuntimeAbsenceProof{Reason: source, ObservedAt: now}
		if source == "runtime_deleted" {
			input.SourceRuntimeAbsenceProof.RuntimeRevision = "rtv_deleted"
		}
	}
	input.NextChildRequestID = domain.ChildRequestID(requestID, input.NextPhase)
	state, err := repository.AdvanceAgentDelete(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	if state.Operation.Phase != input.NextPhase || state.Operation.SourceRuntimeAbsent != (source != "failed") {
		t.Fatalf("source not committed: %+v", state.Operation)
	}
	if source == "failed" && state.Operation.SourceRuntimeRevision != "rtv_retained" {
		t.Fatalf("source revision lost: %+v", state.Operation)
	}
	if _, err := repository.AdvanceAgentDelete(ctx, input); !errors.Is(err, ports.ErrConcurrentChange) {
		t.Fatalf("old phase overwrote frozen source: %v", err)
	}
	reader, err := Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(reader.Close)
	reloaded, found, err := reader.ReplayAgentDelete(ctx, requestID, fingerprint)
	if err != nil || !found || reloaded.Operation.ChildRequestID != input.NextChildRequestID || reloaded.Operation.SourceRuntimeRevision != state.Operation.SourceRuntimeRevision {
		t.Fatalf("durable source replay: %+v %v", reloaded.Operation, err)
	}
	if source == "failed" {
		state, err = repository.AdvanceAgentDelete(ctx, ports.AdvanceAgentDelete{RequestID: requestID, Fingerprint: fingerprint,
			ExpectedPhase: domain.PhaseRuntimeDelete, NextPhase: domain.PhaseNetworkRelease,
			NextChildRequestID: domain.ChildRequestID(requestID, domain.PhaseNetworkRelease), Now: now,
			RuntimeResult: &ports.RuntimeOperation{State: "completed", Effect: "completed", RuntimeRevision: "rtv_deleted", LifecycleState: "deleted", Health: "absent"},
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	if state.Operation.NetworkAttachment == nil {
		t.Fatal("fixture lost prior closed attachment")
	}
	state, err = repository.AdvanceAgentDelete(ctx, ports.AdvanceAgentDelete{RequestID: requestID, Fingerprint: fingerprint,
		ExpectedPhase: domain.PhaseNetworkRelease, NextPhase: domain.PhasePublish,
		NextChildRequestID: domain.ChildRequestID(requestID, domain.PhasePublish), NetworkReleaseOutcome: ports.NetworkReleaseAuthoritativeNone, Now: now,
	})
	if err != nil || state.Operation.NetworkAttachment != nil || !deleteOperationHasPublishProof(state.Operation) {
		t.Fatalf("authoritative absent network retained old attachment: %+v %v", state.Operation, err)
	}
}
