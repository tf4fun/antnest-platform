package observation

import (
	"context"
	"testing"
	"time"

	"soft/antnest-platform/services/runtime-controller/internal/deployment"
	"soft/antnest-platform/services/runtime-controller/internal/repository"
	"soft/antnest-platform/services/runtime-controller/internal/skillset"
)

func TestObservedRepositoryForwardsPreparedSkillReferenceResolution(t *testing.T) {
	wrapped, err := NewRepository(&fakeRepository{}, NewHub(), &Health{})
	if err != nil {
		t.Fatal(err)
	}
	prepared, err := wrapped.ResolvePreparedSkillSet(context.Background(), skillset.PreparedReference{ReferenceID: "psr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"})
	if err != nil || prepared.SetID != 7 {
		t.Fatalf("prepared reference was not forwarded: %+v %v", prepared, err)
	}
}

func TestLocalReadinessDoesNotDependOnPlatformWatchHealth(t *testing.T) {
	health := &Health{}
	health.MarkJournal(true)
	health.MarkNotifications(true)
	health.MarkMonitor(false)
	if err := health.ObservationReady(); err != nil {
		t.Fatalf("remote platform affected local readiness: %v", err)
	}
	health.MarkNotifications(false)
	if err := health.ObservationReady(); err == nil {
		t.Fatal("own notification initialization was ignored")
	}
}

func TestRepositoryPublishesOnlyPersistedObservations(t *testing.T) {
	base := &fakeRepository{}
	hub := NewHub()
	health := &Health{}
	health.MarkMonitor(true)
	health.MarkNotifications(true)
	repository, err := NewRepository(base, hub, health)
	if err != nil {
		t.Fatal(err)
	}
	notifications, cancel := hub.Subscribe()
	defer cancel()

	stored, err := repository.AppendObservation(context.Background(), deployment.Observation{
		AgentID: "agent-1", Generation: 7, Kind: deployment.ObservationHealthy,
		SpecDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		Source:     "test", ObservedAt: time.Now().UTC(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if stored.Sequence != 1 {
		t.Fatalf("sequence = %d", stored.Sequence)
	}
	select {
	case <-notifications:
	case <-time.After(time.Second):
		t.Fatal("persisted observation was not published")
	}

	base.appendErr = context.Canceled
	if _, err := repository.AppendObservation(context.Background(), deployment.Observation{}); err == nil {
		t.Fatal("append failure was hidden")
	}
	select {
	case <-notifications:
		t.Fatal("failed observation was published")
	default:
	}
	if err := health.ObservationReady(); err == nil {
		t.Fatal("journal append failure did not affect readiness")
	}
}

func TestHubCoalescesWakeupsWithoutBlockingPublisher(t *testing.T) {
	hub := NewHub()
	notifications, cancel := hub.Subscribe()
	defer cancel()
	for index := 0; index < 100; index++ {
		hub.Publish()
	}
	select {
	case <-notifications:
	default:
		t.Fatal("notification missing")
	}
	select {
	case <-notifications:
		t.Fatal("wakeups should be coalesced")
	default:
	}
}

type fakeRepository struct {
	appendErr error
}

func (*fakeRepository) BeginTransition(_ context.Context, operation deployment.Operation) (deployment.Operation, bool, error) {
	return operation, false, nil
}
func (*fakeRepository) GenerationClaim(context.Context, deployment.Key) (repository.GenerationClaim, error) {
	return repository.GenerationClaim{}, nil
}
func (*fakeRepository) MaxClaimedGeneration(context.Context, string) (uint64, error) { return 0, nil }
func (*fakeRepository) ResolvePreparedSkillSet(context.Context, skillset.PreparedReference) (skillset.PreparedMaterialization, error) {
	return skillset.PreparedMaterialization{SetID: 7, VolumeName: "prepared-test-volume"}, nil
}
func (*fakeRepository) CompleteOperation(
	context.Context, deployment.Operation, *deployment.Observation,
) (*deployment.Observation, error) {
	return nil, nil
}
func (*fakeRepository) GetOperation(context.Context, string) (deployment.Operation, error) {
	return deployment.Operation{}, nil
}
func (*fakeRepository) GetEnvironment(context.Context, string) (deployment.Environment, error) {
	return deployment.Environment{}, nil
}
func (*fakeRepository) ListEnvironments(context.Context) ([]deployment.Environment, error) {
	return nil, nil
}
func (r *fakeRepository) AppendObservation(_ context.Context, value deployment.Observation) (deployment.Observation, error) {
	if r.appendErr != nil {
		return deployment.Observation{}, r.appendErr
	}
	value.Sequence = 1
	return value, nil
}
func (*fakeRepository) ListObservations(context.Context, uint64, int) (deployment.ObservationWindow, error) {
	return deployment.ObservationWindow{}, nil
}
func (*fakeRepository) Ready(context.Context) error { return nil }
