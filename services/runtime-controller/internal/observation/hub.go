package observation

import (
	"context"
	"fmt"
	"sync"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/repository"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/skillset"
)

var (
	observationMeter   = otel.Meter("github.com/tf4fun/antnest-platform/runtime-controller/observation")
	storedObservations = mustCounter(observationMeter.Int64Counter("runtime.observations"))
)

type Hub struct {
	mu          sync.Mutex
	nextID      uint64
	subscribers map[uint64]chan struct{}
}

func NewHub() *Hub {
	return &Hub{subscribers: make(map[uint64]chan struct{})}
}

func (h *Hub) Subscribe() (<-chan struct{}, func()) {
	h.mu.Lock()
	h.nextID++
	id := h.nextID
	channel := make(chan struct{}, 1)
	h.subscribers[id] = channel
	h.mu.Unlock()
	var once sync.Once
	return channel, func() {
		once.Do(func() {
			h.mu.Lock()
			delete(h.subscribers, id)
			h.mu.Unlock()
		})
	}
}

func (h *Hub) Publish() {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, subscriber := range h.subscribers {
		select {
		case subscriber <- struct{}{}:
		default:
		}
	}
}

type Repository struct {
	next   repository.Store
	hub    *Hub
	health *Health
}

func NewRepository(next repository.Store, hub *Hub, health *Health) (*Repository, error) {
	if next == nil || hub == nil || health == nil {
		return nil, fmt.Errorf("repository, observation hub, and health tracker are required")
	}
	return &Repository{next: next, hub: hub, health: health}, nil
}

func (r *Repository) BeginTransition(
	ctx context.Context, operation deployment.Operation,
) (deployment.Operation, bool, error) {
	return r.next.BeginTransition(ctx, operation)
}

func (r *Repository) GenerationClaim(
	ctx context.Context, key deployment.Key,
) (repository.GenerationClaim, error) {
	return r.next.GenerationClaim(ctx, key)
}

func (r *Repository) MaxClaimedGeneration(ctx context.Context, agentID string) (uint64, error) {
	return r.next.MaxClaimedGeneration(ctx, agentID)
}

func (r *Repository) ResolvePreparedSkillSet(ctx context.Context, reference skillset.PreparedReference) (skillset.PreparedMaterialization, error) {
	store, ok := r.next.(repository.PreparedSkillReferenceStore)
	if !ok {
		return skillset.PreparedMaterialization{}, repository.ErrPreparedSkillSetInvalidated
	}
	return store.ResolvePreparedSkillSet(ctx, reference)
}

func (r *Repository) CompleteOperation(
	ctx context.Context,
	operation deployment.Operation,
	observation *deployment.Observation,
) (*deployment.Observation, error) {
	stored, err := r.next.CompleteOperation(ctx, operation, observation)
	if err != nil {
		if observation != nil {
			r.health.MarkJournal(false)
		}
		return nil, err
	}
	if stored != nil {
		r.health.MarkJournal(true)
		recordStoredObservation(ctx, *stored)
		r.hub.Publish()
	}
	return stored, nil
}

func (r *Repository) GetOperation(ctx context.Context, requestID string) (deployment.Operation, error) {
	return r.next.GetOperation(ctx, requestID)
}

func (r *Repository) GetEnvironment(ctx context.Context, agentID string) (deployment.Environment, error) {
	return r.next.GetEnvironment(ctx, agentID)
}

func (r *Repository) ListEnvironments(ctx context.Context) ([]deployment.Environment, error) {
	return r.next.ListEnvironments(ctx)
}

func (r *Repository) AppendObservation(
	ctx context.Context, value deployment.Observation,
) (deployment.Observation, error) {
	stored, err := r.next.AppendObservation(ctx, value)
	if err != nil {
		r.health.MarkJournal(false)
		return deployment.Observation{}, err
	}
	r.health.MarkJournal(true)
	recordStoredObservation(ctx, stored)
	r.hub.Publish()
	return stored, nil
}

func (r *Repository) ListObservations(
	ctx context.Context, after uint64, limit int,
) (deployment.ObservationWindow, error) {
	return r.next.ListObservations(ctx, after, limit)
}

func (r *Repository) Ready(ctx context.Context) error {
	return r.next.Ready(ctx)
}

var _ repository.Store = (*Repository)(nil)

func recordStoredObservation(ctx context.Context, value deployment.Observation) {
	storedObservations.Add(ctx, 1, metric.WithAttributes(
		attribute.String("antnest.observation.kind", string(value.Kind)),
	))
}

func mustCounter(instrument metric.Int64Counter, err error) metric.Int64Counter {
	if err != nil {
		panic(err)
	}
	return instrument
}
