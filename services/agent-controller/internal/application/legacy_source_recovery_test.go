package application

import (
	"context"
	"errors"
	"testing"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

type sourceRecoveryStoreStub struct {
	agent                                                                        ports.AgentRecord
	marker                                                                       ports.LegacySkillMigrationRecord
	record                                                                       ports.LegacySourceRecoveryRecord
	beginCalls, drainCalls, fenceCalls, disabledCalls, publishCalls, manualCalls int
}

func (s *sourceRecoveryStoreStub) GetAgent(context.Context, string) (ports.AgentRecord, error) {
	return s.agent, nil
}
func (s *sourceRecoveryStoreStub) GetLegacySkillMigration(context.Context, string, string) (ports.LegacySkillMigrationRecord, error) {
	return s.marker, nil
}
func (s *sourceRecoveryStoreStub) GetLegacySourceRecovery(context.Context, string) (ports.LegacySourceRecoveryRecord, error) {
	if s.record.RequestID == "" {
		return ports.LegacySourceRecoveryRecord{}, ports.ErrNotFound
	}
	return s.record, nil
}
func (s *sourceRecoveryStoreStub) BeginLegacySourceRecovery(_ context.Context, in ports.BeginLegacySourceRecovery) (ports.LegacySourceRecoveryRecord, bool, error) {
	s.beginCalls++
	s.record = ports.LegacySourceRecoveryRecord{RequestID: in.RequestID, Fingerprint: in.Fingerprint, AgentID: in.AgentID,
		OrganizationID: in.OrganizationID, ActorPrincipalID: in.ActorPrincipalID, SourceSpecRevisionID: in.SourceSpecRevisionID,
		SourceRuntimeRevision: in.SourceRuntimeRevision, ObservedRuntimeExecutionID: in.ObservedRuntimeExecutionID,
		ObservedAttachmentVersion: in.ObservedAttachmentVersion, ChildRequestID: in.ChildRequestID,
		DrainDeadlineAt: in.DrainDeadlineAt, State: "running", Phase: "drain"}
	return s.record, false, nil
}
func (s *sourceRecoveryStoreStub) CompleteLegacySourceDrain(context.Context, string, string, time.Time) (ports.LegacySourceRecoveryRecord, error) {
	s.drainCalls++
	s.record.Phase = "network_fence"
	return s.record, nil
}
func (s *sourceRecoveryStoreStub) RecordLegacySourceFence(_ context.Context, _, _ string, version uint64, _ time.Time) (ports.LegacySourceRecoveryRecord, error) {
	s.fenceCalls++
	s.record.ClosedAttachmentVersion = version
	s.record.Phase = "disable_runtime"
	return s.record, nil
}
func (s *sourceRecoveryStoreStub) RecordLegacySourceRuntimeDisabled(_ context.Context, _, _, child string, result ports.RuntimeOperation, _ time.Time) (ports.LegacySourceRecoveryRecord, error) {
	if child != s.record.ChildRequestID {
		return ports.LegacySourceRecoveryRecord{}, ports.ErrConcurrentChange
	}
	s.disabledCalls++
	s.record.DisabledRuntimeResult = &result
	s.record.DisabledRuntimeRevision = result.RuntimeRevision
	s.record.Phase = "publish"
	return s.record, nil
}
func (s *sourceRecoveryStoreStub) PublishLegacySourceRecovery(_ context.Context, _, _ string, version uint64, _, _ string, _ time.Time) (ports.LegacySourceRecoveryRecord, error) {
	if version != s.record.ClosedAttachmentVersion {
		return ports.LegacySourceRecoveryRecord{}, ports.ErrConcurrentChange
	}
	s.publishCalls++
	s.record.State, s.record.Phase = "completed", "done"
	return s.record, nil
}
func (s *sourceRecoveryStoreStub) MarkLegacySourceManualRecovery(_ context.Context, _, _, phase, reason string, _ time.Time) (ports.LegacySourceRecoveryRecord, error) {
	s.manualCalls++
	s.record.State = "manual_recovery_required"
	s.record.Phase = phase
	s.record.ManualReason = reason
	return s.record, nil
}

type sourceRecoveryEgressStub struct {
	attachment ports.NetworkAttachment
	closeCalls int
	closeErr   error
}

func (s *sourceRecoveryEgressStub) GetAgentNetwork(context.Context, string) (ports.NetworkAttachment, error) {
	return s.attachment, nil
}
func (s *sourceRecoveryEgressStub) SetAgentNetworkAttachment(_ context.Context, _ string, state string, version uint64) (ports.NetworkAttachment, error) {
	if s.closeErr != nil {
		return ports.NetworkAttachment{}, s.closeErr
	}
	if state != ports.NetworkAttachmentClosed || version != s.attachment.AttachmentResourceVersion {
		return ports.NetworkAttachment{}, ports.ErrConcurrentChange
	}
	s.closeCalls++
	s.attachment.AttachmentState = state
	s.attachment.AttachmentResourceVersion++
	return s.attachment, nil
}

func TestLegacySourceRecoveryDefinitiveDisableRejectionStaysFenced(t *testing.T) {
	svc, store, runtime, egress, _, input := sourceRecoveryFixture()
	ctx := context.Background()
	if _, err := svc.Admit(ctx, input); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if _, err := svc.Advance(ctx, input.RequestID); err != nil {
			t.Fatal(err)
		}
	}
	runtime.result = ports.RuntimeOperation{State: "failed", Effect: "not_started", ErrorCode: "source_mismatch"}
	record, err := svc.Advance(ctx, input.RequestID)
	if err != nil || record.State != "manual_recovery_required" || record.ManualReason != "runtime_disable_rejected" ||
		store.publishCalls != 0 || egress.attachment.AttachmentState != ports.NetworkAttachmentClosed {
		t.Fatalf("rejected disable=%+v err=%v", record, err)
	}
}

func TestLegacySourceRecoveryDefinitiveDisableHTTPRejectionStaysFenced(t *testing.T) {
	svc, store, runtime, egress, _, input := sourceRecoveryFixture()
	ctx := context.Background()
	if _, err := svc.Admit(ctx, input); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if _, err := svc.Advance(ctx, input.RequestID); err != nil {
			t.Fatal(err)
		}
	}
	runtime.disableErr = &ports.DependencyError{Service: "runtime-controller", Code: "runtime_revision_conflict", Retryable: false}
	record, err := svc.Advance(ctx, input.RequestID)
	if err != nil || record.State != "manual_recovery_required" || record.ManualReason != "runtime_disable_rejected" ||
		store.publishCalls != 0 || egress.attachment.AttachmentState != ports.NetworkAttachmentClosed {
		t.Fatalf("rejected disable=%+v err=%v", record, err)
	}
}

func TestLegacySourceRecoveryUnknownNetworkCASStaysAtFenceUntilClosure(t *testing.T) {
	svc, store, _, egress, _, input := sourceRecoveryFixture()
	ctx := context.Background()
	if _, err := svc.Admit(ctx, input); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Advance(ctx, input.RequestID); err != nil {
		t.Fatal(err)
	}
	egress.closeErr = &ports.DependencyError{Service: "runtime-egress", Code: "resource_version_conflict", Retryable: false}
	record, err := svc.Advance(ctx, input.RequestID)
	if !errors.Is(err, ErrDependencyUnavailable) || record.State != "running" || record.Phase != "network_fence" || store.fenceCalls != 0 {
		t.Fatalf("changed CAS=%+v err=%v", record, err)
	}
	egress.closeErr = nil
	egress.attachment.AttachmentResourceVersion++
	record, err = svc.Advance(ctx, input.RequestID)
	if err != nil || record.State != "manual_recovery_required" || egress.attachment.AttachmentState != ports.NetworkAttachmentClosed {
		t.Fatalf("changed attachment not refenced: %+v err=%v", record, err)
	}
}

type sourceRecoveryExecutionStub struct {
	calls   int
	result  string
	request ports.LifecycleSettlementRequest
}

func (s *sourceRecoveryExecutionStub) CloseAndSettle(_ context.Context, request ports.LifecycleSettlementRequest) (ports.AgentSettlementResult, error) {
	s.calls++
	s.request = request
	return ports.AgentSettlementResult{Outcome: s.result}, nil
}

func sourceRecoveryFixture() (*LegacySourceRecoveryService, *sourceRecoveryStoreStub, *proofLossRecoveryRuntimeStub, *sourceRecoveryEgressStub, *sourceRecoveryExecutionStub, LegacySourceRecoveryInput) {
	const agentID = "agent_11111111111111111111111111111111"
	const orgID = "org_11111111111111111111111111111111"
	const revision = "rtv_22222222222222222222222222222222"
	store := &sourceRecoveryStoreStub{agent: ports.AgentRecord{AgentID: agentID, OrganizationID: orgID,
		AgentSpecRevisionID: "agentspec_11111111111111111111111111111111", RuntimeRevision: revision,
		LifecycleState: domain.AgentCreated, DesiredState: domain.DesiredEnabled, ActivationState: domain.ActivationEnabled, AggregateSequence: 4},
		marker: ports.LegacySkillMigrationRecord{AgentID: agentID, OrganizationID: orgID, State: "pending"}}
	runtime := &proofLossRecoveryRuntimeStub{inspection: ports.RuntimeInspection{AgentID: agentID, RuntimeRevision: revision,
		RuntimeExecutionID: "process-1", Phase: "running", LifecycleState: "provisioned"},
		result: ports.RuntimeOperation{State: "completed", Effect: "completed", RuntimeRevision: "rtv_33333333333333333333333333333333", LifecycleState: "disabled", Health: "absent"}}
	egress := &sourceRecoveryEgressStub{attachment: ports.NetworkAttachment{AgentID: agentID, TunnelIPv4: "10.0.0.2", ResolverIPv4: "10.0.0.3", EgressIPv4: "10.0.0.4", EgressPort: 8080,
		PacketContractRevision: 1, State: ports.NetworkStateActive, NetworkResourceVersion: 1, AttachmentState: ports.NetworkAttachmentOpen, AttachmentResourceVersion: 2}}
	execution := &sourceRecoveryExecutionStub{result: ports.ExecutionSettled}
	service := NewLegacySourceRecoveryService(store, runtime, egress, execution, fixedClock{now: time.Unix(100, 0).UTC()}, 5*time.Minute)
	return service, store, runtime, egress, execution, LegacySourceRecoveryInput{RequestID: "recover-1", AgentID: agentID, OrganizationID: orgID, ActorPrincipalID: "admin-1"}
}

func TestLegacySourceRecoveryAdvancesOneDurableStagePerCall(t *testing.T) {
	svc, store, runtime, egress, execution, input := sourceRecoveryFixture()
	ctx := context.Background()
	record, err := svc.Admit(ctx, input)
	if err != nil || record.Phase != "drain" || store.beginCalls != 1 || execution.calls != 0 {
		t.Fatalf("admit=%+v err=%v", record, err)
	}
	if _, err = svc.Admit(ctx, input); err != nil || store.beginCalls != 1 || runtime.inspectCalls != 1 {
		t.Fatalf("replay begin=%d inspect=%d err=%v", store.beginCalls, runtime.inspectCalls, err)
	}
	for _, phase := range []string{"network_fence", "disable_runtime", "publish", "done"} {
		record, err = svc.Advance(ctx, input.RequestID)
		if err != nil || record.Phase != phase {
			t.Fatalf("want %s got %+v err=%v", phase, record, err)
		}
	}
	if record.State != "completed" || execution.request.Mode != "wait" || execution.request.OperationID != input.RequestID ||
		egress.closeCalls != 1 || runtime.disableCalls != 1 || runtime.childID != record.ChildRequestID || runtime.targetRevision != store.agent.RuntimeRevision || store.publishCalls != 1 {
		t.Fatalf("effects record=%+v execution=%+v egress=%d runtime=%d publish=%d", record, execution.request, egress.closeCalls, runtime.disableCalls, store.publishCalls)
	}
	if _, err := svc.Advance(ctx, input.RequestID); err != nil || store.publishCalls != 1 {
		t.Fatalf("completed replay: %v", err)
	}
}

func TestLegacySourceRecoveryRejectsWrongRuntimeBeforeEffects(t *testing.T) {
	svc, store, runtime, _, _, input := sourceRecoveryFixture()
	runtime.inspection.RuntimeRevision = "rtv_44444444444444444444444444444444"
	if _, err := svc.Admit(context.Background(), input); !errors.Is(err, ErrLegacySourceManualRecoveryRequired) || store.beginCalls != 0 {
		t.Fatalf("wrong Runtime admitted: %v", err)
	}
}

func TestLegacySourceRecoveryMissingRuntimeRequiresManualBeforeEffects(t *testing.T) {
	svc, store, runtime, _, _, input := sourceRecoveryFixture()
	runtime.inspectErr = &ports.DependencyError{Service: "runtime-controller", Code: "runtime_not_found", Retryable: false}
	if _, err := svc.Admit(context.Background(), input); !errors.Is(err, ErrLegacySourceManualRecoveryRequired) || store.beginCalls != 0 {
		t.Fatalf("missing Runtime admitted: %v", err)
	}
}

func TestLegacySourceRecoveryUnknownDisableRetainsChildAndFence(t *testing.T) {
	svc, store, runtime, egress, _, input := sourceRecoveryFixture()
	ctx := context.Background()
	if _, err := svc.Admit(ctx, input); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if _, err := svc.Advance(ctx, input.RequestID); err != nil {
			t.Fatal(err)
		}
	}
	runtime.result = ports.RuntimeOperation{State: "failed", Effect: "unknown"}
	for range 2 {
		record, err := svc.Advance(ctx, input.RequestID)
		if !errors.Is(err, ErrDependencyUnavailable) || record.Phase != "disable_runtime" || store.disabledCalls != 0 || store.manualCalls != 0 || egress.attachment.AttachmentState != ports.NetworkAttachmentClosed {
			t.Fatalf("unknown effect advanced or reopened: %+v err=%v", record, err)
		}
	}
	if runtime.disableCalls != 2 || runtime.childID != store.record.ChildRequestID {
		t.Fatalf("child replay mismatch: %+v", runtime)
	}
}

func TestLegacySourceRecoveryWaitsForActiveRunBeforeFencing(t *testing.T) {
	svc, store, runtime, egress, execution, input := sourceRecoveryFixture()
	ctx := context.Background()
	if _, err := svc.Admit(ctx, input); err != nil {
		t.Fatal(err)
	}
	execution.result = ports.ExecutionNotSettled
	record, err := svc.Advance(ctx, input.RequestID)
	if err != nil || record.Phase != "drain" || egress.closeCalls != 0 || runtime.disableCalls != 0 || store.drainCalls != 0 {
		t.Fatalf("active Run was fenced: %+v err=%v", record, err)
	}
	execution.result = ports.ExecutionSettled
	record, err = svc.Advance(ctx, input.RequestID)
	if err != nil || record.Phase != "network_fence" || store.drainCalls != 1 {
		t.Fatalf("settled Run did not advance: %+v err=%v", record, err)
	}
}

func TestLegacySourceRecoveryChangedEgressRequiresManualAfterDisable(t *testing.T) {
	svc, store, _, egress, _, input := sourceRecoveryFixture()
	ctx := context.Background()
	if _, err := svc.Admit(ctx, input); err != nil {
		t.Fatal(err)
	}
	for range 3 {
		if _, err := svc.Advance(ctx, input.RequestID); err != nil {
			t.Fatal(err)
		}
	}
	egress.attachment.AttachmentResourceVersion++
	record, err := svc.Advance(ctx, input.RequestID)
	if err != nil || record.State != "manual_recovery_required" || record.ManualReason != "network_attachment_changed" || store.publishCalls != 0 {
		t.Fatalf("changed Egress published: %+v err=%v", record, err)
	}
}

func TestLegacySourceRecoveryReclosesExternallyOpenedEgressBeforeManualPublication(t *testing.T) {
	svc, store, _, egress, _, input := sourceRecoveryFixture()
	ctx := context.Background()
	if _, err := svc.Admit(ctx, input); err != nil {
		t.Fatal(err)
	}
	for range 3 {
		if _, err := svc.Advance(ctx, input.RequestID); err != nil {
			t.Fatal(err)
		}
	}
	egress.attachment.AttachmentState = ports.NetworkAttachmentOpen
	egress.attachment.AttachmentResourceVersion++
	record, err := svc.Advance(ctx, input.RequestID)
	if err != nil || record.State != "manual_recovery_required" || record.ManualReason != "network_attachment_changed" ||
		egress.attachment.AttachmentState != ports.NetworkAttachmentClosed || egress.closeCalls != 2 || store.publishCalls != 0 {
		t.Fatalf("opened Egress left unsafe: %+v attachment=%+v close=%d err=%v", record, egress.attachment, egress.closeCalls, err)
	}
}

func TestLegacySourceRecoveryReclosesDriftedEgressBeforeManualFence(t *testing.T) {
	svc, store, runtime, egress, _, input := sourceRecoveryFixture()
	ctx := context.Background()
	if _, err := svc.Admit(ctx, input); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Advance(ctx, input.RequestID); err != nil {
		t.Fatal(err)
	}
	egress.attachment.AttachmentResourceVersion++
	record, err := svc.Advance(ctx, input.RequestID)
	if err != nil || record.State != "manual_recovery_required" || record.ManualReason != "network_attachment_changed" ||
		egress.attachment.AttachmentState != ports.NetworkAttachmentClosed || egress.closeCalls != 1 || runtime.disableCalls != 0 || store.fenceCalls != 0 {
		t.Fatalf("drifted Egress left unsafe: %+v attachment=%+v err=%v", record, egress.attachment, err)
	}
}
