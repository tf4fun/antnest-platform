package application

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

type executionPublicationStoreStub struct {
	ports.ExecutionPublicationStore
	read   func(context.Context, string) (ports.ExecutionSource, error)
	record func(context.Context, ports.ExecutionAcknowledgement) error
}

func (store *executionPublicationStoreStub) ReadExecutionSource(ctx context.Context, organizationID string) (ports.ExecutionSource, error) {
	return store.read(ctx, organizationID)
}

func (store *executionPublicationStoreStub) RecordExecutionApplied(ctx context.Context, acknowledgement ports.ExecutionAcknowledgement) error {
	return store.record(ctx, acknowledgement)
}

type executionPublicationClientStub struct {
	ports.ExecutionClient
	apply func(context.Context, ports.ExecutionSnapshot) (ports.ExecutionAcknowledgement, error)
}

func (client *executionPublicationClientStub) ApplyExecutionSnapshot(ctx context.Context, snapshot ports.ExecutionSnapshot) (ports.ExecutionAcknowledgement, error) {
	return client.apply(ctx, snapshot)
}

func TestExecutionPublisherRereadsCurrentConfigurationAndResendsEqualRevision(t *testing.T) {
	source := executionSource(t)
	var stages []string
	var revisions []int64
	store := &executionPublicationStoreStub{
		read: func(_ context.Context, organizationID string) (ports.ExecutionSource, error) {
			require.Equal(t, "org-1", organizationID)
			stages = append(stages, "read")
			return source, nil
		},
		record: func(_ context.Context, acknowledgement ports.ExecutionAcknowledgement) error {
			stages = append(stages, "record")
			require.Equal(t, source.Revision, acknowledgement.AppliedRevision)
			return nil
		},
	}
	client := &executionPublicationClientStub{apply: func(_ context.Context, snapshot ports.ExecutionSnapshot) (ports.ExecutionAcknowledgement, error) {
		stages = append(stages, "apply")
		revisions = append(revisions, snapshot.Revision)
		require.Equal(t, source.Providers[0].CredentialVersion, snapshot.Providers[0].CredentialRevision)
		return ports.ExecutionAcknowledgement{OrganizationID: snapshot.OrganizationID, AppliedRevision: snapshot.Revision}, nil
	}}
	opener := &executionCredentialOpener{}
	publisher := NewExecutionPublisher(store, opener, client)
	for range 2 {
		_, err := publisher.Publish(t.Context(), "org-1")
		require.NoError(t, err)
	}
	source.Revision++
	source.Providers[0].CredentialVersion = "rotated"
	_, err := publisher.Publish(t.Context(), "org-1")
	require.NoError(t, err)
	require.Equal(t, []int64{3, 3, 4}, revisions)
	require.Equal(t, []string{"read", "apply", "record", "read", "apply", "record", "read", "apply", "record"}, stages)
	require.Len(t, opener.calls, 3)
	require.Equal(t, "rotated", opener.calls[2].CredentialVersion)
}

func TestExecutionPublisherFailureDoesNotRecordSuccess(t *testing.T) {
	failure := errors.New("synthetic failure")
	for _, scenario := range []string{"read", "foreign-source", "credential", "apply", "foreign-ack", "stale-ack", "unsafe-ack", "record"} {
		t.Run(scenario, func(t *testing.T) {
			source := executionSource(t)
			applies, records := 0, 0
			opener := &executionCredentialOpener{}
			store := &executionPublicationStoreStub{
				read: func(context.Context, string) (ports.ExecutionSource, error) {
					if scenario == "read" {
						return ports.ExecutionSource{}, failure
					}
					if scenario == "foreign-source" {
						source.OrganizationID = "other-organization"
					}
					return source, nil
				},
				record: func(context.Context, ports.ExecutionAcknowledgement) error { records++; return failure },
			}
			client := &executionPublicationClientStub{apply: func(context.Context, ports.ExecutionSnapshot) (ports.ExecutionAcknowledgement, error) {
				applies++
				ack := ports.ExecutionAcknowledgement{OrganizationID: "org-1", AppliedRevision: source.Revision}
				switch scenario {
				case "apply":
					return ack, failure
				case "foreign-ack":
					ack.OrganizationID = "other-organization"
				case "stale-ack":
					ack.AppliedRevision--
				case "unsafe-ack":
					ack.AppliedRevision = 1 << 53
				}
				return ack, nil
			}}
			if scenario == "credential" {
				opener.err = failure
			}
			result, err := NewExecutionPublisher(store, opener, client).Publish(t.Context(), "org-1")
			require.Error(t, err)
			require.Empty(t, result)
			if scenario == "record" {
				require.Equal(t, 1, records)
			} else {
				require.Zero(t, records)
			}
			if scenario == "read" || scenario == "foreign-source" || scenario == "credential" {
				require.Zero(t, applies)
			}
			if scenario == "foreign-source" {
				require.Empty(t, opener.calls)
			}
		})
	}
}

func TestExecutionPublisherRejectsCancellationBeforeReading(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	_, err := NewExecutionPublisher(&executionPublicationStoreStub{}, &executionCredentialOpener{}, &executionPublicationClientStub{}).Publish(ctx, "org-1")
	require.ErrorIs(t, err, context.Canceled)
}

func TestExecutionPublisherRejectsEmptyOrganizationBeforeReading(t *testing.T) {
	_, err := NewExecutionPublisher(&executionPublicationStoreStub{}, &executionCredentialOpener{}, &executionPublicationClientStub{}).Publish(t.Context(), "")
	require.ErrorIs(t, err, ports.ErrInvalidExecutionConfiguration)
}

type cancellingPublicationOpener struct{ cancel context.CancelFunc }

func (opener cancellingPublicationOpener) Open(ctx context.Context, _ ports.CredentialIdentity, _ ports.SealedSecret) (string, error) {
	opener.cancel()
	return "", ctx.Err()
}

func TestExecutionPublisherPreservesCancellationDuringCredentialOpening(t *testing.T) {
	source := executionSource(t)
	store := &executionPublicationStoreStub{read: func(context.Context, string) (ports.ExecutionSource, error) { return source, nil }}
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	publisher := NewExecutionPublisher(store, cancellingPublicationOpener{cancel: cancel}, &executionPublicationClientStub{})
	result, err := publisher.Publish(ctx, "org-1")
	require.ErrorIs(t, err, context.Canceled)
	require.Empty(t, result)
	require.Empty(t, publisher.active)
}
