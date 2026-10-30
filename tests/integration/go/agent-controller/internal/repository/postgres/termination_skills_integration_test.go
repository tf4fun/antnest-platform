package postgres

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

type terminationSkillReleaseClient struct {
	ports.SkillPreparationClient
	release func(string) error
}

func (client *terminationSkillReleaseClient) ReleaseSkillPreparation(_ context.Context, requestID, _, _, _, _ string) error {
	return client.release(requestID)
}

func TestTerminationSkillReleaseUnblocksFailedCreateRebuild(t *testing.T) {
	repository, base := identityTestRepository(t)
	ctx := t.Context()
	operation := reliabilitySeedCreate(t, repository, base, "termination-skill-agent")
	spec, err := loadAgentSpec(ctx, repository.pool, operation.TargetSpecRevisionID)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	_, err = repository.ReserveSkillPreparation(ctx, ports.SkillPreparationIntent{
		RequestID: operation.RequestID, RequestFingerprint: operation.RequestFingerprint,
		Kind: domain.OperationCreate, AgentID: operation.AgentID, OrganizationID: base.Agent.OrganizationID,
		TargetSpec: spec.Snapshot, TargetSpecDigest: spec.CanonicalDigest, CreatedAt: now, UpdatedAt: now,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = repository.MarkSkillPreparationReady(ctx, operation.RequestID, operation.RequestFingerprint, "psr_11111111111111111111111111111111", now)
	if err != nil {
		t.Fatal(err)
	}
	var releaseIDs []string
	client := &terminationSkillReleaseClient{release: func(id string) error {
		current, err := repository.GetLifecycleOperation(ctx, operation.RequestID)
		if err != nil || current.State != domain.OperationFailed {
			t.Fatalf("release before committed termination: %v", err)
		}
		releaseIDs = append(releaseIDs, id)
		if len(releaseIDs) == 1 {
			return errors.New("release confirmation lost")
		}
		return nil
	}}
	service := application.NewLifecycleService(nil, repository, nil, nil, &catalogStateClock{now: now}, application.WithSkillPreparation(repository, client))
	input := application.LifecycleTermination{RequestID: operation.RequestID, Phase: domain.PhaseNetworkEnsure, Code: "phase_deadline_exceeded"}
	_, err = service.TerminateLifecycle(ctx, input)
	if !errors.Is(err, application.ErrDependencyUnavailable) {
		t.Fatalf("unconfirmed release must be retried: %v", err)
	}
	intent, err := repository.GetSkillPreparationIntent(ctx, operation.RequestID)
	if err != nil || intent.State != "ready" {
		t.Fatalf("unconfirmed preparation must remain owned: state=%s err=%v", intent.State, err)
	}
	loaded, err := repository.GetAgentLifecycleBase(ctx, operation.AgentID)
	if err != nil {
		t.Fatal(err)
	}
	if !ports.FailedCreateRebuildSourceMatches(loaded) {
		t.Fatal("terminated create lost its rebuild source")
	}
	rebuild := ports.SkillPreparationIntent{
		RequestID: "request-rebuild-after-termination", RequestFingerprint: strings.Repeat("e", 64),
		Kind: domain.OperationRebuild, AgentID: operation.AgentID, OrganizationID: base.Agent.OrganizationID,
		TargetSpec: spec.Snapshot, TargetSpecDigest: spec.CanonicalDigest,
		ExpectedAggregateSequence: loaded.Agent.AggregateSequence, ExpectedSpecRevisionID: loaded.Agent.AgentSpecRevisionID,
		ExpectedExecutionRevisionID: "", ExpectedRuntimeRevision: "", CreatedAt: now, UpdatedAt: now,
	}
	if _, err := repository.ReserveSkillPreparation(ctx, rebuild); !errors.Is(err, ports.ErrConcurrentChange) {
		t.Fatalf("the original ready preparation must exclude a second reservation: %v", err)
	}
	_, err = service.TerminateLifecycle(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	if len(releaseIDs) != 2 || releaseIDs[0] != releaseIDs[1] {
		t.Fatalf("release retry changed identity: %v", releaseIDs)
	}
	intent, err = repository.GetSkillPreparationIntent(ctx, operation.RequestID)
	if err != nil || intent.State != "released" {
		t.Fatalf("confirmed release was not persisted: state=%s err=%v", intent.State, err)
	}
	if _, err := repository.ReserveSkillPreparation(ctx, rebuild); err != nil {
		t.Fatalf("confirmed release must unblock the real unique constraint: %v", err)
	}
	if reliabilityEvents(t, repository, "agent_build_failed", operation.AgentID) != 1 {
		t.Fatal("release retry duplicated termination audit")
	}
}
