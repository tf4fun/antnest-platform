package application

import (
	"context"
	"fmt"
	"sync"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

type ExecutionPublisher struct {
	store   ports.ExecutionPublicationStore
	opener  ports.CredentialOpener
	client  ports.ExecutionClient
	runtime ports.RuntimeConnectionResolver
	mu      sync.Mutex
	active  map[string]*executionPublicationGate
}

type executionPublicationGate struct {
	slot  chan struct{}
	users int
}

func NewExecutionPublisher(store ports.ExecutionPublicationStore, opener ports.CredentialOpener, client ports.ExecutionClient, options ...ExecutionPublicationOption) *ExecutionPublisher {
	publisher := &ExecutionPublisher{store: store, opener: opener, client: client, active: make(map[string]*executionPublicationGate)}
	for _, option := range options {
		option(publisher)
	}
	return publisher
}

func (publisher *ExecutionPublisher) Publish(ctx context.Context, organizationID string) (ports.ExecutionAcknowledgement, error) {
	return publisher.publish(ctx, organizationID, nil)
}

func (publisher *ExecutionPublisher) publish(ctx context.Context, organizationID string, settlement *ports.LifecycleSettlementRequest) (ports.ExecutionAcknowledgement, error) {
	if err := ctx.Err(); err != nil {
		return ports.ExecutionAcknowledgement{}, err
	}
	if organizationID == "" {
		return ports.ExecutionAcknowledgement{}, ports.ErrInvalidExecutionConfiguration
	}
	release, err := publisher.acquire(ctx, organizationID)
	if err != nil {
		return ports.ExecutionAcknowledgement{}, err
	}
	defer release()
	if err := ctx.Err(); err != nil {
		return ports.ExecutionAcknowledgement{}, err
	}
	return publisher.publishCurrent(ctx, organizationID, settlement)
}

func (publisher *ExecutionPublisher) publishCurrent(ctx context.Context, organizationID string, settlement *ports.LifecycleSettlementRequest) (ports.ExecutionAcknowledgement, error) {
	source, err := publisher.store.ReadExecutionSource(ctx, organizationID)
	if err != nil {
		return ports.ExecutionAcknowledgement{}, fmt.Errorf("read current execution configuration: %w", err)
	}
	if source.OrganizationID != organizationID {
		return ports.ExecutionAcknowledgement{}, ports.ErrInvalidExecutionConfiguration
	}
	if settlement != nil && !currentSettlementOperation(source, *settlement) {
		return ports.ExecutionAcknowledgement{}, ports.ErrConcurrentChange
	}
	snapshot, err := BuildExecutionSnapshot(ctx, source, publisher.opener)
	if err != nil {
		return ports.ExecutionAcknowledgement{}, err
	}
	if err := publisher.resolveRuntimeAuthority(ctx, &snapshot); err != nil {
		return ports.ExecutionAcknowledgement{}, err
	}
	acknowledgement, err := publisher.client.ApplyExecutionSnapshot(ctx, snapshot)
	if err != nil {
		return ports.ExecutionAcknowledgement{}, err
	}
	if acknowledgement.OrganizationID != organizationID || acknowledgement.AppliedRevision < source.Revision || acknowledgement.AppliedRevision > ports.MaximumExecutionRevision {
		return ports.ExecutionAcknowledgement{}, &ports.DependencyError{Service: "agent-acp-service", Code: "invalid_response", Retryable: true}
	}
	if err := publisher.store.RecordExecutionApplied(ctx, acknowledgement); err != nil {
		return ports.ExecutionAcknowledgement{}, fmt.Errorf("record applied execution configuration: %w", err)
	}
	return acknowledgement, nil
}

func (publisher *ExecutionPublisher) acquire(ctx context.Context, organizationID string) (func(), error) {
	publisher.mu.Lock()
	gate := publisher.active[organizationID]
	if gate == nil {
		gate = &executionPublicationGate{slot: make(chan struct{}, 1)}
		publisher.active[organizationID] = gate
	}
	gate.users++
	publisher.mu.Unlock()
	select {
	case gate.slot <- struct{}{}:
		return func() { <-gate.slot; publisher.release(organizationID, gate) }, nil
	case <-ctx.Done():
		publisher.release(organizationID, gate)
		return nil, ctx.Err()
	}
}

func (publisher *ExecutionPublisher) release(organizationID string, gate *executionPublicationGate) {
	publisher.mu.Lock()
	defer publisher.mu.Unlock()
	gate.users--
	if gate.users == 0 {
		delete(publisher.active, organizationID)
	}
}
