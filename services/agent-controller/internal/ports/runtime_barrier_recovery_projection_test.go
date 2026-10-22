package ports

import (
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
)

func TestRuntimeBarrierProjectionIdentityAndValidation(t *testing.T) {
	const barrier = "original-\x00-e\u0301-🧪"
	requestID, err := RuntimeBarrierRecoveryRequestID("org-1", "agent-1", barrier)
	require.NoError(t, err)
	notificationID, err := RuntimeBarrierNotificationID("org-1", "agent-1", barrier)
	require.NoError(t, err)
	require.True(t, domain.ValidRuntimeBarrierPolicyIdentifier(notificationID))
	require.NotEqual(t, requestID, notificationID)
	again, err := RuntimeBarrierNotificationID("org-1", "agent-1", barrier)
	require.NoError(t, err)
	require.Equal(t, notificationID, again)
	for _, tuple := range [][3]string{{"org-2", "agent-1", barrier}, {"org-1", "agent-2", barrier}, {"org-1", "agent-1", "original-\x00-é-🧪"}} {
		other, err := RuntimeBarrierNotificationID(tuple[0], tuple[1], tuple[2])
		require.NoError(t, err)
		require.NotEqual(t, notificationID, other)
	}
	projection := RuntimeBarrierRecoveryProjection{BarrierID: barrier, Reason: ExecutionRuntimeBarrierRequired,
		RuntimeRevision: "runtime-1", Mode: "manual", CooldownMS: 300000,
		RebuildRequestID: requestID, NotificationID: notificationID}
	require.NoError(t, projection.Validate("org-1", "agent-1"))
	for _, mutate := range []struct {
		name  string
		apply func(*RuntimeBarrierRecoveryProjection)
	}{
		{"empty barrier", func(p *RuntimeBarrierRecoveryProjection) { p.BarrierID = "" }},
		{"oversized barrier", func(p *RuntimeBarrierRecoveryProjection) { p.BarrierID = strings.Repeat("x", 201) }},
		{"wrong reason", func(p *RuntimeBarrierRecoveryProjection) { p.Reason = "safe" }},
		{"invalid runtime", func(p *RuntimeBarrierRecoveryProjection) { p.RuntimeRevision = "bad runtime" }},
		{"wrong request", func(p *RuntimeBarrierRecoveryProjection) { p.RebuildRequestID = "unrelated" }},
		{"wrong notification", func(p *RuntimeBarrierRecoveryProjection) { p.NotificationID = "unrelated" }},
		{"invalid mode", func(p *RuntimeBarrierRecoveryProjection) { p.Mode = "other" }},
		{"negative policy", func(p *RuntimeBarrierRecoveryProjection) { p.PolicyRevision = -1 }},
		{"invented default auto", func(p *RuntimeBarrierRecoveryProjection) { p.Mode = "auto" }},
		{"invalid cooldown", func(p *RuntimeBarrierRecoveryProjection) { p.CooldownMS = 1 }},
		{"zero deadline", func(p *RuntimeBarrierRecoveryProjection) { p.CooldownUntil = new(time.Time) }},
	} {
		t.Run(mutate.name, func(t *testing.T) {
			bad := projection
			mutate.apply(&bad)
			require.Error(t, bad.Validate("org-1", "agent-1"))
		})
	}
	for _, mode := range []string{"manual", "notify", "auto"} {
		accepted := projection
		accepted.Mode = mode
		accepted.PolicyRevision = 1
		deadline := time.Date(2026, 10, 23, 0, 0, 0, 0, time.UTC)
		accepted.CooldownUntil = &deadline
		require.NoError(t, accepted.Validate("org-1", "agent-1"))
	}
}

func TestRuntimeBarrierObservationInputRequiresCurrentScopedSource(t *testing.T) {
	agent := AgentRecord{AgentID: "agent-1", OrganizationID: "org-1", OwnerUserID: "owner-1",
		AccessRevision: "access-1", AgentSpecRevisionID: "spec-1", RuntimeRevision: "runtime-1",
		DesiredState: domain.DesiredEnabled, LifecycleState: domain.AgentCreated, ActivationState: domain.ActivationEnabled}
	fact := RuntimeBarrierResult{OrganizationID: agent.OrganizationID, AgentID: agent.AgentID, RuntimeRevision: agent.RuntimeRevision,
		Barrier: &RuntimeBarrier{BarrierID: "original-\x00", RuntimeExecutionID: "old-\x00-execution", Reason: ExecutionRuntimeBarrierRequired}}
	input := RecordRuntimeBarrierObservation{Fact: fact, ExpectedAgent: agent, ExpectedPolicyRevision: 0, ExpectedObservationRevision: 0}
	require.NoError(t, input.Validate())
	null := input
	null.Fact.Barrier = nil
	require.NoError(t, null.Validate(), "an authenticated successful null can clear an existing observation")
	for _, mutate := range []struct {
		name  string
		apply func(*RecordRuntimeBarrierObservation)
	}{
		{"foreign organization", func(p *RecordRuntimeBarrierObservation) { p.Fact.OrganizationID = "other-org" }},
		{"foreign Agent", func(p *RecordRuntimeBarrierObservation) { p.Fact.AgentID = "other-agent" }},
		{"foreign Runtime", func(p *RecordRuntimeBarrierObservation) { p.Fact.RuntimeRevision = "other-runtime" }},
		{"missing owner", func(p *RecordRuntimeBarrierObservation) { p.ExpectedAgent.OwnerUserID = "" }},
		{"missing access", func(p *RecordRuntimeBarrierObservation) { p.ExpectedAgent.AccessRevision = "" }},
		{"missing spec", func(p *RecordRuntimeBarrierObservation) { p.ExpectedAgent.AgentSpecRevisionID = "" }},
		{"negative owner sequence", func(p *RecordRuntimeBarrierObservation) { p.ExpectedAgent.OwnerAuthorizationSequence = -1 }},
		{"negative revocation sequence", func(p *RecordRuntimeBarrierObservation) { p.ExpectedAgent.IdentityRevocationSequence = -1 }},
		{"revoked", func(p *RecordRuntimeBarrierObservation) { p.ExpectedAgent.IdentityRevocationSequence = 1 }},
		{"active operation", func(p *RecordRuntimeBarrierObservation) { p.ExpectedAgent.ActiveOperationRequestID = "operation-1" }},
		{"negative policy", func(p *RecordRuntimeBarrierObservation) { p.ExpectedPolicyRevision = -1 }},
		{"negative observation", func(p *RecordRuntimeBarrierObservation) { p.ExpectedObservationRevision = -1 }},
	} {
		t.Run(mutate.name, func(t *testing.T) {
			bad := input
			mutate.apply(&bad)
			require.Error(t, bad.Validate())
		})
	}
}
