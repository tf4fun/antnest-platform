package postgres

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"soft/antnest-platform/services/agent-controller/internal/application"
	"soft/antnest-platform/services/agent-controller/internal/domain"
)

func workspaceStateRepository(t *testing.T) (context.Context, *Repository, string) {
	t.Helper()
	databaseURL := os.Getenv("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	t.Cleanup(cancel)
	repository, err := Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(repository.Close)
	return ctx, repository, databaseURL
}

func TestWorkspaceStateRunCommitNotifiesWithoutAuditRows(t *testing.T) {
	ctx, repository, databaseURL := workspaceStateRepository(t)
	base, _ := seedAvailableAgentForRebuild(t, ctx, repository)
	notifier, err := OpenEventNotifier(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(notifier.Close)
	service := application.NewAgentQueryService(repository, application.WithWorkspaceStateNotifier(notifier))
	input := application.WorkspaceStateInput{AgentID: base.Agent.AgentID, OrganizationID: base.Agent.OrganizationID, PrincipalID: base.Agent.OwnerUserID}
	assertWorkspaceState(t, ctx, service, input, application.WorkspaceAgentReady, "")
	signal, err := notifier.SubscribeAgentEvents()
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	command := acquireRunCommand(base.Agent, "workspace-acquire", "workspace-admission", now)
	admission, replayed, err := repository.AcquireRun(ctx, command)
	if err != nil || replayed {
		t.Fatalf("acquire=%+v replay=%t error=%v", admission, replayed, err)
	}
	awaitWorkspaceNotification(t, ctx, signal)
	assertWorkspaceState(t, ctx, service, input, application.WorkspaceAgentBusy, command.SessionID)
	signal, err = notifier.SubscribeAgentEvents()
	if err != nil {
		t.Fatal(err)
	}
	if _, replayed, err := repository.AcquireRun(ctx, command); err != nil || !replayed {
		t.Fatalf("replay=%t error=%v", replayed, err)
	}
	assertNoWorkspaceNotification(t, signal)
	finish := finishRunCommand(admission, "workspace-finish", domain.TerminalReport{Class: domain.TerminalCompleted, ToolEffectState: domain.ToolEffectSettled, StopReason: "end_turn"}, now.Add(time.Second))
	if _, err := repository.FinishRun(ctx, finish); err != nil {
		t.Fatal(err)
	}
	awaitWorkspaceNotification(t, ctx, signal)
	assertWorkspaceState(t, ctx, service, input, application.WorkspaceAgentReady, "")
	signal, err = notifier.SubscribeAgentEvents()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repository.FinishRun(ctx, finish); err != nil {
		t.Fatal(err)
	}
	assertNoWorkspaceNotification(t, signal)
	var events int
	if err := repository.pool.QueryRow(ctx, "SELECT count(*) FROM agent_controller.agent_events WHERE admission_id=$1", admission.AdmissionID).Scan(&events); err != nil || events != 0 {
		t.Fatalf("normal Run audit count=%d error=%v", events, err)
	}
	foreign := input
	foreign.PrincipalID = "another-user"
	if _, err := service.GetWorkspaceAgentState(ctx, foreign); !errors.Is(err, application.ErrAgentNotFound) {
		t.Fatalf("foreign scope error=%v", err)
	}
	foreign = input
	foreign.OrganizationID = "another-org"
	if _, err := service.GetWorkspaceAgentState(ctx, foreign); !errors.Is(err, application.ErrAgentNotFound) {
		t.Fatalf("foreign organization error=%v", err)
	}
}

func TestWorkspaceStateRunNotificationRequiresCommitAndActualStateChange(t *testing.T) {
	ctx, repository, databaseURL := workspaceStateRepository(t)
	base, _ := seedAvailableAgentForRebuild(t, ctx, repository)
	admission, _, err := repository.AcquireRun(ctx, acquireRunCommand(base.Agent, "workspace-acquire", "workspace-admission", time.Now().UTC()))
	if err != nil {
		t.Fatal(err)
	}
	notifier, err := OpenEventNotifier(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(notifier.Close)
	signal, err := notifier.SubscribeAgentEvents()
	if err != nil {
		t.Fatal(err)
	}
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := tx.Rollback(context.Background()); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
			t.Error(err)
		}
	})
	if _, err := tx.Exec(ctx, "DELETE FROM agent_controller.run_admissions WHERE admission_id=$1", admission.AdmissionID); err != nil {
		t.Fatal(err)
	}
	assertNoWorkspaceNotification(t, signal)
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	assertNoWorkspaceNotification(t, signal)
	if _, err := repository.pool.Exec(ctx, "UPDATE agent_controller.run_admissions SET state=state WHERE admission_id=$1", admission.AdmissionID); err != nil {
		t.Fatal(err)
	}
	assertNoWorkspaceNotification(t, signal)
	if _, err := repository.pool.Exec(ctx, "DELETE FROM agent_controller.run_admissions WHERE admission_id=$1", admission.AdmissionID); err != nil {
		t.Fatal(err)
	}
	awaitWorkspaceNotification(t, ctx, signal)
}

func assertWorkspaceState(t *testing.T, ctx context.Context, service *application.AgentQueryService, input application.WorkspaceStateInput, availability application.WorkspaceAvailability, session string) {
	t.Helper()
	state, err := service.GetWorkspaceAgentState(ctx, input)
	if err != nil || state.Availability != availability || state.ActiveSessionID != session || !state.AccessAllowed {
		t.Fatalf("workspace state=%+v error=%v", state, err)
	}
}

func awaitWorkspaceNotification(t *testing.T, ctx context.Context, signal <-chan struct{}) {
	t.Helper()
	select {
	case <-signal:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	case <-time.After(3 * time.Second):
		t.Fatal("missing committed workspace notification")
	}
}

func assertNoWorkspaceNotification(t *testing.T, signal <-chan struct{}) {
	t.Helper()
	select {
	case <-signal:
		t.Fatal("unexpected workspace notification")
	case <-time.After(75 * time.Millisecond):
	}
}

func TestWorkspaceStateMigrationUpgradesVersionSix(t *testing.T) {
	ctx, repository, _ := workspaceStateRepository(t)
	resetCatalogSchema(t, ctx, repository)
	for _, migration := range schemaMigrations {
		if migration.version > 6 {
			break
		}
		if _, err := repository.pool.Exec(ctx, migration.sql); err != nil {
			t.Fatal(err)
		}
		if _, err := repository.pool.Exec(ctx, "INSERT INTO agent_controller.schema_migrations(version,name,checksum) VALUES($1,$2,$3)", migration.version, migration.name, migrationChecksum(migration.sql)); err != nil {
			t.Fatal(err)
		}
	}
	if err := repository.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	if err := repository.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	var triggers int
	if err := repository.pool.QueryRow(ctx, `SELECT count(*) FROM pg_trigger WHERE tgrelid='agent_controller.run_admissions'::regclass AND tgname IN ('run_availability_insert_delete','run_availability_state_change') AND tgenabled='O'`).Scan(&triggers); err != nil || triggers != 2 {
		t.Fatalf("triggers=%d error=%v", triggers, err)
	}
}
