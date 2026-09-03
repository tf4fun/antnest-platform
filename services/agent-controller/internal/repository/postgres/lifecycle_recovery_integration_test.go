package postgres

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestLifecycleRecoveryClaimUsesLeaseAndAttemptFencing(t *testing.T) {
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
	resetCatalogSchema(t, ctx, repository)
	if err := repository.Migrate(ctx); err != nil {
		t.Fatalf("migrate repository: %v", err)
	}

	now := time.Now().UTC()
	insertRecoveryOperation(t, ctx, repository, "agent-stale", "request-stale", now.Add(-time.Minute))
	insertRecoveryOperation(t, ctx, repository, "agent-fresh", "request-fresh", now)

	claim, found, err := repository.ClaimLifecycleRecovery(ctx, ports.ClaimLifecycleRecovery{
		WorkerID:      "worker-a",
		LeaseDuration: 30 * time.Second,
	})
	if err != nil || !found {
		t.Fatalf("claim stale operation: claim=%+v found=%v err=%v", claim, found, err)
	}
	if claim.Operation.RequestID != "request-stale" || claim.WorkerID != "worker-a" ||
		claim.Attempt != 1 || claim.ConsecutiveFailures != 0 {
		t.Fatalf("first claim = %+v", claim)
	}
	freshClaim, found, err := repository.ClaimLifecycleRecovery(ctx, ports.ClaimLifecycleRecovery{
		WorkerID:      "worker-b",
		LeaseDuration: 30 * time.Second,
	})
	if err != nil || !found || freshClaim.Operation.RequestID != "request-fresh" ||
		freshClaim.Attempt != 1 {
		t.Fatalf("fresh operation was not immediately claimable: claim=%+v found=%v err=%v", freshClaim, found, err)
	}

	if _, err := repository.pool.Exec(ctx, `
UPDATE agent_controller.agent_lifecycle_operations
SET recovery_lease_until = clock_timestamp() - interval '1 second'
WHERE request_id = 'request-stale'`); err != nil {
		t.Fatalf("expire recovery lease: %v", err)
	}
	reclaimed, found, err := repository.ClaimLifecycleRecovery(ctx, ports.ClaimLifecycleRecovery{
		WorkerID:      "worker-b",
		LeaseDuration: 30 * time.Second,
	})
	if err != nil || !found || reclaimed.Operation.RequestID != "request-stale" ||
		reclaimed.Attempt != 2 {
		t.Fatalf("reclaim expired lease: claim=%+v found=%v err=%v", reclaimed, found, err)
	}

	traceParent := "00-22222222222222222222222222222222-2222222222222222-01"
	if err := repository.StartLifecycleRecoveryAttempt(ctx, ports.StartLifecycleRecoveryAttempt{
		RequestID: "request-stale", WorkerID: "worker-a", Attempt: 1,
		TraceParent: traceParent,
	}); !errors.Is(err, ports.ErrLifecycleRecoveryClaimLost) {
		t.Fatalf("expired owner start error = %v", err)
	}
	if err := repository.StartLifecycleRecoveryAttempt(ctx, ports.StartLifecycleRecoveryAttempt{
		RequestID: "request-stale", WorkerID: "worker-b", Attempt: 2,
		TraceParent: traceParent,
	}); err != nil {
		t.Fatalf("start current attempt: %v", err)
	}
	attachment := ports.NetworkAttachment{AgentID: "agent-stale", State: "active"}
	if _, err := repository.RecordCreateNetwork(
		ctx, "request-stale", strings.Repeat("a", 64), attachment,
		domain.ChildRequestID("request-stale", domain.PhaseRuntimeInitialize), time.Now().UTC(),
	); !errors.Is(err, ports.ErrConcurrentChange) {
		t.Fatalf("explicit replay bypassed recovery lease: %v", err)
	}
	expiredCtx := ports.WithLifecycleRecoveryToken(ctx, ports.LifecycleRecoveryToken{
		RequestID: "request-stale", WorkerID: "worker-a", Attempt: 1,
	})
	if _, err := repository.RecordCreateNetwork(
		expiredCtx, "request-stale", strings.Repeat("a", 64), attachment,
		domain.ChildRequestID("request-stale", domain.PhaseRuntimeInitialize), time.Now().UTC(),
	); !errors.Is(err, ports.ErrLifecycleRecoveryClaimLost) {
		t.Fatalf("expired recovery attempt mutated operation: %v", err)
	}
	currentCtx := ports.WithLifecycleRecoveryToken(ctx, ports.LifecycleRecoveryToken{
		RequestID: "request-stale", WorkerID: "worker-b", Attempt: 2,
	})
	transaction, err := repository.pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin current lease verification: %v", err)
	}
	operation, err := loadLifecycleOperation(ctx, transaction, "request-stale", "FOR UPDATE")
	if err != nil {
		_ = transaction.Rollback(ctx)
		t.Fatalf("load current recovery operation: %v", err)
	}
	if err := authorizeLifecycleMutation(currentCtx, transaction, operation); err != nil {
		_ = transaction.Rollback(ctx)
		t.Fatalf("current recovery attempt was fenced: %v", err)
	}
	if err := transaction.Rollback(ctx); err != nil {
		t.Fatalf("rollback current lease verification: %v", err)
	}
	if err := repository.ReleaseLifecycleRecoveryClaim(ctx, ports.ReleaseLifecycleRecoveryClaim{
		RequestID: "request-stale", WorkerID: "worker-a", Attempt: 1,
		Failed: true, RetryAfter: time.Minute,
	}); !errors.Is(err, ports.ErrLifecycleRecoveryClaimLost) {
		t.Fatalf("expired owner release error = %v", err)
	}
	var releasedAt time.Time
	if err := repository.pool.QueryRow(ctx, "SELECT clock_timestamp()").Scan(&releasedAt); err != nil {
		t.Fatalf("read database clock: %v", err)
	}
	if err := repository.ReleaseLifecycleRecoveryClaim(ctx, ports.ReleaseLifecycleRecoveryClaim{
		RequestID: "request-stale", WorkerID: "worker-b", Attempt: 2,
		Failed: true, RetryAfter: time.Minute,
	}); err != nil {
		t.Fatalf("release current attempt: %v", err)
	}

	operation, err = repository.GetLifecycleOperation(ctx, "request-stale")
	if err != nil {
		t.Fatalf("load released operation: %v", err)
	}
	if operation.Attempt != 2 || operation.PreviousRecoveryTraceParent != traceParent ||
		operation.RecoveryOwner != "" || operation.RecoveryLeaseUntil != nil ||
		operation.RecoveryFailureCount != 1 ||
		operation.RecoveryAfter.Before(releasedAt.Add(59*time.Second)) ||
		operation.RecoveryAfter.After(releasedAt.Add(61*time.Second)) {
		t.Fatalf("released recovery metadata = %+v", operation)
	}
	if _, found, err := repository.ClaimLifecycleRecovery(ctx, ports.ClaimLifecycleRecovery{
		WorkerID:      "worker-c",
		LeaseDuration: time.Minute,
	}); err != nil || found {
		t.Fatalf("operation ignored recovery_after: found=%v err=%v", found, err)
	}
	if _, err := repository.pool.Exec(ctx, `
UPDATE agent_controller.agent_lifecycle_operations
SET recovery_after = clock_timestamp() - interval '1 second'
WHERE request_id = 'request-stale'`); err != nil {
		t.Fatalf("make recovery retry due: %v", err)
	}
	finalClaim, found, err := repository.ClaimLifecycleRecovery(ctx, ports.ClaimLifecycleRecovery{
		WorkerID:      "worker-c",
		LeaseDuration: time.Minute,
	})
	if err != nil || !found || finalClaim.Attempt != 3 ||
		finalClaim.Operation.PreviousRecoveryTraceParent != traceParent {
		t.Fatalf("claim after retry delay: claim=%+v found=%v err=%v", finalClaim, found, err)
	}
}

func TestLifecycleRecoveryTerminalOperationCannotRetainLease(t *testing.T) {
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
	resetCatalogSchema(t, ctx, repository)
	if err := repository.Migrate(ctx); err != nil {
		t.Fatalf("migrate repository: %v", err)
	}

	now := time.Now().UTC()
	insertRecoveryOperation(t, ctx, repository, "agent-terminal-lease", "request-terminal-lease", now)
	if _, err := repository.pool.Exec(ctx, `
UPDATE agent_controller.agent_lifecycle_operations
SET state = 'completed', phase = 'completed',
    recovery_owner = 'stale-worker', recovery_lease_until = $2
WHERE request_id = $1`, "request-terminal-lease", now.Add(time.Minute)); err == nil {
		t.Fatal("terminal lifecycle operation accepted a recovery lease")
	}

	operation, err := repository.GetLifecycleOperation(ctx, "request-terminal-lease")
	if err != nil {
		t.Fatalf("load operation after rejected update: %v", err)
	}
	if operation.State != domain.OperationRunning || operation.RecoveryOwner != "" ||
		operation.RecoveryLeaseUntil != nil {
		t.Fatalf("rejected terminal update changed operation: %+v", operation)
	}
}

func TestLifecycleRecoveryQuarantineIsOperationLocal(t *testing.T) {
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
	resetCatalogSchema(t, ctx, repository)
	if err := repository.Migrate(ctx); err != nil {
		t.Fatalf("migrate repository: %v", err)
	}

	now := time.Now().UTC()
	insertRecoveryOperation(t, ctx, repository, "agent-broken", "request-broken", now.Add(-time.Minute))
	insertRecoveryOperation(t, ctx, repository, "agent-next", "request-next", now)
	claim, found, err := repository.ClaimLifecycleRecovery(ctx, ports.ClaimLifecycleRecovery{
		WorkerID: "worker-a", LeaseDuration: time.Minute,
	})
	if err != nil || !found || claim.Operation.RequestID != "request-broken" {
		t.Fatalf("claim broken operation: claim=%+v found=%v err=%v", claim, found, err)
	}
	if err := repository.QuarantineLifecycleRecoveryClaim(
		ctx, ports.QuarantineLifecycleRecoveryClaim{
			RequestID: "request-broken", WorkerID: "worker-a", Attempt: claim.Attempt,
			ErrorCode: "lifecycle_invariant_failed", ErrorDetail: "invalid persisted phase",
			EventID: "event-lifecycle-quarantined-test",
		},
	); err != nil {
		t.Fatalf("quarantine broken operation: %v", err)
	}
	operation, err := repository.GetLifecycleOperation(ctx, "request-broken")
	if err != nil {
		t.Fatalf("load quarantined operation: %v", err)
	}
	if operation.State != domain.OperationFailed || operation.RecoveryOwner != "" ||
		operation.RecoveryLeaseUntil != nil || operation.ErrorCode != "lifecycle_invariant_failed" {
		t.Fatalf("quarantined operation = %+v", operation)
	}
	var lifecycleState, activeRequestID, failureCode string
	if err := repository.pool.QueryRow(ctx, `
SELECT lifecycle_state, active_operation_request_id, failure_code
FROM agent_controller.agents
WHERE id = 'agent-broken'`).Scan(&lifecycleState, &activeRequestID, &failureCode); err != nil {
		t.Fatalf("load quarantined Agent: %v", err)
	}
	if lifecycleState != string(domain.AgentUnavailable) || activeRequestID != "" ||
		failureCode != "lifecycle_invariant_failed" {
		t.Fatalf("quarantined Agent state=%q active=%q failure=%q", lifecycleState, activeRequestID, failureCode)
	}
	events, err := repository.ListAgentEvents(ctx, ports.AgentEventQuery{
		OrganizationID: "org-recovery", AgentID: "agent-broken", Limit: 10,
	})
	if err != nil || len(events) != 1 || events[0].EventType != ports.EventAgentLifecycleQuarantined {
		t.Fatalf("quarantine events=%+v err=%v", events, err)
	}
	nextClaim, found, err := repository.ClaimLifecycleRecovery(ctx, ports.ClaimLifecycleRecovery{
		WorkerID: "worker-b", LeaseDuration: time.Minute,
	})
	if err != nil || !found || nextClaim.Operation.RequestID != "request-next" {
		t.Fatalf("claim after quarantine: claim=%+v found=%v err=%v", nextClaim, found, err)
	}
}

func insertRecoveryOperation(
	t *testing.T,
	ctx context.Context,
	repository *Repository,
	agentID string,
	requestID string,
	updatedAt time.Time,
) {
	t.Helper()
	_, err := repository.pool.Exec(ctx, `
INSERT INTO agent_controller.agents (
    id, organization_id, owner_user_id, name, desired_state, lifecycle_state,
    access_revision, active_operation_request_id, aggregate_sequence,
    created_at, updated_at
) VALUES ($1, 'org-recovery', 'user-recovery', $1, 'enabled', 'provisioning',
          'access-recovery', $2, 1, $3, $3)`, agentID, requestID, updatedAt)
	if err != nil {
		t.Fatalf("insert recovery Agent: %v", err)
	}
	_, err = repository.pool.Exec(ctx, `
	INSERT INTO agent_controller.agent_lifecycle_operations (
    request_id, request_fingerprint, agent_id, kind, phase, state,
    target_spec_revision_id, child_request_id, attempt,
    recovery_after, created_at, updated_at
	) VALUES ($1, $2, $3, 'create', 'network_ensure', 'running',
			  $4, $5, 0, LEAST($6, clock_timestamp()), $6, $6)`,
		requestID, strings.Repeat("a", 64), agentID, "spec-"+agentID,
		domain.ChildRequestID(requestID, domain.PhaseNetworkEnsure), updatedAt,
	)
	if err != nil {
		t.Fatalf("insert recovery operation: %v", err)
	}
}
