package postgres

import (
	"context"
	"errors"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func TestSkillPreparationIntentFreezesTargetAndReplaysWithoutLifecycleSideEffects(t *testing.T) {
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
	base, _ := seedConfiguredAgentForTest(t, ctx, repository, false)
	before, err := repository.GetAgent(ctx, base.Agent.AgentID)
	if err != nil {
		t.Fatal(err)
	}
	intent := ports.SkillPreparationIntent{
		RequestID: "request-prepare-rebuild", RequestFingerprint: strings.Repeat("a", 64),
		Kind: domain.OperationRebuild, AgentID: before.AgentID, OrganizationID: before.OrganizationID,
		TargetSpec: base.ConfiguredSpec.Snapshot, TargetSpecDigest: base.ConfiguredSpec.CanonicalDigest,
		ExpectedAggregateSequence: before.AggregateSequence, ExpectedSpecRevisionID: before.AgentSpecRevisionID,
		ExpectedExecutionRevisionID: before.ExecutionRevisionID, ExpectedRuntimeRevision: before.RuntimeRevision,
		CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC(),
	}
	reserved, err := repository.ReserveSkillPreparation(ctx, intent)
	if err != nil {
		t.Fatal(err)
	}
	if reserved.State != "preparing" {
		t.Fatalf("state = %q", reserved.State)
	}
	intent.TargetSpec.SystemPrompt = "changed after reservation"
	replayed, err := repository.ReserveSkillPreparation(ctx, intent)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(replayed.TargetSpec, reserved.TargetSpec) {
		t.Fatal("replay did not preserve frozen target")
	}
	if replayed.TargetSpec.SystemPrompt == intent.TargetSpec.SystemPrompt {
		t.Fatal("replay used mutable input")
	}
	loaded, err := repository.GetSkillPreparationIntent(ctx, intent.RequestID)
	if err != nil || !reflect.DeepEqual(loaded.TargetSpec, reserved.TargetSpec) {
		t.Fatalf("loaded = %+v, %v", loaded, err)
	}
	after, err := repository.GetAgent(ctx, before.AgentID)
	if err != nil {
		t.Fatal(err)
	}
	if after.AggregateSequence != before.AggregateSequence || after.ActiveOperationRequestID != before.ActiveOperationRequestID || after.ExecutionReady() != before.ExecutionReady() {
		t.Fatalf("preparation changed Agent lifecycle: before %+v, after %+v", before, after)
	}
	ready, err := repository.MarkSkillPreparationReady(ctx, intent.RequestID, intent.RequestFingerprint, "skillref_11111111111111111111111111111111", time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	if ready.State != "ready" || ready.PreparedReferenceID == "" {
		t.Fatalf("ready = %+v", ready)
	}
	if _, err := repository.MarkSkillPreparationReady(ctx, intent.RequestID, intent.RequestFingerprint, "skillref_different", time.Now().UTC()); !errors.Is(err, ports.ErrRequestConflict) {
		t.Fatalf("conflicting ready reference = %v", err)
	}
	released, err := repository.MarkSkillPreparationReleased(ctx, intent.RequestID, intent.RequestFingerprint, time.Now().UTC())
	if err != nil || released.State != "released" {
		t.Fatalf("released = %+v, %v", released, err)
	}
	if _, err := repository.MarkSkillPreparationReleased(ctx, intent.RequestID, intent.RequestFingerprint, time.Now().UTC()); err != nil {
		t.Fatalf("release replay: %v", err)
	}
}

func TestSkillPreparationIntentRejectsChangedSourceBeforeReservation(t *testing.T) {
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
	base, _ := seedConfiguredAgentForTest(t, ctx, repository, false)
	intent := ports.SkillPreparationIntent{
		RequestID: "request-stale-prepare", RequestFingerprint: strings.Repeat("b", 64),
		Kind: domain.OperationRebuild, AgentID: base.Agent.AgentID, OrganizationID: base.Agent.OrganizationID,
		TargetSpec: base.ConfiguredSpec.Snapshot, TargetSpecDigest: base.ConfiguredSpec.CanonicalDigest,
		ExpectedAggregateSequence:   base.Agent.AggregateSequence + 1,
		ExpectedSpecRevisionID:      base.Agent.AgentSpecRevisionID,
		ExpectedExecutionRevisionID: base.Agent.ExecutionRevisionID,
		ExpectedRuntimeRevision:     base.Agent.RuntimeRevision,
		CreatedAt:                   time.Now().UTC(), UpdatedAt: time.Now().UTC(),
	}
	if _, err := repository.ReserveSkillPreparation(ctx, intent); !errors.Is(err, ports.ErrConcurrentChange) {
		t.Fatalf("stale source = %v", err)
	}
	if _, err := repository.GetSkillPreparationIntent(ctx, intent.RequestID); !errors.Is(err, ports.ErrNotFound) {
		t.Fatalf("stale request persisted: %v", err)
	}
}

func TestSkillPreparationIntentUsesDisabledAgentLastSuccessfulExecution(t *testing.T) {
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
	base, _ := seedConfiguredAgentForTest(t, ctx, repository, false)
	disabled := seedDisabledAgentForEnable(t, ctx, repository, base)
	intent := ports.SkillPreparationIntent{
		RequestID: "request-prepare-enable", RequestFingerprint: strings.Repeat("c", 64),
		Kind: domain.OperationEnable, AgentID: disabled.AgentID, OrganizationID: disabled.OrganizationID,
		TargetSpec: base.ConfiguredSpec.Snapshot, TargetSpecDigest: base.ConfiguredSpec.CanonicalDigest,
		ExpectedAggregateSequence: disabled.AggregateSequence, ExpectedSpecRevisionID: disabled.AgentSpecRevisionID,
		ExpectedExecutionRevisionID: disabled.LastSuccessfulExecutionRevisionID,
		ExpectedRuntimeRevision:     disabled.RuntimeRevision,
		CreatedAt:                   time.Now().UTC(), UpdatedAt: time.Now().UTC(),
	}
	if _, err := repository.ReserveSkillPreparation(ctx, intent); err != nil {
		t.Fatal(err)
	}
	after, err := repository.GetAgent(ctx, disabled.AgentID)
	if err != nil {
		t.Fatal(err)
	}
	if after.ActiveOperationRequestID != "" || after.AggregateSequence != disabled.AggregateSequence {
		t.Fatalf("preparation started Agent enable: %+v", after)
	}
}

func TestAbandonedSkillPreparationAllowsNewAgentOperation(t *testing.T) {
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
	base, _ := seedConfiguredAgentForTest(t, ctx, repository, false)
	intent := ports.SkillPreparationIntent{RequestID: "request-abandoned", RequestFingerprint: strings.Repeat("d", 64), Kind: domain.OperationRebuild,
		AgentID: base.Agent.AgentID, OrganizationID: base.Agent.OrganizationID, TargetSpec: base.ConfiguredSpec.Snapshot,
		TargetSpecDigest: base.ConfiguredSpec.CanonicalDigest, ExpectedAggregateSequence: base.Agent.AggregateSequence,
		ExpectedSpecRevisionID: base.Agent.AgentSpecRevisionID, ExpectedExecutionRevisionID: base.Agent.ExecutionRevisionID,
		ExpectedRuntimeRevision: base.Agent.RuntimeRevision, CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC()}
	if _, err := repository.ReserveSkillPreparation(ctx, intent); err != nil {
		t.Fatal(err)
	}
	if _, err := repository.MarkSkillPreparationAbandoned(ctx, intent.RequestID, intent.RequestFingerprint, time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	intent.RequestID, intent.RequestFingerprint = "request-after-abandoned", strings.Repeat("e", 64)
	if _, err := repository.ReserveSkillPreparation(ctx, intent); err != nil {
		t.Fatalf("abandoned intent retained active slot: %v", err)
	}
}

func TestInvalidatedSkillPreparationAdvancesDurableAttempt(t *testing.T) {
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
	base, _ := seedConfiguredAgentForTest(t, ctx, repository, false)
	intent := ports.SkillPreparationIntent{RequestID: "request-invalidated", RequestFingerprint: strings.Repeat("f", 64), Kind: domain.OperationRebuild,
		AgentID: base.Agent.AgentID, OrganizationID: base.Agent.OrganizationID, TargetSpec: base.ConfiguredSpec.Snapshot,
		TargetSpecDigest: base.ConfiguredSpec.CanonicalDigest, ExpectedAggregateSequence: base.Agent.AggregateSequence,
		ExpectedSpecRevisionID: base.Agent.AgentSpecRevisionID, ExpectedExecutionRevisionID: base.Agent.ExecutionRevisionID,
		ExpectedRuntimeRevision: base.Agent.RuntimeRevision, CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC()}
	if _, err := repository.ReserveSkillPreparation(ctx, intent); err != nil {
		t.Fatal(err)
	}
	if _, err := repository.MarkSkillPreparationReady(ctx, intent.RequestID, intent.RequestFingerprint, "psr_11111111111111111111111111111111", time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	stale, err := repository.MarkSkillPreparationInvalidated(ctx, intent.RequestID, intent.RequestFingerprint, time.Now().UTC())
	if err != nil || stale.State != "invalidated" || stale.PreparedReferenceID == "" || stale.PreparationAttempt != 0 {
		t.Fatalf("stale = %+v, %v", stale, err)
	}
	advanced, err := repository.AdvanceSkillPreparationAttempt(ctx, intent.RequestID, intent.RequestFingerprint, 0, time.Now().UTC())
	if err != nil || advanced.State != "preparing" || advanced.PreparationAttempt != 1 || advanced.PreparedReferenceID != "" {
		t.Fatalf("advanced = %+v, %v", advanced, err)
	}
	if _, err := repository.AdvanceSkillPreparationAttempt(ctx, intent.RequestID, intent.RequestFingerprint, 0, time.Now().UTC()); !errors.Is(err, ports.ErrRequestConflict) {
		t.Fatalf("stale attempt accepted: %v", err)
	}
}
