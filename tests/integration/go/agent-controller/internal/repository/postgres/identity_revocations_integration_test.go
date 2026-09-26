package postgres

import (
	"context"
	"errors"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func identityTestRepository(t *testing.T) (*Repository, ports.AgentLifecycleBase) {
	t.Helper()
	dsn := os.Getenv("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL is not set")
	}
	repository, err := Open(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(repository.Close)
	base, _ := seedAvailableAgentForRebuild(t, context.Background(), repository)
	return repository, base
}

func TestIdentityRevocationPersistsFenceAndDeduplicates(t *testing.T) {
	repository, base := identityTestRepository(t)
	ctx := context.Background()
	event := ports.PrincipalRevocation{Sequence: 5, UserID: base.Agent.OwnerUserID,
		OrganizationID: base.Agent.OrganizationID, Reason: "membership_deactivated", OccurredAt: time.Now().UTC()}
	for range 2 {
		if err := repository.ApplyIdentityRevocation(ctx, 0, event, ""); err != nil {
			t.Fatal(err)
		}
	}
	agent, err := loadAgentRecord(ctx, repository.pool, base.Agent.AgentID)
	if err != nil || !agent.IdentityRevoked() {
		t.Fatalf("agent=%+v err=%v", agent, err)
	}
	if agent.LifecycleState != domain.AgentCreated || agent.ActivationState != domain.ActivationEnabled || agent.RuntimeState != domain.RuntimeAvailable {
		t.Fatalf("receipt fabricated shutdown: %+v", agent)
	}
	workspace, err := repository.ListWorkspaceAgents(ctx, ports.WorkspaceAgentQuery{OrganizationID: agent.OrganizationID, PrincipalID: agent.OwnerUserID, Limit: 10})
	if err != nil || len(workspace) != 0 {
		t.Fatalf("revoked owner still discovers Agent metadata: %+v %v", workspace, err)
	}
	assertExecutionClosed(t, repository, agent)
	if len(publishedAgent(t, repository, agent).PrincipalIDs) != 0 {
		t.Fatal("revoked owner still published")
	}
	cursor, err := repository.GetIdentityRevocationCursor(ctx)
	if err != nil || cursor != 5 {
		t.Fatalf("cursor=%d err=%v", cursor, err)
	}
	var count int
	if err := repository.pool.QueryRow(ctx, "SELECT count(*) FROM agent_controller.agent_events WHERE event_type = 'agent_owner_revoked'").Scan(&count); err != nil || count != 1 {
		t.Fatalf("events=%d err=%v", count, err)
	}
	var eventID string
	if err := repository.pool.QueryRow(ctx, "SELECT event_id FROM agent_controller.agent_events WHERE event_type = 'agent_owner_revoked'").Scan(&eventID); err != nil {
		t.Fatal(err)
	}
	if !regexp.MustCompile(`^event_[0-9a-f]{32}$`).MatchString(eventID) {
		t.Fatalf("revocation event ID = %q", eventID)
	}
	// Reopening the repository simulates a consumer restart without its in-memory scan cursor.
	other, err := Open(ctx, os.Getenv("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	pending, err := other.ListPendingOwnerRevocations(ctx, "", 10)
	if err != nil || len(pending) != 1 || pending[0].AgentID != agent.AgentID {
		t.Fatalf("pending=%+v err=%v", pending, err)
	}
}

func TestIdentityRevocationScopesAndLateCreate(t *testing.T) {
	repository, base := identityTestRepository(t)
	ctx := context.Background()
	input := identityCreate(base, "before-org-integration", base.Agent.OrganizationID, 0)
	if _, _, err := repository.BeginAgentCreate(ctx, input); err != nil {
		t.Fatal(err)
	}
	otherAgent := seedExecutionAgentInOrganization(t, repository, base, "org-other")
	event := ports.PrincipalRevocation{Sequence: 5, UserID: base.Agent.OwnerUserID,
		OrganizationID: base.Agent.OrganizationID, Reason: "membership_deleted", OccurredAt: time.Now().UTC()}
	if err := repository.ApplyIdentityRevocation(ctx, 0, event, ""); err != nil {
		t.Fatal(err)
	}
	late := identityCreate(base, "late-create", base.Agent.OrganizationID, 0)
	if _, _, err := repository.BeginAgentCreate(ctx, late); !errors.Is(err, ports.ErrConcurrentChange) {
		t.Fatalf("late create escaped: %v", err)
	}
	restored := identityCreate(base, "restored-create", base.Agent.OrganizationID, 5)
	if _, _, err := repository.BeginAgentCreate(ctx, restored); err != nil {
		t.Fatalf("explicit restored create: %v", err)
	}
	for _, test := range []struct {
		id      string
		revoked bool
	}{
		{"before-org-integration", true}, {otherAgent.AgentID, false}, {"restored-create", false},
	} {
		agent, err := loadAgentRecord(ctx, repository.pool, test.id)
		if err != nil || agent.IdentityRevoked() != test.revoked {
			t.Fatalf("agent=%+v err=%v", agent, err)
		}
	}
	event.Sequence, event.OrganizationID, event.Reason = 9, "", "user_deactivated"
	if err := repository.ApplyIdentityRevocation(ctx, 5, event, ""); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{otherAgent.AgentID, "restored-create"} {
		agent, err := loadAgentRecord(ctx, repository.pool, id)
		if err != nil || !agent.IdentityRevoked() {
			t.Fatalf("global revocation missed %s: %+v %v", id, agent, err)
		}
	}
}

func TestIdentityRevocationCursorAndAgentFenceRollbackTogether(t *testing.T) {
	repository, base := identityTestRepository(t)
	ctx := context.Background()
	// Duplicate the derived event ID to force failure after the scope/fence writes.
	if _, err := repository.pool.Exec(ctx, `UPDATE agent_controller.agent_events SET event_id=$1 WHERE event_type='agent_ready'`, domain.DeriveResourceID("event", "identity-revocation", "5\x00"+base.Agent.AgentID)); err != nil {
		t.Fatal(err)
	}
	event := ports.PrincipalRevocation{Sequence: 5, UserID: base.Agent.OwnerUserID, Reason: "user_deactivated", OccurredAt: time.Now().UTC()}
	var databaseError *pgconn.PgError
	if err := repository.ApplyIdentityRevocation(ctx, 0, event, ""); !errors.As(err, &databaseError) || databaseError.Code != "23505" || databaseError.ConstraintName != "agent_events_event_id_key" {
		t.Fatalf("expected duplicate audit event failure, got %v", err)
	}
	agent, err := loadAgentRecord(ctx, repository.pool, base.Agent.AgentID)
	if err != nil || agent.IdentityRevoked() {
		t.Fatalf("partial fence: %+v %v", agent, err)
	}
	cursor, err := repository.GetIdentityRevocationCursor(ctx)
	if err != nil || cursor != 0 {
		t.Fatalf("partial cursor: %d %v", cursor, err)
	}
}

func identityCreate(base ports.AgentLifecycleBase, id, org string, authorization int64) ports.BeginAgentCreate {
	now := time.Now().UTC()
	spec := base.ConfiguredSpec
	spec.ID, spec.AgentID, spec.Revision = "spec-"+id, id, 1
	return ports.BeginAgentCreate{
		Agent: ports.AgentRecord{AgentID: id, OrganizationID: org, OwnerUserID: base.Agent.OwnerUserID,
			Name: id, DesiredState: domain.DesiredEnabled, LifecycleState: domain.AgentCreated, ActivationState: domain.ActivationEnabled, RuntimeState: domain.RuntimeUnknown,
			AccessRevision: "access-" + id, ActiveOperationRequestID: "request-" + id, AggregateSequence: 1,
			OwnerAuthorizationSequence: authorization, CreatedAt: now, UpdatedAt: now},
		Access: ports.AgentAccessRecord{AgentID: id, PrincipalID: base.Agent.OwnerUserID,
			AccessRevision: "access-" + id, Active: true, CreatedAt: now, UpdatedAt: now},
		Spec: spec,
		Operation: ports.LifecycleOperationRecord{RequestID: "request-" + id, RequestFingerprint: strings.Repeat("a", 64),
			AgentID: id, Kind: domain.OperationCreate, Phase: domain.PhaseNetworkEnsure, State: domain.OperationRunning,
			TargetSpecRevisionID: spec.ID, ChildRequestID: domain.ChildRequestID("request-"+id, domain.PhaseNetworkEnsure), CreatedAt: now, UpdatedAt: now},
		RequestedEvent: ports.AgentEventRecord{EventID: "event-" + id, AgentID: id, AggregateSequence: 1, SchemaVersion: 1,
			EventType: ports.EventAgentCreateRequested, OperationRequestID: "request-" + id, Data: map[string]any{}, OccurredAt: now},
	}
}

func TestIdentityReceiptWaitsForInFlightCreateCommit(t *testing.T) {
	repository, base := identityTestRepository(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if err := lockIdentityAdmission(ctx, tx); err != nil {
		t.Fatal(err)
	}
	input := identityCreate(base, "concurrent-create", base.Agent.OrganizationID, 0)
	if err := insertAgent(ctx, tx, input.Agent); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		done <- repository.ApplyIdentityRevocation(ctx, 0, ports.PrincipalRevocation{
			Sequence: 5, UserID: base.Agent.OwnerUserID, Reason: "user_deactivated", OccurredAt: time.Now().UTC()}, "")
	}()
	commitErr := tx.Commit(ctx)
	receiptErr := <-done
	if commitErr != nil || receiptErr != nil {
		t.Fatalf("commit=%v receipt=%v", commitErr, receiptErr)
	}
	agent, err := loadAgentRecord(ctx, repository.pool, input.Agent.AgentID)
	if err != nil || !agent.IdentityRevoked() {
		t.Fatalf("concurrent create escaped receipt: %+v %v", agent, err)
	}
}
