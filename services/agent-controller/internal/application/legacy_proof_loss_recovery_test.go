package application

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

type proofLossRecoveryStoreStub struct {
	agent                                              ports.AgentRecord
	failed                                             ports.LifecycleOperationRecord
	record                                             ports.LegacyProofLossRecoveryRecord
	beginCalls, recordCalls, publishCalls, manualCalls int
}

func (stub *proofLossRecoveryStoreStub) MarkLegacyProofLossManualRecovery(_ context.Context, requestID, fingerprint, phase, reason string, _ time.Time) (ports.LegacyProofLossRecoveryRecord, error) {
	stub.manualCalls++
	stub.record.State = "manual_recovery_required"
	stub.record.ErrorCode = "legacy_migration_manual_recovery_required"
	stub.record.ManualReason = reason
	return stub.record, nil
}

func (stub *proofLossRecoveryStoreStub) GetAgent(_ context.Context, _ string) (ports.AgentRecord, error) {
	return stub.agent, nil
}
func (stub *proofLossRecoveryStoreStub) GetLifecycleOperation(_ context.Context, _ string) (ports.LifecycleOperationRecord, error) {
	return stub.failed, nil
}
func (stub *proofLossRecoveryStoreStub) GetLegacyProofLossRecovery(_ context.Context, _ string) (ports.LegacyProofLossRecoveryRecord, error) {
	if stub.record.RequestID == "" {
		return ports.LegacyProofLossRecoveryRecord{}, ports.ErrNotFound
	}
	return stub.record, nil
}
func (stub *proofLossRecoveryStoreStub) BeginLegacyProofLossRecovery(_ context.Context, input ports.BeginLegacyProofLossRecovery) (ports.LegacyProofLossRecoveryRecord, bool, error) {
	stub.beginCalls++
	stub.record = ports.LegacyProofLossRecoveryRecord{RequestID: input.RequestID, Fingerprint: input.Fingerprint, AgentID: input.AgentID, OrganizationID: input.OrganizationID,
		ActorPrincipalID: input.ActorPrincipalID, FailedMigrationRequestID: input.FailedMigrationRequestID, TargetRuntimeRevision: input.TargetRuntimeRevision,
		ObservedRuntimeExecutionID: input.ObservedRuntimeExecutionID, ClosedAttachmentVersion: input.ClosedAttachmentVersion, ChildRequestID: input.ChildRequestID,
		State: "running", Phase: "disable_runtime"}
	return stub.record, false, nil
}
func (stub *proofLossRecoveryStoreStub) RecordLegacyProofLossRuntimeDisabled(_ context.Context, requestID, fingerprint, childID string, result ports.RuntimeOperation, _ time.Time) (ports.LegacyProofLossRecoveryRecord, error) {
	stub.recordCalls++
	if childID != stub.record.ChildRequestID {
		return ports.LegacyProofLossRecoveryRecord{}, ports.ErrConcurrentChange
	}
	stub.record.DisabledRuntimeRevision = result.RuntimeRevision
	stub.record.DisabledRuntimeResult = &result
	stub.record.Phase = "publish"
	return stub.record, nil
}
func (stub *proofLossRecoveryStoreStub) PublishLegacyProofLossRecovery(_ context.Context, requestID, fingerprint string, version uint64, eventID, traceID string, _ time.Time) (ports.LegacyProofLossRecoveryRecord, error) {
	stub.publishCalls++
	if version != stub.record.ClosedAttachmentVersion {
		return ports.LegacyProofLossRecoveryRecord{}, ports.ErrConcurrentChange
	}
	stub.record.State, stub.record.Phase = "completed", "done"
	return stub.record, nil
}

type proofLossRecoveryRuntimeStub struct {
	inspection                 ports.RuntimeInspection
	result                     ports.RuntimeOperation
	inspectErr                 error
	disableErr                 error
	inspectCalls, disableCalls int
	childID, targetRevision    string
}

func (stub *proofLossRecoveryRuntimeStub) InspectRuntime(_ context.Context, _ string) (ports.RuntimeInspection, error) {
	stub.inspectCalls++
	if stub.inspectErr != nil {
		return ports.RuntimeInspection{}, stub.inspectErr
	}
	return stub.inspection, nil
}
func (stub *proofLossRecoveryRuntimeStub) DisableRuntime(_ context.Context, childID, _, target string) (ports.RuntimeOperation, error) {
	stub.disableCalls++
	stub.childID, stub.targetRevision = childID, target
	if stub.disableErr != nil {
		return ports.RuntimeOperation{}, stub.disableErr
	}
	return stub.result, nil
}

type proofLossRecoveryEgressStub struct {
	attachment ports.NetworkAttachment
	calls      int
}

func (stub *proofLossRecoveryEgressStub) GetAgentNetwork(_ context.Context, _ string) (ports.NetworkAttachment, error) {
	stub.calls++
	return stub.attachment, nil
}

func proofLossRecoveryFixture() (*LegacyProofLossRecoveryService, *proofLossRecoveryStoreStub, *proofLossRecoveryRuntimeStub, *proofLossRecoveryEgressStub, LegacyProofLossRecoveryInput) {
	const agentID = "agent_11111111111111111111111111111111"
	const target = "rtv_22222222222222222222222222222222"
	store := &proofLossRecoveryStoreStub{agent: ports.AgentRecord{AgentID: agentID, OrganizationID: "org_11111111111111111111111111111111",
		FailureCode: "legacy_migration_proof_lost", LifecycleState: domain.AgentCreated, DesiredState: domain.DesiredEnabled, ActivationState: domain.ActivationEnabled, AggregateSequence: 4},
		failed: ports.LifecycleOperationRecord{RequestID: "failed-1", AgentID: agentID, Kind: domain.OperationRebuild, Phase: domain.PhasePublish, State: domain.OperationFailed,
			ErrorCode: "legacy_migration_proof_lost", RuntimeResult: &ports.RuntimeOperation{State: "completed", Effect: "completed", LifecycleState: "provisioned", RuntimeRevision: target}}}
	runtime := &proofLossRecoveryRuntimeStub{inspection: ports.RuntimeInspection{AgentID: agentID, RuntimeRevision: target, RuntimeExecutionID: "process-1", Phase: "running", LifecycleState: "provisioned"},
		result: ports.RuntimeOperation{State: "completed", Effect: "completed", RuntimeRevision: "rtv_33333333333333333333333333333333", LifecycleState: "disabled", Health: "absent"}}
	egress := &proofLossRecoveryEgressStub{attachment: ports.NetworkAttachment{AgentID: agentID, TunnelIPv4: "10.0.0.2", ResolverIPv4: "10.0.0.3", EgressIPv4: "10.0.0.4", EgressPort: 8080, PacketContractRevision: 1, State: ports.NetworkStateActive, NetworkResourceVersion: 1, AttachmentState: ports.NetworkAttachmentClosed, AttachmentResourceVersion: 2}}
	input := LegacyProofLossRecoveryInput{RequestID: "recover-1", OrganizationID: store.agent.OrganizationID, ActorPrincipalID: "admin-1", AgentID: agentID, FailedMigrationRequestID: "failed-1"}
	return NewLegacyProofLossRecoveryService(store, runtime, egress, fixedClock{now: time.Unix(100, 0).UTC()}), store, runtime, egress, input
}

func TestLegacyProofLossRecoveryUsesExactTargetAndOneDurableStepPerCall(t *testing.T) {
	service, store, runtime, _, input := proofLossRecoveryFixture()
	ctx := context.Background()
	record, err := service.Admit(ctx, input)
	if err != nil || record.Phase != "disable_runtime" || store.beginCalls != 1 || runtime.disableCalls != 0 {
		t.Fatalf("admit=%+v begin=%d disable=%d err=%v", record, store.beginCalls, runtime.disableCalls, err)
	}
	if _, err := service.Admit(ctx, input); err != nil || store.beginCalls != 1 || runtime.inspectCalls != 1 {
		t.Fatalf("replay reinvestigated target: begin=%d inspect=%d err=%v", store.beginCalls, runtime.inspectCalls, err)
	}
	if replayed, found, err := service.Replay(ctx, input); err != nil || !found || replayed.RequestID != input.RequestID {
		t.Fatalf("durable replay=%+v found=%t err=%v", replayed, found, err)
	}
	record, err = service.Advance(ctx, input.RequestID)
	if err != nil || record.Phase != "publish" || runtime.childID != store.record.ChildRequestID || runtime.targetRevision != store.failed.RuntimeResult.RuntimeRevision || store.publishCalls != 0 {
		t.Fatalf("disable=%+v child=%q target=%q publish=%d err=%v", record, runtime.childID, runtime.targetRevision, store.publishCalls, err)
	}
	record, err = service.Advance(ctx, input.RequestID)
	if err != nil || record.State != "completed" || store.publishCalls != 1 || runtime.disableCalls != 1 {
		t.Fatalf("publish=%+v publish=%d disable=%d err=%v", record, store.publishCalls, runtime.disableCalls, err)
	}
	if _, err := service.Advance(ctx, input.RequestID); err != nil || store.publishCalls != 1 {
		t.Fatalf("completed replay repeated publish: %d %v", store.publishCalls, err)
	}
}

func TestLegacyProofLossRecoveryRejectsMismatchedTargetBeforeEffects(t *testing.T) {
	service, store, runtime, _, input := proofLossRecoveryFixture()
	runtime.inspection.RuntimeRevision = "rtv_" + strings.Repeat("f", 32)
	if _, err := service.Admit(context.Background(), input); !errors.Is(err, ErrLegacyMigrationManualRecoveryRequired) || store.beginCalls != 0 || runtime.disableCalls != 0 {
		t.Fatalf("mismatched target admitted: begin=%d disable=%d err=%v", store.beginCalls, runtime.disableCalls, err)
	}
}

func TestLegacyProofLossRecoveryRejectsCompetingActiveOperationAsLifecycleConflict(t *testing.T) {
	service, store, runtime, _, input := proofLossRecoveryFixture()
	store.agent.ActiveOperationRequestID = "another-recovery"
	if _, err := service.Admit(context.Background(), input); !errors.Is(err, ErrLifecycleConflict) || store.beginCalls != 0 || runtime.disableCalls != 0 {
		t.Fatalf("competing recovery result: begin=%d disable=%d err=%v", store.beginCalls, runtime.disableCalls, err)
	}
}

func TestLegacyProofLossRecoveryWaitsForMatchingTargetProcessObservation(t *testing.T) {
	service, store, runtime, _, input := proofLossRecoveryFixture()
	runtime.inspection.RuntimeExecutionID = ""
	runtime.inspection.Health = "starting"
	if _, err := service.Admit(context.Background(), input); !errors.Is(err, ErrDependencyUnavailable) || store.beginCalls != 0 || runtime.disableCalls != 0 {
		t.Fatalf("starting target marked manual or admitted: begin=%d disable=%d err=%v", store.beginCalls, runtime.disableCalls, err)
	}
	runtime.inspection.RuntimeExecutionID = "process-ready"
	if _, err := service.Admit(context.Background(), input); err != nil || store.beginCalls != 1 {
		t.Fatalf("ready target not admitted: begin=%d err=%v", store.beginCalls, err)
	}
}

func TestLegacyProofLossRecoveryKeepsJournalRunningUntilExactDisableReceipt(t *testing.T) {
	service, store, runtime, _, input := proofLossRecoveryFixture()
	if _, err := service.Admit(context.Background(), input); err != nil {
		t.Fatal(err)
	}
	runtime.result = ports.RuntimeOperation{State: "running"}
	record, err := service.Advance(context.Background(), input.RequestID)
	if err != nil || record.Phase != "disable_runtime" || store.recordCalls != 0 {
		t.Fatalf("running RC effect advanced journal: record=%+v writes=%d err=%v", record, store.recordCalls, err)
	}
	childID := runtime.childID
	runtime.result = ports.RuntimeOperation{State: "failed", Effect: "unknown"}
	record, err = service.Advance(context.Background(), input.RequestID)
	if !errors.Is(err, ErrDependencyUnavailable) || record.Phase != "disable_runtime" || store.recordCalls != 0 || store.manualCalls != 0 || runtime.childID != childID {
		t.Fatalf("unknown RC effect settled journal: record=%+v writes=%d manual=%d err=%v", record, store.recordCalls, store.manualCalls, err)
	}
	runtime.result = ports.RuntimeOperation{State: "completed", Effect: "completed", LifecycleState: "disabled", Health: "absent"}
	if _, err := service.Advance(context.Background(), input.RequestID); !errors.Is(err, ErrDependencyUnavailable) || store.recordCalls != 0 || runtime.childID != childID {
		t.Fatalf("unproven RC receipt advanced journal: writes=%d err=%v", store.recordCalls, err)
	}
}

func TestLegacyProofLossRecoveryRequiresClosedEgressAtAdmission(t *testing.T) {
	service, store, runtime, egress, input := proofLossRecoveryFixture()
	egress.attachment.AttachmentState = ports.NetworkAttachmentOpen
	if _, err := service.Admit(context.Background(), input); !errors.Is(err, ErrLegacyMigrationManualRecoveryRequired) || store.beginCalls != 0 || runtime.disableCalls != 0 {
		t.Fatalf("open Egress admitted: begin=%d disable=%d err=%v", store.beginCalls, runtime.disableCalls, err)
	}
}

func TestLegacyProofLossRecoveryPersistsDefinitiveManualOutcome(t *testing.T) {
	for _, scenario := range []struct {
		name, phase, reason string
		change              func(*proofLossRecoveryRuntimeStub, *proofLossRecoveryEgressStub)
	}{
		{"RC rejection", "disable_runtime", "runtime_disable_rejected", func(runtime *proofLossRecoveryRuntimeStub, _ *proofLossRecoveryEgressStub) {
			runtime.result = ports.RuntimeOperation{State: "failed", Effect: "none", ErrorCode: "runtime_not_found"}
		}},
		{"Egress drift", "publish", "network_attachment_changed", func(_ *proofLossRecoveryRuntimeStub, egress *proofLossRecoveryEgressStub) {
			egress.attachment.AttachmentResourceVersion++
		}},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			service, store, runtime, egress, input := proofLossRecoveryFixture()
			if _, err := service.Admit(context.Background(), input); err != nil {
				t.Fatal(err)
			}
			if scenario.phase == "publish" {
				if _, err := service.Advance(context.Background(), input.RequestID); err != nil {
					t.Fatal(err)
				}
			}
			scenario.change(runtime, egress)
			record, err := service.Advance(context.Background(), input.RequestID)
			if err != nil || record.State != "manual_recovery_required" || record.ManualReason != scenario.reason || store.manualCalls != 1 || store.publishCalls != 0 {
				t.Fatalf("manual outcome=%+v calls=%d publish=%d err=%v", record, store.manualCalls, store.publishCalls, err)
			}
			if replayed, found, err := service.Replay(context.Background(), input); err != nil || !found || replayed.State != "manual_recovery_required" {
				t.Fatalf("manual replay=%+v found=%t err=%v", replayed, found, err)
			}
		})
	}
}
