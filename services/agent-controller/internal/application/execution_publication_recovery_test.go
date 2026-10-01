package application

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"testing/synctest"

	"github.com/stretchr/testify/require"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func TestExecutionPublisherFailureReleasesWaitingPublication(t *testing.T) {
	for _, scenario := range []struct {
		stage  string
		cancel bool
	}{{"read", false}, {"read", true}, {"apply", false}, {"apply", true}, {"record", false}, {"record", true}} {
		name := scenario.stage + "/failure"
		if scenario.cancel {
			name = scenario.stage + "/cancellation"
		}
		t.Run(name, func(t *testing.T) {
			testExecutionPublicationRecovery(t, scenario.stage, scenario.cancel)
		})
	}
}

func testExecutionPublicationRecovery(t *testing.T, failingStage string, canceled bool) {
	t.Helper()
	synctest.Test(t, func(t *testing.T) {
		failure := errors.New("synthetic publication failure")
		entered, finish := make(chan struct{}), make(chan struct{})
		block := func(ctx context.Context, stage string, revision int64) error {
			if stage != failingStage || revision != 1 {
				return nil
			}
			close(entered)
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-finish:
				return failure
			}
		}
		var reads atomic.Int64
		store := &executionPublicationStoreStub{
			read: func(ctx context.Context, organizationID string) (ports.ExecutionSource, error) {
				revision := reads.Add(1)
				return ports.ExecutionSource{OrganizationID: organizationID, Revision: revision}, block(ctx, "read", revision)
			},
			record: func(ctx context.Context, acknowledgement ports.ExecutionAcknowledgement) error {
				return block(ctx, "record", acknowledgement.AppliedRevision)
			},
		}
		client := &executionPublicationClientStub{apply: func(ctx context.Context, snapshot ports.ExecutionSnapshot) (ports.ExecutionAcknowledgement, error) {
			return ports.ExecutionAcknowledgement{OrganizationID: snapshot.OrganizationID, AppliedRevision: snapshot.Revision}, block(ctx, "apply", snapshot.Revision)
		}}
		publisher := NewExecutionPublisher(store, &executionCredentialOpener{}, client)
		ctx, cancel := context.WithCancel(t.Context())
		defer cancel()
		first := asyncPublication(ctx, publisher, "org-1")
		<-entered
		second := asyncPublication(t.Context(), publisher, "org-1")
		synctest.Wait()
		require.EqualValues(t, 1, reads.Load())
		if canceled {
			cancel()
			failure = context.Canceled
		} else {
			close(finish)
		}
		require.ErrorIs(t, <-first, failure)
		require.NoError(t, <-second)
		require.EqualValues(t, 2, reads.Load())
		require.Empty(t, publisher.active)
	})
}
