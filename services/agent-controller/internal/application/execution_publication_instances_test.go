package application

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"

	"github.com/stretchr/testify/require"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func TestExecutionPublisherSerializesAcrossInstances(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var revision, reads atomic.Int64
		revision.Store(1)
		entered, finish := make(chan struct{}), make(chan struct{})
		var enteredOnce, releaseOnce sync.Once
		release := func() { releaseOnce.Do(func() { close(finish) }) }
		defer release()
		published := make(chan ports.ExecutionSnapshot, 3)
		store := &executionPublicationStoreStub{
			read: func(_ context.Context, organizationID string) (ports.ExecutionSource, error) {
				if organizationID == "org-1" {
					reads.Add(1)
				}
				return ports.ExecutionSource{OrganizationID: organizationID, Revision: revision.Load()}, nil
			},
			record: func(context.Context, ports.ExecutionAcknowledgement) error { return nil },
		}
		client := &executionPublicationClientStub{apply: func(_ context.Context, snapshot ports.ExecutionSnapshot) (ports.ExecutionAcknowledgement, error) {
			published <- snapshot
			if snapshot.OrganizationID == "org-1" && snapshot.Revision == 1 {
				enteredOnce.Do(func() { close(entered) })
				<-finish
			}
			return ports.ExecutionAcknowledgement{OrganizationID: snapshot.OrganizationID, AppliedRevision: snapshot.Revision}, nil
		}}
		opener := &executionCredentialOpener{}
		publisher := NewExecutionPublisher(store, opener, client)
		otherPublisher := NewExecutionPublisher(store, opener, client)
		first := asyncPublication(t.Context(), publisher, "org-1")
		<-entered
		second := asyncPublication(t.Context(), otherPublisher, "org-1")
		synctest.Wait()
		require.EqualValues(t, 1, reads.Load(), "a waiting publisher must not capture an old source")
		other := asyncPublication(t.Context(), otherPublisher, "org-2")
		require.NoError(t, <-other)
		revision.Store(2)
		release()
		require.NoError(t, <-first)
		require.NoError(t, <-second)
		require.EqualValues(t, 2, reads.Load())
		require.EqualValues(t, 1, (<-published).Revision)
		require.Equal(t, "org-2", (<-published).OrganizationID)
		require.EqualValues(t, 2, (<-published).Revision)
		require.Empty(t, publisher.active)
		require.Empty(t, otherPublisher.active)
	})
}
