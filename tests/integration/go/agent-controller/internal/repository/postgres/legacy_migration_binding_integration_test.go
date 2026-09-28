package postgres

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestLegacyMigrationBindingIsAtomicWithRebuildAndFreezesChoice(t *testing.T) {
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
	base, seed := seedAvailableAgentForRebuild(t, ctx, repository)
	if _, err := repository.pool.Exec(ctx, `INSERT INTO agent_controller.legacy_system_skills_migrations(agent_id,organization_id,state) VALUES($1,$2,'pending')`, base.Agent.AgentID, base.Agent.OrganizationID); err != nil {
		t.Fatal(err)
	}
	choice := ports.LegacySkillChoice{RequestID: "legacy-binding-choice", Fingerprint: strings.Repeat("a", 64),
		AgentID: base.Agent.AgentID, OrganizationID: base.Agent.OrganizationID, ActorPrincipalID: "admin-1", Kind: "empty",
		VolumeName: "legacy-volume", InventoryDigest: "sha256:" + strings.Repeat("b", 64),
		BackupRef: "backup-1", BackupDigest: "sha256:" + strings.Repeat("c", 64), CreatedAt: time.Now().UTC()}
	choice, err = repository.RecordLegacySkillChoice(ctx, choice)
	if err != nil {
		t.Fatal(err)
	}
	begin := catalogRebuildInput(t, base, seed.Revision, seed.Model.Revision)
	if _, _, err := repository.BeginAgentRebuild(ctx, begin); !errors.Is(err, ports.ErrConcurrentChange) {
		t.Fatalf("ordinary rebuild bypassed legacy gate: %v", err)
	}
	public, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	if err := repository.ReconcileLegacyVerifierKeys(ctx, map[string]ed25519.PublicKey{"legacy-binding-key": public}); err != nil {
		t.Fatal(err)
	}
	expiresAt := time.Now().Add(time.Hour).UTC()
	proof := []byte(`{"version":1,"key_id":"legacy-binding-key","expires_at":"` + expiresAt.Format(time.RFC3339Nano) + `"}`)
	hash := sha256.Sum256(proof)
	begin.LegacyMigration = &ports.LegacySkillMigrationBinding{
		ChoiceRequestID: choice.RequestID, ChoiceSequence: choice.Sequence, KeyID: "legacy-binding-key",
		Attestation: proof, AttestationDigest: hex.EncodeToString(hash[:]), ExpiresAt: expiresAt,
	}
	intent, err := repository.ReserveSkillPreparation(ctx, ports.SkillPreparationIntent{
		RequestID: begin.Operation.RequestID, RequestFingerprint: begin.Operation.RequestFingerprint, Kind: domain.OperationRebuild,
		AgentID: begin.AgentID, OrganizationID: base.Agent.OrganizationID, TargetSpec: begin.TargetSpec.Snapshot,
		TargetSpecDigest: begin.TargetSpec.CanonicalDigest, ExpectedAggregateSequence: base.Agent.AggregateSequence,
		ExpectedSpecRevisionID: base.ConfiguredSpec.ID, ExpectedExecutionRevisionID: base.SourceExecution.ID,
		ExpectedRuntimeRevision: base.Agent.RuntimeRevision, CreatedAt: begin.Now, UpdatedAt: begin.Now,
	})
	if err != nil {
		t.Fatal(err)
	}
	referenceID := "psr_" + strings.Repeat("f", 32)
	if _, err := repository.MarkSkillPreparationReady(ctx, intent.RequestID, intent.RequestFingerprint, referenceID, begin.Now); err != nil {
		t.Fatal(err)
	}
	stale := begin
	copy := *begin.LegacyMigration
	copy.ChoiceSequence++
	stale.LegacyMigration = &copy
	if _, _, err := repository.BeginAgentRebuild(ctx, stale); !errors.Is(err, ports.ErrConcurrentChange) {
		t.Fatalf("stale choice admitted: %v", err)
	}
	started, replayed, err := repository.BeginAgentRebuild(ctx, begin)
	if err != nil || replayed || started.LegacyMigration == nil || started.LegacyMigration.ChoiceSequence != choice.Sequence {
		t.Fatalf("bound rebuild=%+v replay=%t err=%v", started.LegacyMigration, replayed, err)
	}
	choice.RequestID, choice.Fingerprint = "legacy-binding-choice-new", strings.Repeat("d", 64)
	if _, err := repository.RecordLegacySkillChoice(ctx, choice); !errors.Is(err, ports.ErrConcurrentChange) {
		t.Fatalf("choice changed after binding: %v", err)
	}
	if _, replayed, err := repository.BeginAgentRebuild(ctx, begin); err != nil || !replayed {
		t.Fatalf("bound replay=%t %v", replayed, err)
	}
	changed := begin
	copy = *begin.LegacyMigration
	copy.AttestationDigest = strings.Repeat("e", 64)
	changed.LegacyMigration = &copy
	if _, _, err := repository.BeginAgentRebuild(ctx, changed); !errors.Is(err, ports.ErrRequestConflict) {
		t.Fatalf("changed proof replay=%v", err)
	}
	if pending, err := repository.LegacySystemSkillsMigrationRequired(ctx, base.Agent.AgentID); err != nil || !pending {
		t.Fatalf("binding reopened gate=%t %v", pending, err)
	}
	if _, err := repository.ConfirmLifecycleDrain(ctx, ports.ConfirmLifecycleDrain{RequestID: begin.Operation.RequestID,
		Fingerprint: begin.Operation.RequestFingerprint, Kind: domain.OperationRebuild,
		Outcome: ports.ExecutionSettled, Now: begin.Now.Add(time.Second)}); err != nil {
		t.Fatal(err)
	}
	attachment := ports.NetworkAttachment{AgentID: begin.AgentID, TunnelIPv4: "100.64.0.2", ResolverIPv4: "100.64.0.1",
		PacketContractRevision: 1, EgressIPv4: "10.20.0.8", EgressPort: 8092, State: ports.NetworkStateActive,
		NetworkResourceVersion: 1, AttachmentState: ports.NetworkAttachmentClosed, AttachmentResourceVersion: 2}
	if _, err := repository.AdvanceAgentRebuild(ctx, ports.AdvanceAgentRebuild{RequestID: begin.Operation.RequestID,
		Fingerprint: begin.Operation.RequestFingerprint, ExpectedPhase: domain.PhaseNetworkFence,
		NextPhase: domain.PhaseRuntimeUpdate, NextChildRequestID: domain.ChildRequestID(begin.Operation.RequestID, domain.PhaseRuntimeUpdate),
		NetworkAttachment: &attachment, Now: begin.Now.Add(2 * time.Second)}); err != nil {
		t.Fatal(err)
	}
	runtime := ports.RuntimeOperation{State: "completed", Effect: "completed", RuntimeRevision: "rtv_22222222222222222222222222222222",
		LifecycleState: "provisioned", Health: "unknown"}
	if _, err := repository.AdvanceAgentRebuild(ctx, ports.AdvanceAgentRebuild{RequestID: begin.Operation.RequestID,
		Fingerprint: begin.Operation.RequestFingerprint, ExpectedPhase: domain.PhaseRuntimeUpdate,
		NextPhase: domain.PhaseNetworkEnsure, NextChildRequestID: domain.ChildRequestID(begin.Operation.RequestID, domain.PhaseNetworkEnsure),
		RuntimeResult: &runtime, Now: begin.Now.Add(3 * time.Second)}); err != nil {
		t.Fatal(err)
	}
	attachment.AttachmentState, attachment.AttachmentResourceVersion = ports.NetworkAttachmentOpen, 3
	ready, err := repository.AdvanceAgentRebuild(ctx, ports.AdvanceAgentRebuild{RequestID: begin.Operation.RequestID,
		Fingerprint: begin.Operation.RequestFingerprint, ExpectedPhase: domain.PhaseNetworkEnsure,
		NextPhase: domain.PhasePublish, NextChildRequestID: domain.ChildRequestID(begin.Operation.RequestID, domain.PhasePublish),
		NetworkAttachment: &attachment, Now: begin.Now.Add(4 * time.Second)})
	if err != nil {
		t.Fatal(err)
	}
	publish := ports.PublishAgentRebuild{RequestID: begin.Operation.RequestID, Fingerprint: begin.Operation.RequestFingerprint,
		AccessRevision: "access-legacy-binding", RebuiltEvent: ports.AgentEventRecord{EventID: "event-legacy-binding-rebuilt",
			AgentID: begin.AgentID, AggregateSequence: ready.Agent.AggregateSequence + 1, SchemaVersion: 1,
			EventType: ports.EventAgentRebuilt, OperationRequestID: begin.Operation.RequestID,
			Data: map[string]any{}, OccurredAt: begin.Now.Add(5 * time.Second)}, Now: begin.Now.Add(5 * time.Second)}
	if _, err := repository.PublishAgentRebuild(ctx, publish); !errors.Is(err, ports.ErrConcurrentChange) {
		t.Fatalf("migration published without active mount verification: %v", err)
	}
	if pending, err := repository.LegacySystemSkillsMigrationRequired(ctx, begin.AgentID); err != nil || !pending {
		t.Fatalf("missing receipt released gate: %v %v", pending, err)
	}
	publish.LegacyVerification = &ports.LegacySkillPublishVerification{PreparedReferenceID: referenceID,
		Receipt: ports.ActiveSkillSetVerificationReceipt{AgentID: begin.AgentID, RuntimeRevision: runtime.RuntimeRevision,
			SkillSetDigest: "sha256:" + strings.Repeat("0", 64), LayoutVersion: domain.SkillLayoutVersion,
			ManifestDigest: "sha256:" + strings.Repeat("a", 64), VerifiedAt: publish.Now}}
	if _, err := repository.PublishAgentRebuild(ctx, publish); !errors.Is(err, ports.ErrConcurrentChange) {
		t.Fatalf("wrong collection published: %v", err)
	}
	publish.LegacyVerification.Receipt.SkillSetDigest = begin.TargetSpec.Snapshot.SkillSetDigest
	expired := publish
	expired.Now = expiresAt.Add(time.Second)
	expired.LegacyVerification = &ports.LegacySkillPublishVerification{PreparedReferenceID: referenceID,
		Receipt: publish.LegacyVerification.Receipt}
	expired.LegacyVerification.Receipt.VerifiedAt = expired.Now
	if _, err := repository.PublishAgentRebuild(ctx, expired); !errors.Is(err, ports.ErrLegacyMigrationProofLost) {
		t.Fatalf("expired proof remained retryable: %v", err)
	}
	if pending, err := repository.LegacySystemSkillsMigrationRequired(ctx, begin.AgentID); err != nil || !pending {
		t.Fatalf("expired proof released gate: %v %v", pending, err)
	}
	published, err := repository.PublishAgentRebuild(ctx, publish)
	if err != nil || published.Operation.State != domain.OperationCompleted {
		t.Fatalf("verified migration publication: %+v %v", published.Operation, err)
	}
	if pending, err := repository.LegacySystemSkillsMigrationRequired(ctx, begin.AgentID); err != nil || pending {
		t.Fatalf("verified migration kept gate=%v %v", pending, err)
	}
	var evidence string
	if err := repository.pool.QueryRow(ctx, `SELECT evidence_ref FROM agent_controller.legacy_system_skills_migrations WHERE agent_id=$1`, begin.AgentID).Scan(&evidence); err != nil || evidence != begin.Operation.RequestID {
		t.Fatalf("migration evidence=%q error=%v", evidence, err)
	}
}
