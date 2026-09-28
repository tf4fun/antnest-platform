package postgres

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestBoundLegacyEnableFreezesNewTargetWithoutOpeningNetwork(t *testing.T) {
	url := os.Getenv("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	repository, err := Open(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(repository.Close)
	available, seed := seedAvailableAgentForRebuild(t, ctx, repository)
	disabled := seedDisabledAgentForEnable(t, ctx, repository, available)
	base, err := repository.GetAgentEnableBase(ctx, disabled.AgentID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repository.pool.Exec(ctx, `INSERT INTO agent_controller.legacy_system_skills_migrations(agent_id,organization_id,state) VALUES($1,$2,'pending')`, disabled.AgentID, disabled.OrganizationID); err != nil {
		t.Fatal(err)
	}
	choice, err := repository.RecordLegacySkillChoice(ctx, ports.LegacySkillChoice{RequestID: "disabled-choice", Fingerprint: strings.Repeat("a", 64),
		AgentID: disabled.AgentID, OrganizationID: disabled.OrganizationID, ActorPrincipalID: "admin-1", Kind: "empty",
		VolumeName: "legacy-volume", InventoryDigest: "sha256:" + strings.Repeat("b", 64), BackupRef: "backup-1",
		BackupDigest: "sha256:" + strings.Repeat("c", 64), CreatedAt: time.Now().UTC()})
	if err != nil {
		t.Fatal(err)
	}
	public, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	if err := repository.ReconcileLegacyVerifierKeys(ctx, map[string]ed25519.PublicKey{"disabled-key": public}); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Microsecond)
	// The independent Linux verifier emits nanosecond RFC3339 timestamps while
	// PostgreSQL stores timestamp values at microsecond precision.
	expires := now.Add(time.Hour).Add(123 * time.Nanosecond)
	proof := []byte(`{"version":1,"key_id":"disabled-key","expires_at":"` + expires.Format(time.RFC3339Nano) + `"}`)
	proofHash := sha256.Sum256(proof)
	target := catalogRebuildInput(t, available, seed.Revision, seed.Model.Revision).TargetSpec
	target.Snapshot = base.Spec.Snapshot
	target.Snapshot.SystemSkills = nil
	target.Snapshot.SkillSetDigest, err = domain.SkillSetDigest(disabled.OrganizationID, nil)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(target.Snapshot)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(encoded)
	target.CanonicalDigest = hex.EncodeToString(digest[:])
	requestID := "disabled-migration-enable"
	fingerprint := strings.Repeat("d", 64)
	intent, err := repository.ReserveSkillPreparation(ctx, ports.SkillPreparationIntent{RequestID: requestID, RequestFingerprint: fingerprint,
		Kind: domain.OperationEnable, AgentID: disabled.AgentID, OrganizationID: disabled.OrganizationID,
		TargetSpec: target.Snapshot, TargetSpecDigest: target.CanonicalDigest, ExpectedAggregateSequence: disabled.AggregateSequence,
		ExpectedSpecRevisionID: base.Spec.ID, ExpectedExecutionRevisionID: base.LastSuccessfulExecution.ID,
		ExpectedRuntimeRevision: disabled.RuntimeRevision, CreatedAt: now, UpdatedAt: now})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repository.MarkSkillPreparationReady(ctx, requestID, fingerprint, "psr_"+strings.Repeat("e", 32), now); err != nil {
		t.Fatal(err)
	}
	begin := ports.BeginAgentEnable{AgentID: disabled.AgentID, ExpectedAggregateSequence: disabled.AggregateSequence,
		ExpectedSpecRevisionID: base.Spec.ID, ExpectedExecutionRevisionID: base.LastSuccessfulExecution.ID,
		ExpectedRuntimeRevision: disabled.RuntimeRevision, TargetSpec: &target,
		LegacyMigration: &ports.LegacySkillMigrationBinding{ChoiceRequestID: choice.RequestID, ChoiceSequence: choice.Sequence,
			KeyID: "disabled-key", Attestation: proof, AttestationDigest: hex.EncodeToString(proofHash[:]), ExpiresAt: expires},
		Operation: ports.LifecycleOperationRecord{RequestID: requestID, RequestFingerprint: fingerprint, AgentID: disabled.AgentID,
			Kind: domain.OperationEnable, Phase: domain.PhaseNetworkEnsure, State: domain.OperationRunning,
			SourceSpecRevisionID: base.Spec.ID, SourceExecutionRevisionID: base.LastSuccessfulExecution.ID,
			SourceRuntimeRevision: disabled.RuntimeRevision, TargetSpecRevisionID: target.ID,
			ChildRequestID: domain.ChildRequestID(requestID, domain.PhaseNetworkEnsure), CreatedAt: now, UpdatedAt: now},
		RequestedEvent: ports.AgentEventRecord{EventID: "disabled-migration-event", AgentID: disabled.AgentID,
			AggregateSequence: disabled.AggregateSequence + 1, SchemaVersion: 1, EventType: ports.EventAgentEnableRequested,
			OperationRequestID: requestID, Data: map[string]any{}, OccurredAt: now}, Now: now}
	wrong := begin
	wrongTarget := *begin.TargetSpec
	wrongTarget.Snapshot.SystemPrompt = "unapproved change"
	wrong.TargetSpec = &wrongTarget
	if _, _, err := repository.BeginAgentEnable(ctx, wrong); !errors.Is(err, ports.ErrConcurrentChange) {
		t.Fatalf("mismatched migration target entered Enable: %v", err)
	}
	started, replayed, err := repository.BeginAgentEnable(ctx, begin)
	if err != nil || replayed || started.Spec.ID != target.ID || started.LegacyMigration == nil ||
		started.Agent.ActivationState != domain.ActivationDisabled || intent.State != "preparing" {
		t.Fatalf("bound Enable state=%+v replay=%t err=%v", started, replayed, err)
	}
	attachment := *closedNetworkAttachment(disabled.AgentID)
	if _, err := repository.AdvanceAgentEnable(ctx, ports.AdvanceAgentEnable{RequestID: requestID, Fingerprint: fingerprint,
		ExpectedPhase: domain.PhaseNetworkEnsure, NextPhase: domain.PhaseRuntimeEnable,
		NextChildRequestID: domain.ChildRequestID(requestID, domain.PhaseRuntimeEnable),
		NetworkAttachment:  &attachment, Now: now.Add(time.Second)}); err != nil {
		t.Fatal(err)
	}
	runtime := ports.RuntimeOperation{State: "completed", Effect: "completed", RuntimeRevision: "rtv_55555555555555555555555555555555",
		LifecycleState: "provisioned", Health: "unknown"}
	if _, err := repository.AdvanceAgentEnable(ctx, ports.AdvanceAgentEnable{RequestID: requestID, Fingerprint: fingerprint,
		ExpectedPhase: domain.PhaseRuntimeEnable, NextPhase: domain.PhaseNetworkRestore,
		NextChildRequestID: domain.ChildRequestID(requestID, domain.PhaseNetworkRestore),
		RuntimeResult:      &runtime, Now: now.Add(2 * time.Second)}); err != nil {
		t.Fatal(err)
	}
	attachment.AttachmentState = ports.NetworkAttachmentOpen
	attachment.AttachmentResourceVersion++
	if _, err := repository.AdvanceAgentEnable(ctx, ports.AdvanceAgentEnable{RequestID: requestID, Fingerprint: fingerprint,
		ExpectedPhase: domain.PhaseNetworkRestore, NextPhase: domain.PhasePublish,
		NextChildRequestID: domain.ChildRequestID(requestID, domain.PhasePublish),
		NetworkAttachment:  &attachment, Now: now.Add(3 * time.Second)}); err != nil {
		t.Fatal(err)
	}
	publish := ports.PublishAgentEnable{RequestID: requestID, Fingerprint: fingerprint,
		EnabledEvent: ports.AgentEventRecord{EventID: "disabled-migration-enabled-event", AgentID: disabled.AgentID,
			AggregateSequence: begin.RequestedEvent.AggregateSequence + 1, SchemaVersion: 1, EventType: ports.EventAgentEnabled,
			OperationRequestID: requestID, Data: map[string]any{}, OccurredAt: now.Add(4 * time.Second)}, Now: now.Add(4 * time.Second)}
	if _, err := repository.PublishAgentEnable(ctx, publish); !errors.Is(err, ports.ErrConcurrentChange) {
		t.Fatalf("bound Enable published without mount verification: %v", err)
	}
	publish.LegacyVerification = &ports.LegacySkillPublishVerification{PreparedReferenceID: "psr_" + strings.Repeat("e", 32),
		Receipt: ports.ActiveSkillSetVerificationReceipt{AgentID: disabled.AgentID, RuntimeRevision: runtime.RuntimeRevision,
			SkillSetDigest: target.Snapshot.SkillSetDigest, LayoutVersion: domain.SkillLayoutVersion,
			ManifestDigest: "sha256:" + strings.Repeat("f", 64), VerifiedAt: publish.Now}}
	published, err := repository.PublishAgentEnable(ctx, publish)
	if err != nil || published.Spec.ID != target.ID || published.Agent.AgentSpecRevisionID != target.ID {
		t.Fatalf("verified Enable publish state=%+v err=%v", published, err)
	}
	if pending, err := repository.LegacySystemSkillsMigrationRequired(ctx, disabled.AgentID); err != nil || pending {
		t.Fatalf("verified Enable did not resolve marker: pending=%t err=%v", pending, err)
	}
}

func TestPendingLegacySkillsCannotEnterOrdinaryEnableAtRepository(t *testing.T) {
	url := os.Getenv("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	repository, err := Open(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(repository.Close)
	available, _ := seedAvailableAgentForRebuild(t, ctx, repository)
	disabled := seedDisabledAgentForEnable(t, ctx, repository, available)
	base, err := repository.GetAgentEnableBase(ctx, disabled.AgentID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repository.pool.Exec(ctx, `INSERT INTO agent_controller.legacy_system_skills_migrations(agent_id,organization_id,state) VALUES($1,$2,'pending')`, disabled.AgentID, disabled.OrganizationID); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	requestID := "legacy-ordinary-enable"
	begin := ports.BeginAgentEnable{
		AgentID: disabled.AgentID, ExpectedAggregateSequence: disabled.AggregateSequence,
		ExpectedSpecRevisionID: base.Spec.ID, ExpectedExecutionRevisionID: base.LastSuccessfulExecution.ID,
		ExpectedRuntimeRevision: disabled.RuntimeRevision,
		Operation: ports.LifecycleOperationRecord{
			RequestID: requestID, RequestFingerprint: strings.Repeat("a", 64), AgentID: disabled.AgentID,
			Kind: domain.OperationEnable, Phase: domain.PhaseNetworkEnsure, State: domain.OperationRunning,
			SourceSpecRevisionID: base.Spec.ID, SourceExecutionRevisionID: base.LastSuccessfulExecution.ID,
			SourceRuntimeRevision: disabled.RuntimeRevision, TargetSpecRevisionID: base.Spec.ID,
			ChildRequestID: domain.ChildRequestID(requestID, domain.PhaseNetworkEnsure), CreatedAt: now, UpdatedAt: now},
		RequestedEvent: ports.AgentEventRecord{EventID: "legacy-ordinary-enable-event", AgentID: disabled.AgentID,
			AggregateSequence: disabled.AggregateSequence + 1, SchemaVersion: 1, EventType: ports.EventAgentEnableRequested,
			OperationRequestID: requestID, Data: map[string]any{}, OccurredAt: now}, Now: now,
	}
	if _, _, err := repository.BeginAgentEnable(ctx, begin); !errors.Is(err, ports.ErrConcurrentChange) {
		t.Fatalf("ordinary Enable bypassed pending legacy marker: %v", err)
	}
	if pending, err := repository.LegacySystemSkillsMigrationRequired(ctx, disabled.AgentID); err != nil || !pending {
		t.Fatalf("marker changed after rejected Enable: pending=%t err=%v", pending, err)
	}
	if _, err := repository.GetLifecycleOperation(ctx, requestID); !errors.Is(err, ports.ErrNotFound) {
		t.Fatalf("rejected Enable left operation: %v", err)
	}
}
