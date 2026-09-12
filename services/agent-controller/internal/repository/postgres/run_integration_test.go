package postgres

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestRunRepositoryAcquiresFinishesAndScopesCredential(t *testing.T) {
	databaseURL := os.Getenv("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	repository, err := Open(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open repository: %v", err)
	}
	t.Cleanup(repository.Close)
	base, _ := seedAvailableAgentForRebuild(t, ctx, repository)
	assertManagedMCPRunPrivacy(t, ctx, repository, base)

	access, err := repository.ResolveAgentAccess(ctx, "access-rebuild-integration")
	if err != nil {
		t.Fatalf("resolve Agent access: %v", err)
	}
	if access.AgentID != base.Agent.AgentID || access.PrincipalID != base.Agent.OwnerUserID ||
		access.OrganizationID != base.Agent.OrganizationID ||
		access.AccessRevision != base.Agent.AccessRevision {
		t.Fatalf("access resolution = %+v", access)
	}
	authorization, err := repository.ResolveRunAuthorization(
		ctx, base.Agent.AgentID, base.Agent.OwnerUserID, base.Agent.AccessRevision,
	)
	if err != nil || authorization.OrganizationID != base.Agent.OrganizationID ||
		authorization.OwnerUserID != base.Agent.OwnerUserID {
		t.Fatalf("Run authorization = %+v, %v", authorization, err)
	}
	if _, err := repository.ResolveRunAuthorization(
		ctx, base.Agent.AgentID, "another-user", base.Agent.AccessRevision,
	); !errors.Is(err, ports.ErrRunAccessDenied) {
		t.Fatalf("foreign Run principal error = %v", err)
	}

	now := time.Unix(1200, 123456789).UTC()
	command := acquireRunCommand(base.Agent, "request-run-integration", "admission-integration", now)
	if replay, found, err := repository.ReplayRunAdmission(
		ctx, command.RequestID, command.RequestFingerprint,
	); err != nil || found || replay.AdmissionID != "" {
		t.Fatalf("pre-admission replay = %+v found=%t err=%v", replay, found, err)
	}
	admission, replayed, err := repository.AcquireRun(ctx, command)
	if err != nil || replayed {
		t.Fatalf("acquire Run: admission=%+v replayed=%t err=%v", admission, replayed, err)
	}
	if admission.State != domain.AdmissionActive ||
		admission.Snapshot.AgentSpecRevisionID != base.Agent.AgentSpecRevisionID ||
		admission.Snapshot.ExecutionRevisionID != base.Agent.ExecutionRevisionID ||
		admission.Snapshot.AgentExecutionSpecDigest != base.ExecutableSpec.CanonicalDigest ||
		len(admission.Snapshot.ExecutionSpec.SkillInstructions) != 0 {
		t.Fatalf("admission snapshot = %+v", admission)
	}
	replayedAdmission, found, err := repository.ReplayRunAdmission(
		ctx, command.RequestID, command.RequestFingerprint,
	)
	if err != nil || !found || replayedAdmission.AdmissionID != admission.AdmissionID {
		t.Fatalf("query Run replay: admission=%+v found=%t err=%v", replayedAdmission, found, err)
	}
	assertSameAdmissionRecord(t, admission, replayedAdmission)
	replayedAdmission, replayed, err = repository.AcquireRun(ctx, command)
	if err != nil || !replayed || replayedAdmission.AdmissionID != admission.AdmissionID {
		t.Fatalf("replay Run: admission=%+v replayed=%t err=%v", replayedAdmission, replayed, err)
	}
	assertSameAdmissionRecord(t, admission, replayedAdmission)

	credential, err := repository.GetAdmissionCredential(
		ctx, admission.AdmissionID, admission.Snapshot.ExecutionSpec.Provider.ConnectionID, now,
	)
	if err != nil {
		t.Fatalf("get admission credential: %v", err)
	}
	if credential.Identity.CredentialVersion != "version-credential_integration" ||
		credential.SecretType != "bearer" || len(credential.Sealed.Ciphertext) == 0 {
		t.Fatalf("admission credential = %+v", credential)
	}
	if _, err := repository.GetAdmissionCredential(
		ctx, admission.AdmissionID, "another-credential", now,
	); !errors.Is(err, ports.ErrCredentialNotAllowed) {
		t.Fatalf("foreign credential error = %v", err)
	}
	if _, err := repository.GetAdmissionCredential(
		ctx, admission.AdmissionID, admission.Snapshot.ExecutionSpec.Provider.ConnectionID,
		admission.Deadline,
	); !errors.Is(err, ports.ErrCredentialNotAllowed) {
		t.Fatalf("expired admission credential error = %v", err)
	}

	report := domain.TerminalReport{
		Class: domain.TerminalCompleted, ToolEffectState: domain.ToolEffectSettled,
		StopReason: "end_turn",
	}
	finish := finishRunCommand(admission, "request-finish-integration", report, now.Add(time.Second))
	finished, err := repository.FinishRun(ctx, finish)
	if err != nil || finished.Status != "finished" || finished.AdmissionState != domain.AdmissionReleased {
		t.Fatalf("finish Run: result=%+v err=%v", finished, err)
	}
	replayedFinish, err := repository.FinishRun(ctx, finish)
	if err != nil || replayedFinish.Status != "already_finished" {
		t.Fatalf("replay FinishRun: result=%+v err=%v", replayedFinish, err)
	}
	var finishEvents int
	if err := repository.pool.QueryRow(ctx, `
SELECT count(*) FROM agent_controller.agent_events WHERE admission_id = $1`,
		admission.AdmissionID,
	).Scan(&finishEvents); err != nil {
		t.Fatalf("count normal FinishRun events: %v", err)
	}
	if finishEvents != 0 {
		t.Fatalf("normal FinishRun emitted %d lifecycle release events", finishEvents)
	}
	if _, err := repository.GetAdmissionCredential(
		ctx, admission.AdmissionID, admission.Snapshot.ExecutionSpec.Provider.ConnectionID, now,
	); !errors.Is(err, ports.ErrCredentialNotAllowed) {
		t.Fatalf("finished admission credential error = %v", err)
	}
	replayedAdmission, replayed, err = repository.AcquireRun(ctx, command)
	if err != nil || !replayed || replayedAdmission.State != domain.AdmissionReleased {
		t.Fatalf("replay released Run: admission=%+v replayed=%t err=%v", replayedAdmission, replayed, err)
	}
}

func assertSameAdmissionRecord(t *testing.T, first, replay ports.RunAdmissionRecord) {
	t.Helper()
	firstJSON, err := json.Marshal(first)
	if err != nil {
		t.Fatal(err)
	}
	replayJSON, err := json.Marshal(replay)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(firstJSON, replayJSON) {
		t.Fatalf("initial and persisted admission differ: deadline %s / %s, created %s / %s",
			first.Deadline.Format(time.RFC3339Nano), replay.Deadline.Format(time.RFC3339Nano),
			first.CreatedAt.Format(time.RFC3339Nano), replay.CreatedAt.Format(time.RFC3339Nano))
	}
}

func assertManagedMCPRunPrivacy(t *testing.T, ctx context.Context, repository *Repository, base ports.AgentLifecycleBase) {
	t.Helper()
	servers := base.ExecutableSpec.Snapshot.Runtime.MCPServers
	if len(servers) != 1 || servers[0].Env["TOKEN"] != "synthetic-mcp-token" {
		t.Fatal("MCP configuration did not survive Agent spec persistence")
	}
	snapshot, err := loadRunExecutionSnapshot(ctx, repository.pool, base.Agent)
	if err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"mcp_servers", "synthetic-mcp-token", "server.js"} {
		if strings.Contains(string(payload), forbidden) {
			t.Fatalf("Run admission exposes deployment configuration: %s", forbidden)
		}
	}
}

func TestRunRepositorySerializesConcurrentAcquisitions(t *testing.T) {
	databaseURL := os.Getenv("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	repository, err := Open(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open repository: %v", err)
	}
	t.Cleanup(repository.Close)
	base, _ := seedAvailableAgentForRebuild(t, ctx, repository)

	now := time.Unix(1300, 0).UTC()
	commands := []ports.AcquireRunRecord{
		acquireRunCommand(base.Agent, "request-run-race-a", "admission-race-a", now),
		acquireRunCommand(base.Agent, "request-run-race-b", "admission-race-b", now),
	}
	start := make(chan struct{})
	results := make(chan error, len(commands))
	var wait sync.WaitGroup
	for _, command := range commands {
		command := command
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			_, _, acquireErr := repository.AcquireRun(ctx, command)
			results <- acquireErr
		}()
	}
	close(start)
	wait.Wait()
	close(results)

	var accepted, busy int
	for result := range results {
		switch {
		case result == nil:
			accepted++
		case errors.Is(result, ports.ErrAgentBusy):
			busy++
		default:
			t.Fatalf("unexpected concurrent acquisition error: %v", result)
		}
	}
	if accepted != 1 || busy != 1 {
		t.Fatalf("concurrent acquisitions accepted=%d busy=%d", accepted, busy)
	}
}

func TestRunRepositoryRecordsUnresolvedOutcomeExactlyOnce(t *testing.T) {
	databaseURL := os.Getenv("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	repository, err := Open(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open repository: %v", err)
	}
	t.Cleanup(repository.Close)
	base, _ := seedAvailableAgentForRebuild(t, ctx, repository)

	now := time.Unix(1500, 0).UTC()
	admission, replayed, err := repository.AcquireRun(ctx,
		acquireRunCommand(base.Agent, "request-run-unresolved", "admission-unresolved", now),
	)
	if err != nil || replayed {
		t.Fatalf("acquire unresolved Run: admission=%+v replayed=%t err=%v", admission, replayed, err)
	}
	report := domain.TerminalReport{
		Class: domain.TerminalUnresolved, ToolEffectState: domain.ToolEffectUnknown,
		UnknownEffectSource: domain.UnknownEffectRuntimeMCP,
		ErrorClass:          "runtime_result_unknown",
	}
	finish := finishRunCommand(admission, "request-finish-unresolved", report, now.Add(time.Second))
	result, err := repository.FinishRun(ctx, finish)
	if err != nil || result.AdmissionState != domain.AdmissionBlockedUnknownEffect {
		t.Fatalf("finish unresolved Run: result=%+v err=%v", result, err)
	}

	assertUnresolvedRunEventState(t, ctx, repository, base.Agent.AgentID, admission.AdmissionID, 1)
	replayedResult, err := repository.FinishRun(ctx, finish)
	if err != nil || replayedResult.Status != "already_finished" {
		t.Fatalf("replay unresolved FinishRun: result=%+v err=%v", replayedResult, err)
	}
	assertUnresolvedRunEventState(t, ctx, repository, base.Agent.AgentID, admission.AdmissionID, 1)
}

func assertUnresolvedRunEventState(
	t *testing.T,
	ctx context.Context,
	repository *Repository,
	agentID string,
	admissionID string,
	wantEvents int,
) {
	t.Helper()
	var eventCount int
	var eventSequence, aggregateSequence int64
	if err := repository.pool.QueryRow(ctx, `
SELECT count(*), COALESCE(max(aggregate_sequence), 0)
FROM agent_controller.agent_events
WHERE admission_id = $1 AND event_type = 'run_admission_unresolved'`, admissionID,
	).Scan(&eventCount, &eventSequence); err != nil {
		t.Fatalf("read unresolved Run event: %v", err)
	}
	if err := repository.pool.QueryRow(ctx, `
SELECT aggregate_sequence FROM agent_controller.agents WHERE id = $1`, agentID,
	).Scan(&aggregateSequence); err != nil {
		t.Fatalf("read Agent aggregate sequence: %v", err)
	}
	if eventCount != wantEvents || eventSequence != aggregateSequence {
		t.Fatalf("unresolved events=%d sequence=%d Agent sequence=%d", eventCount, eventSequence, aggregateSequence)
	}
}

func acquireRunCommand(
	agent ports.AgentRecord, requestID string, admissionID string, now time.Time,
) ports.AcquireRunRecord {
	return ports.AcquireRunRecord{
		RequestID: requestID, RequestFingerprint: strings.Repeat("c", 64),
		AdmissionID: admissionID, AgentID: agent.AgentID, PrincipalID: agent.OwnerUserID,
		ExpectedAccessRevision: agent.AccessRevision, SessionID: "session-" + admissionID,
		Deadline: now.Add(30 * time.Minute), Now: now,
	}
}

func finishRunCommand(
	admission ports.RunAdmissionRecord,
	requestID string,
	report domain.TerminalReport,
	now time.Time,
) ports.FinishRunCommand {
	var event *ports.RunAdmissionEvent
	if report.Class == domain.TerminalUnresolved {
		event = &ports.RunAdmissionEvent{
			EventID: "event-" + requestID, EventType: ports.EventRunAdmissionUnresolved,
			Data: map[string]any{"terminal_class": string(report.Class)}, OccurredAt: now,
		}
	}
	return ports.FinishRunCommand{
		RequestID: requestID, AdmissionID: admission.AdmissionID, Report: report,
		Event: event, Now: now,
	}
}
