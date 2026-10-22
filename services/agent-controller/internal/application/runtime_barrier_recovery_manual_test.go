package application

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func TestRuntimeBarrierRecoveryManualAdmissionPreservesActorAndAcceptedPolicy(t *testing.T) {
	for _, mode := range []string{"manual", "notify", "auto"} {
		t.Run(mode, func(t *testing.T) {
			fixture := newRuntimeBarrierManualAdmissionFixture(t, mode)
			before := cloneRuntimeBarrierAdmissionApplicationIntent(fixture.intent)

			result, err := fixture.service.Admit(context.Background(), fixture.intent)

			require.NoError(t, err)
			require.False(t, result.Replayed)
			require.Equal(t, before, fixture.intent)
			require.Equal(t, fixture.receipt, result.Receipt)
			require.True(t, result.Receipt.Manual)
			require.Equal(t, fixture.store.state, result.State)
			require.Equal(t, "admin-1", result.Receipt.Command.ActorPrincipalID)
			require.Equal(t, mode, result.Receipt.Policy.Mode)
			require.Equal(t, fixture.receipt.AcceptedAt, result.State.Operation.CreatedAt)
			require.Equal(t, fixture.receipt.AcceptedAt.Add(time.Minute), result.Receipt.CooldownUntil)
			require.NotNil(t, fixture.store.begin.Recovery)
			require.True(t, fixture.store.begin.Recovery.Manual)
			require.Equal(t, before, *fixture.store.begin.Recovery)
			require.Equal(t, fixture.receipt.RequestFingerprint, fixture.store.begin.Operation.RequestFingerprint)
			require.Equal(t, []string{"recovery.replay", "lifecycle.base", "lifecycle.begin", "recovery.replay"}, fixture.store.calls)
			require.Empty(t, fixture.store.replayKeys, "ordinary operation replay cannot admit manual recovery")
			require.True(t, fixture.store.durable)
			require.Equal(t, 1, fixture.store.beginCalls)
			require.Equal(t, 1, fixture.skills.reserved)
			require.Equal(t, 1, fixture.client.calls)
		})
	}
}

func TestRuntimeBarrierRecoveryManualAdmissionReplaysOriginalPolicyActorAndCooldown(t *testing.T) {
	for _, mode := range []string{"manual", "notify", "auto"} {
		for _, state := range []domain.OperationState{domain.OperationRunning, domain.OperationCompleted, domain.OperationFailed} {
			t.Run(mode+"/"+string(state), func(t *testing.T) {
				fixture := newRuntimeBarrierManualAdmissionFixture(t, mode)
				fixture.store.receiptPresent = true
				fixture.store.state = fixture.originalState(t, state)
				fixture.specs.err = errors.New("current catalog must not replace the original recovery")
				fixture.store.baseErr = errors.New("current Agent must not be read on recovery replay")
				input := cloneRuntimeBarrierAdmissionApplicationIntent(fixture.intent)
				// A newer policy expectation is only an input observation here;
				// actual policy mutation and cooldown enforcement belong to PG tests.
				input.ExpectedPolicyRevision = fixture.receipt.Policy.Revision + 1
				input.ExpectedOwnerUserID = "new-owner"
				input.ExpectedOwnerAuthorizationSequence++
				input.ExpectedIdentityRevocationSequence++
				input.Command.ActorPrincipalID = "admin-2"
				input.Command.TemplateID = "new-template"
				input.Command.TemplateRevision = 99
				before := cloneRuntimeBarrierAdmissionApplicationIntent(input)
				original := cloneRuntimeBarrierAdmissionApplicationReceipt(fixture.receipt)

				result, err := fixture.service.Admit(context.Background(), input)

				require.NoError(t, err)
				require.True(t, result.Replayed)
				require.Equal(t, before, input)
				require.Equal(t, original, result.Receipt)
				require.Equal(t, original, fixture.store.receipt)
				require.Equal(t, fixture.store.state, result.State)
				require.Equal(t, "admin-1", result.Receipt.Command.ActorPrincipalID)
				require.Equal(t, original.CooldownUntil, result.Receipt.CooldownUntil)
				require.Equal(t, []string{"recovery.replay", "lifecycle.replay"}, fixture.store.calls)
				require.Equal(t, [][3]string{{original.Fact.OrganizationID, original.Fact.AgentID, original.Fact.Barrier.BarrierID}}, fixture.store.receiptKeys)
				require.Equal(t, [][2]string{{original.Command.RequestID, original.RequestFingerprint}}, fixture.store.replayKeys)
				fixture.assertNoPreparation(t)
			})
		}
	}
}

func TestRuntimeBarrierRecoveryManualAdmissionReplaysOriginalSource(t *testing.T) {
	for _, originalManual := range []bool{false, true} {
		name := "manual-follows-original-auto"
		if originalManual {
			name = "automatic-follows-original-manual"
		}
		t.Run(name, func(t *testing.T) {
			var fixture *runtimeBarrierAdmissionApplicationFixture
			if originalManual {
				fixture = newRuntimeBarrierManualAdmissionFixture(t, "manual")
			} else {
				fixture = newRuntimeBarrierAdmissionApplicationFixture(t)
			}
			fixture.store.receiptPresent = true
			fixture.specs.err = errors.New("replay must not prepare another recovery source")
			fixture.store.baseErr = errors.New("replay must not read the current Agent")
			input := cloneRuntimeBarrierAdmissionApplicationIntent(fixture.intent)
			input.Manual = !originalManual
			input.Command.ActorPrincipalID = "admin-2"
			if originalManual {
				input.Command.ActorPrincipalID = "agent-controller"
			}
			original := cloneRuntimeBarrierAdmissionApplicationReceipt(fixture.receipt)

			result, err := fixture.service.Admit(context.Background(), input)

			require.NoError(t, err)
			require.True(t, result.Replayed)
			require.Equal(t, originalManual, result.Receipt.Manual)
			require.Equal(t, original, result.Receipt)
			require.Equal(t, fixture.store.state, result.State)
			require.Equal(t, []string{"recovery.replay", "lifecycle.replay"}, fixture.store.calls)
			require.Equal(t, [][2]string{{original.Command.RequestID, original.RequestFingerprint}}, fixture.store.replayKeys)
			fixture.assertNoPreparation(t)
		})
	}
}

func TestRuntimeBarrierRecoveryManualAdmissionRejectsInvalidNewCommands(t *testing.T) {
	scenarios := []struct {
		name string
		edit func(*ports.RuntimeBarrierRecoveryIntent)
	}{
		{"missing-actor", func(input *ports.RuntimeBarrierRecoveryIntent) { input.Command.ActorPrincipalID = "" }},
		{"whitespace-actor", func(input *ports.RuntimeBarrierRecoveryIntent) { input.Command.ActorPrincipalID = "admin 1" }},
		{"invalid-actor", func(input *ports.RuntimeBarrierRecoveryIntent) { input.Command.ActorPrincipalID = "admin/1" }},
		{"overlong-actor", func(input *ports.RuntimeBarrierRecoveryIntent) {
			input.Command.ActorPrincipalID = strings.Repeat("a", 201)
		}},
		{"wrong-stable-request-ID", func(input *ports.RuntimeBarrierRecoveryIntent) { input.Command.RequestID = "other-request" }},
		{"automatic-intent-with-administrator-actor", func(input *ports.RuntimeBarrierRecoveryIntent) { input.Manual = false }},
	}
	for _, scenario := range scenarios {
		t.Run(scenario.name, func(t *testing.T) {
			fixture := newRuntimeBarrierManualAdmissionFixture(t, "auto")
			input := cloneRuntimeBarrierAdmissionApplicationIntent(fixture.intent)
			scenario.edit(&input)

			result, err := fixture.service.Admit(context.Background(), input)

			require.ErrorIs(t, err, ports.ErrInvalidRuntimeBarrierRecovery)
			require.Equal(t, RuntimeBarrierRecoveryAdmissionResult{}, result)
			require.Equal(t, []string{"recovery.replay"}, fixture.store.calls)
			require.Empty(t, fixture.store.replayKeys)
			fixture.assertNoPreparation(t)
		})
	}
}

func TestRuntimeBarrierRecoveryManualAdmissionRejectsCorruptOriginalReceipts(t *testing.T) {
	scenarios := []struct {
		name string
		edit func(*testing.T, *runtimeBarrierAdmissionApplicationFixture)
	}{
		{"foreign-organization", func(_ *testing.T, fixture *runtimeBarrierAdmissionApplicationFixture) {
			fixture.store.receipt.Fact.OrganizationID = "other-org"
		}},
		{"foreign-Agent", func(_ *testing.T, fixture *runtimeBarrierAdmissionApplicationFixture) {
			fixture.store.receipt.Fact.AgentID = "other-agent"
		}},
		{"different-barrier", func(_ *testing.T, fixture *runtimeBarrierAdmissionApplicationFixture) {
			fixture.store.receipt.Fact.Barrier.BarrierID = "other-barrier"
		}},
		{"fingerprint", func(_ *testing.T, fixture *runtimeBarrierAdmissionApplicationFixture) {
			fixture.store.receipt.RequestFingerprint = strings.Repeat("b", 64)
		}},
		{"invalid-actor-with-matching-fingerprint", func(t *testing.T, fixture *runtimeBarrierAdmissionApplicationFixture) {
			fixture.store.receipt.Command.ActorPrincipalID = "admin/1"
			fixture.store.receipt.RequestFingerprint = runtimeBarrierManualAdmissionFingerprint(t, fixture.store.receipt.Command)
			fixture.store.state.Operation.RequestFingerprint = fixture.store.receipt.RequestFingerprint
		}},
		{"unknown-policy-mode", func(_ *testing.T, fixture *runtimeBarrierAdmissionApplicationFixture) {
			fixture.store.receipt.Policy.Mode = "automatic"
		}},
		{"automatic-source-with-administrator-actor", func(_ *testing.T, fixture *runtimeBarrierAdmissionApplicationFixture) {
			fixture.store.receipt.Manual = false
			fixture.store.receipt.Policy.Mode = "auto"
		}},
		{"automatic-source-with-nonauto-policy", func(t *testing.T, fixture *runtimeBarrierAdmissionApplicationFixture) {
			fixture.store.receipt.Manual = false
			fixture.store.receipt.Command.ActorPrincipalID = "agent-controller"
			fixture.store.receipt.RequestFingerprint = runtimeBarrierManualAdmissionFingerprint(t, fixture.store.receipt.Command)
			fixture.store.state.Operation.RequestFingerprint = fixture.store.receipt.RequestFingerprint
		}},
		{"changed-cooldown", func(_ *testing.T, fixture *runtimeBarrierAdmissionApplicationFixture) {
			fixture.store.receipt.CooldownUntil = fixture.store.receipt.CooldownUntil.Add(time.Millisecond)
		}},
		{"missing-operation", func(_ *testing.T, fixture *runtimeBarrierAdmissionApplicationFixture) {
			fixture.store.replayFound = false
		}},
		{"operation-fingerprint", func(_ *testing.T, fixture *runtimeBarrierAdmissionApplicationFixture) {
			fixture.store.state.Operation.RequestFingerprint = strings.Repeat("c", 64)
		}},
		{"operation-runtime-revision", func(_ *testing.T, fixture *runtimeBarrierAdmissionApplicationFixture) {
			fixture.store.state.Operation.SourceRuntimeRevision = "rtv_other_original_runtime"
		}},
	}
	for _, scenario := range scenarios {
		t.Run(scenario.name, func(t *testing.T) {
			fixture := newRuntimeBarrierManualAdmissionFixture(t, "manual")
			fixture.store.receiptPresent = true
			scenario.edit(t, fixture)

			result, err := fixture.service.Admit(context.Background(), fixture.intent)

			require.ErrorIs(t, err, ErrQueryContract)
			require.Equal(t, RuntimeBarrierRecoveryAdmissionResult{}, result)
			require.Len(t, fixture.store.receiptKeys, 1)
			fixture.assertNoPreparation(t)
		})
	}
}

func TestRuntimeBarrierRecoveryManualAdmissionDoesNotReuseAnotherBarrierReceipt(t *testing.T) {
	for _, scenario := range []string{"wrong-receipt-returned", "tuple-miss"} {
		t.Run(scenario, func(t *testing.T) {
			fixture := newRuntimeBarrierManualAdmissionFixture(t, "manual")
			fixture.store.receiptPresent = true
			input := cloneRuntimeBarrierAdmissionApplicationIntent(fixture.intent)
			input.Fact.Barrier.BarrierID = "different-barrier"
			requestID, err := ports.RuntimeBarrierRecoveryRequestID(input.Fact.OrganizationID, input.Fact.AgentID, input.Fact.Barrier.BarrierID)
			require.NoError(t, err)
			input.Command.RequestID = requestID
			require.NotEqual(t, fixture.receipt.Command.RequestID, requestID)
			preparationError := errors.New("new tuple cannot prepare its target")
			if scenario == "tuple-miss" {
				fixture.store.reads = []runtimeBarrierAdmissionApplicationRead{{}, {}}
				fixture.specs.err = preparationError
			}

			result, err := fixture.service.Admit(context.Background(), input)

			require.Equal(t, RuntimeBarrierRecoveryAdmissionResult{}, result)
			require.Empty(t, fixture.store.replayKeys, "an old ordinary operation cannot stand in for this tuple")
			require.Zero(t, fixture.store.beginCalls)
			key := [3]string{input.Fact.OrganizationID, input.Fact.AgentID, input.Fact.Barrier.BarrierID}
			if scenario == "tuple-miss" {
				require.ErrorIs(t, err, preparationError)
				require.Equal(t, [][3]string{key, key}, fixture.store.receiptKeys)
				require.Equal(t, []string{"recovery.replay", "lifecycle.base", "recovery.replay"}, fixture.store.calls)
			} else {
				require.ErrorIs(t, err, ErrQueryContract)
				require.Equal(t, [][3]string{key}, fixture.store.receiptKeys)
				fixture.assertNoPreparation(t)
			}
		})
	}
}

func newRuntimeBarrierManualAdmissionFixture(t *testing.T, policyMode string) *runtimeBarrierAdmissionApplicationFixture {
	t.Helper()
	fixture := newRuntimeBarrierAdmissionApplicationFixture(t)
	fixture.intent.Manual = true
	fixture.intent.Command.ActorPrincipalID = "admin-1"
	fixture.receipt.Manual = true
	fixture.receipt.Command = fixture.intent.Command
	fixture.receipt.Policy.Mode = policyMode
	fixture.receipt.RequestFingerprint = runtimeBarrierManualAdmissionFingerprint(t, fixture.receipt.Command)
	fixture.store.receipt = cloneRuntimeBarrierAdmissionApplicationReceipt(fixture.receipt)
	fixture.store.state = fixture.originalState(t, domain.OperationCompleted)
	return fixture
}

func runtimeBarrierManualAdmissionFingerprint(t *testing.T, command ports.RuntimeBarrierRebuildCommand) string {
	t.Helper()
	// Manual is an internal admission choice, outside the unchanged six-field
	// lifecycle fingerprint. These unit fakes do not prove HTTP authorization.
	payload, err := json.Marshal(struct {
		RequestID        string
		OrganizationID   string
		ActorPrincipalID string
		AgentID          string
		TemplateID       string
		TemplateRevision int64
	}{command.RequestID, command.OrganizationID, command.ActorPrincipalID, command.AgentID, command.TemplateID, command.TemplateRevision})
	require.NoError(t, err)
	digest := sha256.Sum256(payload)
	return hex.EncodeToString(digest[:])
}
