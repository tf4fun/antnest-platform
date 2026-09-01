package postgres

import (
	"context"
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
	base, seed := seedAvailableAgentForRebuild(t, ctx, repository)

	access, err := repository.ResolveAgentAccess(ctx, "access-rebuild-integration")
	if err != nil {
		t.Fatalf("resolve Agent access: %v", err)
	}
	if access.AgentID != base.Agent.AgentID || access.PrincipalID != base.Agent.OwnerUserID ||
		access.AccessRevision != base.Agent.AccessRevision {
		t.Fatalf("access resolution = %+v", access)
	}

	now := time.Unix(1200, 0).UTC()
	command := acquireRunCommand(base.Agent, "request-run-integration", "admission-integration", now)
	admission, replayed, err := repository.AcquireRun(ctx, command)
	if err != nil || replayed {
		t.Fatalf("acquire Run: admission=%+v replayed=%t err=%v", admission, replayed, err)
	}
	if admission.State != domain.AdmissionActive ||
		admission.Snapshot.AgentSpecRevisionID != base.Agent.AgentSpecRevisionID ||
		admission.Snapshot.ExecutionRevisionID != base.Agent.ExecutionRevisionID ||
		admission.Snapshot.AgentExecutionSpecDigest != base.ExecutableSpec.CanonicalDigest ||
		admission.Snapshot.CredentialVersion != seed.Model.CredentialVersion ||
		len(admission.Snapshot.ExecutionSpec.SkillInstructions) != 0 {
		t.Fatalf("admission snapshot = %+v", admission)
	}
	replayedAdmission, replayed, err := repository.AcquireRun(ctx, command)
	if err != nil || !replayed || replayedAdmission.AdmissionID != admission.AdmissionID {
		t.Fatalf("replay Run: admission=%+v replayed=%t err=%v", replayedAdmission, replayed, err)
	}

	credential, err := repository.GetAdmissionCredential(
		ctx, admission.AdmissionID, admission.Snapshot.ExecutionSpec.CredentialRef, now,
	)
	if err != nil {
		t.Fatalf("get admission credential: %v", err)
	}
	if credential.Identity.CredentialVersion != seed.Model.CredentialVersion ||
		credential.SecretType != "bearer" || len(credential.Sealed.Ciphertext) == 0 {
		t.Fatalf("admission credential = %+v", credential)
	}
	if _, err := repository.GetAdmissionCredential(
		ctx, admission.AdmissionID, "another-credential", now,
	); !errors.Is(err, ports.ErrCredentialNotAllowed) {
		t.Fatalf("foreign credential error = %v", err)
	}
	if _, err := repository.GetAdmissionCredential(
		ctx, admission.AdmissionID, admission.Snapshot.ExecutionSpec.CredentialRef,
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
	if _, err := repository.GetAdmissionCredential(
		ctx, admission.AdmissionID, admission.Snapshot.ExecutionSpec.CredentialRef, now,
	); !errors.Is(err, ports.ErrCredentialNotAllowed) {
		t.Fatalf("finished admission credential error = %v", err)
	}
	replayedAdmission, replayed, err = repository.AcquireRun(ctx, command)
	if err != nil || !replayed || replayedAdmission.State != domain.AdmissionReleased {
		t.Fatalf("replay released Run: admission=%+v replayed=%t err=%v", replayedAdmission, replayed, err)
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
	eventType := ports.EventRunAdmissionReleased
	if report.Class == domain.TerminalUnresolved {
		eventType = ports.EventRunAdmissionUnresolved
	}
	return ports.FinishRunCommand{
		RequestID: requestID, AdmissionID: admission.AdmissionID, Report: report,
		Event: ports.RunAdmissionEvent{
			EventID: "event-" + requestID, EventType: eventType,
			Data: map[string]any{"terminal_class": string(report.Class)}, OccurredAt: now,
		},
		Now: now,
	}
}
