package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func runtimeBarrierAdmissionStateSnapshot(t *testing.T, ctx context.Context, store *Repository) map[string]string {
	t.Helper()
	snapshot := runtimeBarrierAdmissionSnapshot(t, ctx, store)
	for _, table := range []string{
		"agent_access_bindings", "identity_revocation_cursor", "owner_revocations", "catalog_requests",
	} {
		var value string
		query := `SELECT COALESCE(jsonb_agg(to_jsonb(resource) ORDER BY to_jsonb(resource)::text),'[]'::jsonb)::text FROM ` +
			pgx.Identifier{"agent_controller", table}.Sanitize() + ` resource`
		require.NoError(t, store.pool.QueryRow(ctx, query).Scan(&value))
		snapshot[table] = value
	}
	return snapshot
}

func assertRuntimeBarrierAdmissionStateRejects(t *testing.T, ctx context.Context, store *Repository, input ports.BeginAgentRebuild) {
	t.Helper()
	before := runtimeBarrierAdmissionStateSnapshot(t, ctx, store)
	beforeCounts := readRuntimeBarrierAdmissionCounts(t, ctx, store, input.AgentID)
	require.Zero(t, beforeCounts.receipts)
	require.Zero(t, beforeCounts.cooldowns)
	require.Zero(t, beforeCounts.starts)
	state, replayed, err := store.BeginAgentRebuild(ctx, input)
	after := runtimeBarrierAdmissionStateSnapshot(t, ctx, store)
	afterCounts := readRuntimeBarrierAdmissionCounts(t, ctx, store, input.AgentID)
	// Check every durable outcome even if an implementation unexpectedly admits
	// the request. An input-validation error is not the configured-state guard.
	assert.ErrorIs(t, err, ports.ErrConcurrentChange)
	assert.NotErrorIs(t, err, ports.ErrInvalidRuntimeBarrierRecovery)
	assert.Equal(t, ports.AgentRebuildState{}, state)
	assert.False(t, replayed)
	assert.Equal(t, before, after, "rejected admission must preserve the actual intervening state and all durable rows")
	assert.Equal(t, beforeCounts, afterCounts)
	assert.Zero(t, afterCounts.receipts)
	assert.Zero(t, afterCounts.cooldowns)
	assert.Zero(t, afterCounts.starts)
}

func TestRuntimeBarrierRecoveryAdmissionRejectsActualStoredStateChanges(t *testing.T) {
	for _, test := range []struct {
		name   string
		change func(*testing.T, context.Context, runtimeBarrierAdmissionFixture)
	}{
		{
			name: "owner binding is inactive",
			change: func(t *testing.T, ctx context.Context, fixture runtimeBarrierAdmissionFixture) {
				// There is no independent binding-deactivation repository API.
				// This fixture-only update simulates exactly the current binding's
				// inactive state, without manufacturing another Agent lifecycle.
				result, err := fixture.store.pool.Exec(ctx, `UPDATE agent_controller.agent_access_bindings
SET active=false, updated_at=clock_timestamp()
WHERE agent_id=$1 AND principal_id=$2 AND access_revision=$3 AND active`,
					fixture.base.Agent.AgentID, fixture.base.Agent.OwnerUserID, fixture.base.Agent.AccessRevision)
				require.NoError(t, err)
				require.EqualValues(t, 1, result.RowsAffected())
				current, err := fixture.store.GetAgentLifecycleBase(ctx, fixture.base.Agent.AgentID)
				require.NoError(t, err)
				expected := fixture.base.Agent
				require.NotNil(t, expected.Readiness)
				readiness := *expected.Readiness
				readiness.Access.Active = false
				expected.Readiness = &readiness
				require.Equal(t, expected, current.Agent, "binding fixture must leave Agent state and CAS unchanged")
				require.Equal(t, "unavailable", current.Agent.CurrentReadiness())
				var active bool
				require.NoError(t, fixture.store.pool.QueryRow(ctx, `SELECT active
FROM agent_controller.agent_access_bindings WHERE agent_id=$1 AND principal_id=$2 AND access_revision=$3`,
					fixture.base.Agent.AgentID, fixture.base.Agent.OwnerUserID, fixture.base.Agent.AccessRevision).Scan(&active))
				require.False(t, active)
			},
		},
		{
			name: "Identity revocation was received",
			change: func(t *testing.T, ctx context.Context, fixture runtimeBarrierAdmissionFixture) {
				cursor, err := fixture.store.GetIdentityRevocationCursor(ctx)
				require.NoError(t, err)
				event := ports.PrincipalRevocation{
					Sequence: cursor + 1, UserID: fixture.base.Agent.OwnerUserID,
					OrganizationID: fixture.base.Agent.OrganizationID, Reason: "membership_deactivated",
					OccurredAt: time.Now().UTC().Truncate(time.Microsecond),
				}
				require.Greater(t, event.Sequence, fixture.base.Agent.OwnerAuthorizationSequence)
				require.NoError(t, fixture.store.ApplyIdentityRevocation(ctx, cursor, event, ""))
				current, err := fixture.store.GetAgentLifecycleBase(ctx, fixture.base.Agent.AgentID)
				require.NoError(t, err)
				require.True(t, current.Agent.IdentityRevoked())
				require.Equal(t, event.Sequence, current.Agent.IdentityRevocationSequence)
				require.Equal(t, domain.DesiredDisabled, current.Agent.DesiredState)
			},
		},
		{
			name: "Disable already began",
			change: func(t *testing.T, ctx context.Context, fixture runtimeBarrierAdmissionFixture) {
				input := disableBegin(fixture.base, "recovery-guard-existing-disable", strings.Repeat("4", 64),
					time.Now().UTC().Truncate(time.Microsecond))
				state, replayed, err := fixture.store.BeginAgentDisable(ctx, input)
				require.NoError(t, err)
				require.False(t, replayed)
				require.Equal(t, domain.DesiredDisabled, state.Agent.DesiredState)
				require.Equal(t, input.Operation.RequestID, state.Agent.ActiveOperationRequestID)
				require.Equal(t, domain.OperationRunning, state.Operation.State)
				require.Equal(t, domain.PhaseDrain, state.Operation.Phase)
			},
		},
		{
			name: "Delete already began",
			change: func(t *testing.T, ctx context.Context, fixture runtimeBarrierAdmissionFixture) {
				input := deleteBegin(fixture.base.Agent, "recovery-guard-existing-delete", strings.Repeat("d", 64),
					time.Now().UTC().Truncate(time.Microsecond))
				state, replayed, err := fixture.store.BeginAgentDelete(ctx, input)
				require.NoError(t, err)
				require.False(t, replayed)
				require.Equal(t, domain.DesiredDeleted, state.Agent.DesiredState)
				require.Equal(t, input.Operation.RequestID, state.Agent.ActiveOperationRequestID)
				require.Equal(t, domain.OperationRunning, state.Operation.State)
				require.Equal(t, domain.PhaseDrain, state.Operation.Phase)
			},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx := runtimeBarrierPolicyTestContext(t)
			fixture := runtimeBarrierAdmissionSeed(t, ctx, "stored-state-barrier", "original-protected-execution")
			// Freeze the observation before the actual intervening state change.
			input := runtimeBarrierAdmissionGuardInput(fixture.begin)
			test.change(t, ctx, fixture)
			assertRuntimeBarrierAdmissionStateRejects(t, ctx, fixture.store, input)
		})
	}
}

func TestRuntimeBarrierRecoveryAdmissionRejectsCompleteOtherTemplateTarget(t *testing.T) {
	ctx := runtimeBarrierPolicyTestContext(t)
	fixture := runtimeBarrierAdmissionSeed(t, ctx, "configured-template-barrier", "original-protected-execution")
	input := runtimeBarrierAdmissionGuardInput(fixture.begin)
	configured := fixture.seed.Revision.Snapshot()
	const otherTemplateID = "template_recovery_guard_other"
	revision, err := domain.NewTemplateRevision(domain.TemplateRevisionInput{
		TemplateID: otherTemplateID, OrganizationID: configured.OrganizationID, Revision: 1,
		ModelProfileID: configured.ModelProfileID, FallbackModelProfileIDs: configured.FallbackModelProfileIDs,
		SystemPrompt: configured.SystemPrompt, MaxModelRequests: configured.MaxModelRequests,
		Runtime: configured.Runtime, ContextPolicyVersion: configured.ContextPolicyVersion,
		SkillRefs: configured.SkillRefs, SkillSetDigest: configured.SkillSetDigest,
	})
	require.NoError(t, err)
	now := time.Now().UTC().Truncate(time.Microsecond)
	other, err := fixture.store.PutTemplate(ctx, ports.TemplateRecord{
		RequestID: "recovery-guard-create-other-template", RequestFingerprint: strings.Repeat("e", 64),
		TemplateID: otherTemplateID, OrganizationID: configured.OrganizationID,
		TemplateKey: "recovery-guard-other-template", Name: "Other recovery guard Template",
		Revision: revision, Enabled: true, CreatedAt: now, UpdatedAt: now,
	})
	require.NoError(t, err)
	require.True(t, other.Enabled)
	require.NotEqual(t, configured.TemplateID, other.TemplateID)
	target, err := domain.MaterializeAgentSpec(other.Revision, fixture.seed.Model.Revision)
	require.NoError(t, err)
	digest, err := target.Digest()
	require.NoError(t, err)
	input.Recovery.Command.TemplateID = other.TemplateID
	input.Recovery.Command.TemplateRevision = other.Revision.Revision()
	command := input.Recovery.Command
	// Compute the unchanged six-field lifecycle fingerprint independently of
	// the production recovery validator, rather than leaving a stale digest.
	payload, err := json.Marshal(struct {
		RequestID        string
		OrganizationID   string
		ActorPrincipalID string
		AgentID          string
		TemplateID       string
		TemplateRevision int64
	}{command.RequestID, command.OrganizationID, command.ActorPrincipalID, command.AgentID, command.TemplateID, command.TemplateRevision})
	require.NoError(t, err)
	fingerprint := sha256.Sum256(payload)
	input.Operation.RequestFingerprint = hex.EncodeToString(fingerprint[:])
	input.TargetSpec.Snapshot, input.TargetSpec.CanonicalDigest = target.Snapshot(), digest
	input.RequestedEvent.Data = make(map[string]any, len(fixture.begin.RequestedEvent.Data))
	for key, value := range fixture.begin.RequestedEvent.Data {
		input.RequestedEvent.Data[key] = value
	}
	input.RequestedEvent.Data["template_id"] = command.TemplateID
	input.RequestedEvent.Data["template_revision"] = command.TemplateRevision
	require.Equal(t, command.TemplateID, input.TargetSpec.Snapshot.TemplateID)
	require.Equal(t, command.TemplateRevision, input.TargetSpec.Snapshot.TemplateRevision)
	require.NotEqual(t, fixture.begin.Operation.RequestFingerprint, input.Operation.RequestFingerprint)
	require.NoError(t, validateRuntimeBarrierRecovery(input), "the complete command must pass input validation before its configured-Template guard")
	current, err := fixture.store.GetAgentLifecycleBase(ctx, fixture.base.Agent.AgentID)
	require.NoError(t, err)
	require.Equal(t, fixture.base.Agent, current.Agent)
	require.Equal(t, configured.TemplateID, current.ConfiguredSpec.Snapshot.TemplateID)
	assertRuntimeBarrierAdmissionStateRejects(t, ctx, fixture.store, input)
}
