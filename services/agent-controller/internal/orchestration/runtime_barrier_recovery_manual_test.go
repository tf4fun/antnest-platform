package orchestration

import (
	"testing"

	"github.com/stretchr/testify/require"
	enums "go.temporal.io/api/enums/v1"
	"go.temporal.io/api/serviceerror"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func TestRuntimeBarrierRecoveryManualWorkflowCommandPreservesOriginalAdministrator(t *testing.T) {
	for _, mode := range []string{"manual", "notify", "auto"} {
		t.Run(mode, func(t *testing.T) {
			fixture := newRuntimeBarrierRecoveryManualStartFixture(t, mode)
			original := cloneRuntimeBarrierRecoveryStartReceipt(fixture.receipt)

			command, err := runtimeBarrierRecoveryWorkflowCommand(fixture.receipt)

			require.NoError(t, err)
			require.Equal(t, fixture.command, command)
			require.Equal(t, "admin-1", command.ActorPrincipalID)
			require.Equal(t, original, fixture.receipt)
			require.Empty(t, fixture.client.snapshot().calls, "decoding the durable command does not dispatch it")
		})
	}
}

func TestRuntimeBarrierRecoveryManualEnsureStartUsesOriginalAdministrator(t *testing.T) {
	for _, mode := range []string{"manual", "notify", "auto"} {
		for _, already := range []bool{false, true} {
			name := mode + "/running"
			if already {
				name = mode + "/closed"
			}
			t.Run(name, func(t *testing.T) {
				fixture := newRuntimeBarrierRecoveryManualStartFixture(t, mode)
				if already {
					fixture.client.startErr = serviceerror.NewWorkflowExecutionAlreadyStarted("already started", "original-start", fixture.runID)
					fixture.client.description.WorkflowExecutionInfo.Status = enums.WORKFLOW_EXECUTION_STATUS_COMPLETED
				}
				original := cloneRuntimeBarrierRecoveryStartReceipt(fixture.receipt)

				err := fixture.service.EnsureRuntimeBarrierRecoveryStarted(t.Context(), fixture.receipt)

				require.NoError(t, err)
				require.Equal(t, original, fixture.receipt)
				require.True(t, fixture.receipt.Manual)
				require.Equal(t, "admin-1", fixture.command.ActorPrincipalID)
				fixture.assertEngineIdentity(t)
				require.Equal(t, []string{"execute", "describe", "history", "history.next"}, fixture.client.snapshot().calls)
			})
		}
	}
}

func TestRuntimeBarrierRecoveryManualEnsureStartKeepsReceiptSourceValidation(t *testing.T) {
	scenarios := []struct {
		name   string
		change func(*ports.RuntimeBarrierRecoveryReceipt)
	}{
		{"automatic-source-with-administrator-actor", func(receipt *ports.RuntimeBarrierRecoveryReceipt) {
			receipt.Manual = false
		}},
		{"automatic-source-with-manual-policy", func(receipt *ports.RuntimeBarrierRecoveryReceipt) {
			receipt.Manual = false
			receipt.Command.ActorPrincipalID = "agent-controller"
			receipt.Policy.Mode = "manual"
			receipt.RequestFingerprint = runtimeBarrierRecoveryStartFingerprint(receipt.Command)
		}},
		{"automatic-source-with-notify-policy", func(receipt *ports.RuntimeBarrierRecoveryReceipt) {
			receipt.Manual = false
			receipt.Command.ActorPrincipalID = "agent-controller"
			receipt.Policy.Mode = "notify"
			receipt.RequestFingerprint = runtimeBarrierRecoveryStartFingerprint(receipt.Command)
		}},
		{"manual-source-with-missing-actor", func(receipt *ports.RuntimeBarrierRecoveryReceipt) {
			receipt.Command.ActorPrincipalID = ""
			receipt.RequestFingerprint = runtimeBarrierRecoveryStartFingerprint(receipt.Command)
		}},
		{"manual-source-with-invalid-actor", func(receipt *ports.RuntimeBarrierRecoveryReceipt) {
			receipt.Command.ActorPrincipalID = "admin/1"
			receipt.RequestFingerprint = runtimeBarrierRecoveryStartFingerprint(receipt.Command)
		}},
		{"manual-source-with-wrong-fingerprint", func(receipt *ports.RuntimeBarrierRecoveryReceipt) {
			receipt.RequestFingerprint = "invalid-fingerprint"
		}},
		{"manual-source-with-changed-cooldown", func(receipt *ports.RuntimeBarrierRecoveryReceipt) {
			receipt.CooldownUntil = receipt.AcceptedAt
		}},
	}
	for _, scenario := range scenarios {
		t.Run(scenario.name, func(t *testing.T) {
			fixture := newRuntimeBarrierRecoveryManualStartFixture(t, "auto")
			receipt := cloneRuntimeBarrierRecoveryStartReceipt(fixture.receipt)
			scenario.change(&receipt)

			command, err := runtimeBarrierRecoveryWorkflowCommand(receipt)

			require.ErrorIs(t, err, ports.ErrInvalidRuntimeBarrierRecovery)
			require.Equal(t, application.LifecycleCommand{}, command)
			err = fixture.service.EnsureRuntimeBarrierRecoveryStarted(t.Context(), receipt)
			require.ErrorIs(t, err, ports.ErrInvalidRuntimeBarrierRecovery)
			require.Empty(t, fixture.client.snapshot().calls, "invalid source metadata must fail before any Temporal call")
		})
	}
}

func newRuntimeBarrierRecoveryManualStartFixture(t *testing.T, policyMode string) *runtimeBarrierRecoveryStartFixture {
	t.Helper()
	fixture := newRuntimeBarrierRecoveryStartFixture(t)
	fixture.receipt.Manual = true
	fixture.receipt.Command.ActorPrincipalID = "admin-1"
	fixture.receipt.Policy.Mode = policyMode
	// The existing helper independently encodes only the original six fields;
	// the persisted source flag and policy never enter the lifecycle hash.
	fixture.receipt.RequestFingerprint = runtimeBarrierRecoveryStartFingerprint(fixture.receipt.Command)
	fixture.command.ActorPrincipalID = "admin-1"
	fixture.started().Input = runtimeBarrierRecoveryStartPayloads(t, fixture.command)
	return fixture
}
