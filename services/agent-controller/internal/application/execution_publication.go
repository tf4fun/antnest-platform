package application

import (
	"context"
	"errors"
	"fmt"
	"sync"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

type ExecutionPublisher struct {
	store       ports.ExecutionPublicationStore
	opener      ports.CredentialOpener
	client      ports.ExecutionClient
	runtime     ports.RuntimeConnectionResolver
	wireVersion int
	mu          sync.Mutex
	active      map[string]*executionPublicationGate
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
	var acknowledgement ports.ExecutionAcknowledgement
	err = publisher.store.WithExecutionPublication(ctx, organizationID, func(ownedContext context.Context) error {
		if err := ownedContext.Err(); err != nil {
			return err
		}
		var publishErr error
		acknowledgement, publishErr = publisher.publishCurrent(ownedContext, organizationID, settlement)
		return publishErr
	})
	if err != nil {
		return ports.ExecutionAcknowledgement{}, err
	}
	return acknowledgement, nil
}

func (publisher *ExecutionPublisher) publishCurrent(ctx context.Context, organizationID string, settlement *ports.LifecycleSettlementRequest) (ports.ExecutionAcknowledgement, error) {
	var remote ports.ExecutionDigest
	var remoteKnown bool
	if publisher.wireVersion == ports.ExecutionSchemaVersion2 && settlement == nil {
		synchronization, err := publisher.store.GetExecutionSynchronization(ctx, organizationID)
		if errors.Is(err, ports.ErrNotFound) {
			synchronization = ports.ExecutionSynchronization{OrganizationID: organizationID}
		} else if err != nil {
			return ports.ExecutionAcknowledgement{}, fmt.Errorf("read execution synchronization: %w", err)
		}
		if synchronization.OrganizationID != organizationID || synchronization.Revision < 0 || synchronization.Revision > ports.MaximumExecutionRevision {
			return ports.ExecutionAcknowledgement{}, ports.ErrInvalidExecutionConfiguration
		}
		remote, err = publisher.executionRemoteDigest(ctx, organizationID)
		if err != nil {
			return ports.ExecutionAcknowledgement{}, err
		}
		remoteKnown = true
		if remote.SchemaVersion == ports.ExecutionSchemaVersion2 && synchronization.Revision >= 1 && remote.Revision == synchronization.Revision {
			return publisher.recordAcknowledgement(ctx, ports.ExecutionAcknowledgement{OrganizationID: organizationID, AppliedRevision: remote.Revision})
		}
		if remote.Revision > synchronization.Revision {
			return ports.ExecutionAcknowledgement{}, &ports.DependencyError{Service: "agent-acp-service", Code: "invalid_response", Retryable: true}
		}
	}
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
	if publisher.wireVersion == ports.ExecutionSchemaVersion2 {
		if settlement != nil {
			// The old accepting owner may be unavailable or Runtime-protected.
			// Publish its authoritative closure before requiring the new ACK;
			// proof of the old open publication cannot gate lifecycle recovery.
			return publisher.publishFullV2(ctx, source)
		}
		return publisher.publishCurrentV2(ctx, source, remote, remoteKnown)
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
	return publisher.acknowledge(ctx, source, acknowledgement)
}

func (publisher *ExecutionPublisher) publishFullV2(ctx context.Context, source ports.ExecutionSource) (ports.ExecutionAcknowledgement, error) {
	snapshot, err := BuildExecutionSnapshotV2(ctx, source)
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
	return publisher.acknowledge(ctx, source, acknowledgement)
}

func (publisher *ExecutionPublisher) publishCurrentV2(ctx context.Context, source ports.ExecutionSource, remote ports.ExecutionDigest, remoteKnown bool) (ports.ExecutionAcknowledgement, error) {
	client, err := publisher.executionV2Client()
	if err != nil {
		return ports.ExecutionAcknowledgement{}, err
	}
	if !remoteKnown {
		remote, err = publisher.executionRemoteDigest(ctx, source.OrganizationID)
		if err != nil {
			return ports.ExecutionAcknowledgement{}, err
		}
	}
	if remote.Revision > source.Revision {
		return ports.ExecutionAcknowledgement{}, &ports.DependencyError{Service: "agent-acp-service", Code: "invalid_response", Retryable: true}
	}
	if remote.SchemaVersion == ports.ExecutionSchemaVersion2 && remote.Revision == source.Revision {
		return publisher.recordAcknowledgement(ctx, ports.ExecutionAcknowledgement{OrganizationID: source.OrganizationID, AppliedRevision: source.Revision})
	}
	snapshot, err := BuildExecutionSnapshotV2(ctx, source)
	if err != nil {
		return ports.ExecutionAcknowledgement{}, err
	}
	if err := publisher.resolveRuntimeAuthority(ctx, &snapshot); err != nil {
		return ports.ExecutionAcknowledgement{}, err
	}
	var acknowledgement ports.ExecutionAcknowledgement
	if remote.SchemaVersion == ports.ExecutionSchemaVersion2 && remote.Revision >= 1 && remote.Revision < source.Revision {
		delta, err := ports.BuildExecutionDelta(snapshot, remote)
		if err != nil {
			return ports.ExecutionAcknowledgement{}, err
		}
		acknowledgement, err = client.ApplyExecutionDelta(ctx, delta)
		if err != nil {
			if !executionBaseMismatch(err) {
				return ports.ExecutionAcknowledgement{}, err
			}
			acknowledgement, err = publisher.client.ApplyExecutionSnapshot(ctx, snapshot)
			if err != nil {
				return ports.ExecutionAcknowledgement{}, err
			}
		}
	} else {
		acknowledgement, err = publisher.client.ApplyExecutionSnapshot(ctx, snapshot)
		if err != nil {
			return ports.ExecutionAcknowledgement{}, err
		}
	}
	return publisher.acknowledge(ctx, source, acknowledgement)
}

func (publisher *ExecutionPublisher) executionV2Client() (ports.ExecutionV2Client, error) {
	client, ok := publisher.client.(ports.ExecutionV2Client)
	if !ok {
		return nil, ports.ErrInvalidExecutionConfiguration
	}
	return client, nil
}

func executionBaseMismatch(err error) bool {
	var dependency *ports.DependencyError
	return errors.As(err, &dependency) && dependency.Service == "agent-acp-service" && dependency.Code == "configuration_base_mismatch"
}

func (publisher *ExecutionPublisher) executionRemoteDigest(ctx context.Context, organizationID string) (ports.ExecutionDigest, error) {
	client, err := publisher.executionV2Client()
	if err != nil {
		return ports.ExecutionDigest{}, err
	}
	remote, err := client.GetExecutionDigest(ctx, organizationID)
	if err != nil {
		return ports.ExecutionDigest{}, err
	}
	if remote.OrganizationID != organizationID || remote.Validate() != nil {
		return ports.ExecutionDigest{}, &ports.DependencyError{Service: "agent-acp-service", Code: "invalid_response", Retryable: true}
	}
	return remote, nil
}

func (publisher *ExecutionPublisher) acknowledge(ctx context.Context, source ports.ExecutionSource, acknowledgement ports.ExecutionAcknowledgement) (ports.ExecutionAcknowledgement, error) {
	if acknowledgement.OrganizationID != source.OrganizationID || acknowledgement.AppliedRevision < source.Revision || acknowledgement.AppliedRevision > ports.MaximumExecutionRevision {
		return ports.ExecutionAcknowledgement{}, &ports.DependencyError{Service: "agent-acp-service", Code: "invalid_response", Retryable: true}
	}
	return publisher.recordAcknowledgement(ctx, acknowledgement)
}

func (publisher *ExecutionPublisher) recordAcknowledgement(ctx context.Context, acknowledgement ports.ExecutionAcknowledgement) (ports.ExecutionAcknowledgement, error) {
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
