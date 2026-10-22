package postgres

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func runtimeBarrierAdmissionGuardInput(original ports.BeginAgentRebuild) ports.BeginAgentRebuild {
	input := original
	intent := *original.Recovery
	fact := intent.Fact
	barrier := *fact.Barrier
	fact.Barrier = &barrier
	intent.Fact = fact
	input.Recovery = &intent
	return input
}

func assertRuntimeBarrierAdmissionGuardRejects(t *testing.T, ctx context.Context, store *Repository, input ports.BeginAgentRebuild) {
	t.Helper()
	before := runtimeBarrierAdmissionSnapshot(t, ctx, store)
	state, replayed, err := store.BeginAgentRebuild(ctx, input)
	after := runtimeBarrierAdmissionSnapshot(t, ctx, store)
	// Report all admission and persistence failures independently. In particular,
	// an unexpectedly successful admission must not skip the real SQL comparison.
	assert.Error(t, err)
	assert.Equal(t, ports.AgentRebuildState{}, state, "rejected admission cannot return a partial lifecycle state")
	assert.False(t, replayed, "an unaccepted observation is not an original receipt replay")
	assert.Equal(t, before, after, "rejected recovery cannot change lifecycle, journal, publication, policy, receipt, cooldown or pending-start rows")
}

func TestRuntimeBarrierRecoveryAdmissionRejectsChangedObservationOrCommand(t *testing.T) {
	for _, test := range []struct {
		name   string
		change func(*ports.BeginAgentRebuild)
	}{
		{"expected policy revision", func(input *ports.BeginAgentRebuild) {
			input.Recovery.ExpectedPolicyRevision++
		}},
		{"expected owner user", func(input *ports.BeginAgentRebuild) {
			input.Recovery.ExpectedOwnerUserID = "different-owner"
		}},
		{"expected owner authorization sequence", func(input *ports.BeginAgentRebuild) {
			input.Recovery.ExpectedOwnerAuthorizationSequence++
		}},
		{"expected identity revocation sequence", func(input *ports.BeginAgentRebuild) {
			input.Recovery.ExpectedIdentityRevocationSequence++
		}},
		{"fact organization", func(input *ports.BeginAgentRebuild) {
			input.Recovery.Fact.OrganizationID = "another-organization"
		}},
		{"fact Agent", func(input *ports.BeginAgentRebuild) {
			input.Recovery.Fact.AgentID = "another-agent"
		}},
		{"fact Runtime", func(input *ports.BeginAgentRebuild) {
			input.Recovery.Fact.RuntimeRevision = "another-runtime-revision"
		}},
		{"null barrier", func(input *ports.BeginAgentRebuild) {
			input.Recovery.Fact.Barrier = nil
		}},
		{"barrier reason", func(input *ports.BeginAgentRebuild) {
			input.Recovery.Fact.Barrier.Reason = "runtime_missing"
		}},
		{"command request", func(input *ports.BeginAgentRebuild) {
			input.Recovery.Command.RequestID = "another-valid-rebuild-request"
		}},
		{"command organization", func(input *ports.BeginAgentRebuild) {
			input.Recovery.Command.OrganizationID = "another-organization"
		}},
		{"command Agent", func(input *ports.BeginAgentRebuild) {
			input.Recovery.Command.AgentID = "another-agent"
		}},
		{"command actor", func(input *ports.BeginAgentRebuild) {
			input.Recovery.Command.ActorPrincipalID = "another-controller-actor"
		}},
		{"command Template", func(input *ports.BeginAgentRebuild) {
			input.Recovery.Command.TemplateID = "another-template"
		}},
		{"command Template revision", func(input *ports.BeginAgentRebuild) {
			input.Recovery.Command.TemplateRevision++
		}},
		{"operation fingerprint does not match command", func(input *ports.BeginAgentRebuild) {
			prefix := "0"
			if input.Operation.RequestFingerprint[0] == '0' {
				prefix = "1"
			}
			input.Operation.RequestFingerprint = prefix + input.Operation.RequestFingerprint[1:]
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx := runtimeBarrierPolicyTestContext(t)
			fixture := runtimeBarrierAdmissionSeed(t, ctx, "guarded-observation-barrier", "original-protected-execution")
			input := runtimeBarrierAdmissionGuardInput(fixture.begin)
			test.change(&input)
			assertRuntimeBarrierAdmissionGuardRejects(t, ctx, fixture.store, input)
		})
	}
}

func TestRuntimeBarrierRecoveryAdmissionRechecksChangedPolicy(t *testing.T) {
	for _, test := range []struct {
		name               string
		mode               string
		useCurrentRevision bool
	}{
		{"manual policy with stale observation", "manual", false},
		{"notify policy with stale observation", "notify", false},
		{"new auto policy with stale observation", "auto", false},
		{"manual policy with current revision", "manual", true},
		{"notify policy with current revision", "notify", true},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx := runtimeBarrierPolicyTestContext(t)
			fixture := runtimeBarrierAdmissionSeed(t, ctx, "policy-observed-barrier", "original-protected-execution")
			input := runtimeBarrierAdmissionGuardInput(fixture.begin)
			changed, err := fixture.store.SetRuntimeBarrierRecoveryPolicy(ctx, runtimeBarrierPolicyTestInput(
				fixture.base.Agent.OrganizationID, "policy-after-observation", fixture.policy.Revision, test.mode, 60000,
			))
			require.NoError(t, err)
			require.Equal(t, fixture.policy.Revision+1, changed.Revision)
			require.Equal(t, test.mode, changed.Mode)
			if test.useCurrentRevision {
				input.Recovery.ExpectedPolicyRevision = changed.Revision
			} else {
				require.NotEqual(t, changed.Revision, input.Recovery.ExpectedPolicyRevision)
			}
			assertRuntimeBarrierAdmissionGuardRejects(t, ctx, fixture.store, input)
			current, err := fixture.store.GetRuntimeBarrierRecoveryPolicy(ctx, fixture.base.Agent.OrganizationID)
			require.NoError(t, err)
			require.Equal(t, changed, current, "rejection cannot undo the intervening policy mutation")
		})
	}
}
