package application

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func TestRuntimeBarrierRecoveryAdmissionCancellationStopsAtDependencyBoundaries(t *testing.T) {
	for _, boundary := range []string{"before-read", "receipt-miss", "receipt-hit", "prepared", "committed"} {
		t.Run(boundary, func(t *testing.T) {
			fixture := newRuntimeBarrierAdmissionApplicationFixture(t)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			store := &runtimeBarrierAdmissionCancelStore{runtimeBarrierAdmissionApplicationStore: fixture.store, boundary: boundary, cancel: cancel}
			fixture.lifecycle.store = store
			fixture.lifecycle.skillIntents = &runtimeBarrierAdmissionCancelSkills{runtimeBarrierAdmissionApplicationSkills: fixture.skills, boundary: boundary, cancel: cancel}
			fixture.service = NewRuntimeBarrierRecoveryAdmissionService(fixture.lifecycle, store)
			fixture.store.receiptPresent = boundary == "receipt-hit"
			if boundary == "before-read" {
				cancel()
			}

			result, err := fixture.service.Admit(ctx, fixture.intent)

			require.ErrorIs(t, err, context.Canceled)
			require.Equal(t, RuntimeBarrierRecoveryAdmissionResult{}, result)
			require.Empty(t, fixture.store.replayKeys, "cancellation must not dispatch another lifecycle read")
			if boundary == "before-read" {
				require.Empty(t, fixture.store.calls)
			} else {
				require.Len(t, fixture.store.receiptKeys, 1, "cancellation must not reload or recover a receipt in the cancelled call")
			}
			if boundary == "committed" {
				require.Equal(t, 1, fixture.store.beginCalls)
				require.True(t, fixture.store.durable, "an accepted command remains pending for independent recovery")
			} else {
				require.Zero(t, fixture.store.beginCalls, "a cancelled preparation must not admit a new lifecycle")
				require.False(t, fixture.store.durable)
			}
			if boundary != "prepared" && boundary != "committed" {
				fixture.assertNoPreparation(t)
			}
		})
	}
}

type runtimeBarrierAdmissionCancelStore struct {
	*runtimeBarrierAdmissionApplicationStore
	boundary string
	cancel   context.CancelFunc
}

func (store *runtimeBarrierAdmissionCancelStore) ReplayRuntimeBarrierRecovery(ctx context.Context, organizationID, agentID, barrierID string) (ports.RuntimeBarrierRecoveryReceipt, bool, error) {
	receipt, found, err := store.runtimeBarrierAdmissionApplicationStore.ReplayRuntimeBarrierRecovery(ctx, organizationID, agentID, barrierID)
	if store.boundary == "receipt-miss" || store.boundary == "receipt-hit" {
		store.cancel()
	}
	return receipt, found, err
}

func (store *runtimeBarrierAdmissionCancelStore) BeginAgentRebuild(ctx context.Context, input ports.BeginAgentRebuild) (ports.AgentRebuildState, bool, error) {
	state, replayed, err := store.runtimeBarrierAdmissionApplicationStore.BeginAgentRebuild(ctx, input)
	if store.boundary == "committed" {
		store.cancel()
	}
	return state, replayed, err
}

type runtimeBarrierAdmissionCancelSkills struct {
	*runtimeBarrierAdmissionApplicationSkills
	boundary string
	cancel   context.CancelFunc
}

func (skills *runtimeBarrierAdmissionCancelSkills) MarkSkillPreparationReady(ctx context.Context, requestID, fingerprint, referenceID string, at time.Time) (ports.SkillPreparationIntent, error) {
	intent, err := skills.runtimeBarrierAdmissionApplicationSkills.MarkSkillPreparationReady(ctx, requestID, fingerprint, referenceID, at)
	if skills.boundary == "prepared" {
		skills.cancel()
	}
	return intent, err
}
