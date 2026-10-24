package postgres

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/acpincarnation"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
)

var _ acpincarnation.Store = (*Repository)(nil)

func TestAcpIncarnationRepositoryPersistsDigestBindingAndExactReplays(t *testing.T) {
	primary, database, ctx := integrationRepository(t)
	first, firstDatabase, closeFirst := acpIncarnationOpenRepository(t, ctx, primary.lockDatabase, "")
	input := acpIncarnationRecord(1)
	original := input
	stored, err := first.RegisterVerified(ctx, input)
	if err != nil {
		t.Fatal("register verified incarnation failed")
	}
	acpIncarnationAssertRecord(t, stored, input)
	if !reflect.DeepEqual(input, original) {
		t.Fatal("registration changed its input")
	}

	var digest []byte
	var startedAt, startedAtType, raw string
	if err := database.QueryRowContext(ctx, `
SELECT nonce_digest,started_at,pg_typeof(started_at)::text,to_jsonb(r)::text
FROM runtime_controller.acp_incarnation_registrations r
WHERE controller_scope=$1 AND registration_id=$2`, input.Scope, input.Registration.RegistrationID).
		Scan(&digest, &startedAt, &startedAtType, &raw); err != nil {
		t.Fatal("read persisted registration failed")
	}
	if len(digest) != sha256.Size || !bytes.Equal(digest, input.NonceDigest[:]) {
		t.Fatal("registration did not persist the exact nonce digest")
	}
	if strings.Contains(raw, strings.Repeat("e", 64)) {
		t.Fatal("registration persisted the private nonce")
	}
	if startedAtType != "text" || startedAt != input.Binding.StartedAt {
		t.Fatal("registration changed the full nanosecond start identity")
	}
	acpIncarnationAssertLookups(t, primary, ctx, input)

	retry := input
	retry.Registration.RegistrationID = acpIncarnationUUID(2)
	replayed, err := first.RegisterVerified(ctx, retry)
	if err != nil {
		t.Fatal("exact registration replay failed")
	}
	acpIncarnationAssertRecord(t, replayed, stored)
	acpIncarnationAssertCount(t, database, ctx, 1)

	closeFirst()
	if firstDatabase.Stats().OpenConnections != 0 {
		t.Fatal("first registration database was not closed")
	}
	reopened, _, _ := acpIncarnationOpenRepository(t, ctx, primary.lockDatabase, "")
	acpIncarnationAssertLookups(t, reopened, ctx, stored)
	replayed, err = reopened.RegisterVerified(ctx, retry)
	if err != nil {
		t.Fatal("registration replay after reopening failed")
	}
	acpIncarnationAssertRecord(t, replayed, stored)
	for _, lookup := range []func() (*acpincarnation.Record, error){
		func() (*acpincarnation.Record, error) {
			return reopened.FindRegistration(ctx, "other-scope", input.Registration.MemberID, input.Registration.IncarnationID)
		},
		func() (*acpincarnation.Record, error) {
			return reopened.GetRegistration(ctx, "other-scope", input.Registration.RegistrationID)
		},
	} {
		value, err := lookup()
		if err != nil || value != nil {
			t.Fatal("registration lookup crossed its controller scope")
		}
	}
}

func TestAcpIncarnationRepositoryConcurrentRegistrationHasOneImmutableWinner(t *testing.T) {
	for _, scenario := range []string{"same", "nonce", "engine", "container", "started_at", "other_scope"} {
		t.Run(scenario, func(t *testing.T) {
			first, database, ctx := integrationRepository(t)
			second, _, _ := acpIncarnationOpenRepository(t, ctx, first.lockDatabase, "")
			inputs := [2]acpincarnation.Record{acpIncarnationRecord(10), acpIncarnationRecord(10)}
			inputs[1].Registration.RegistrationID = acpIncarnationUUID(11)
			switch scenario {
			case "nonce":
				inputs[1].NonceDigest[0] ^= 1
			case "engine":
				inputs[1].Binding.EngineID = "other-engine"
			case "container":
				inputs[1].Binding.ContainerID = strings.Repeat("b", 64)
			case "started_at":
				inputs[1].Binding.StartedAt = "2026-10-01T01:02:03.123456788Z"
			case "other_scope":
				inputs[1].Scope = "other-scope"
			}
			stores := [2]*Repository{first, second}
			results := acpIncarnationParallel(t, ctx, func(callCtx context.Context, index int) acpIncarnationResult {
				record, err := stores[index].RegisterVerified(callCtx, inputs[index])
				return acpIncarnationResult{record: record, err: err}
			})
			if scenario == "other_scope" {
				for index, result := range results {
					if result.err != nil {
						t.Fatal("independent controller scope was blocked")
					}
					acpIncarnationAssertRecord(t, result.record, inputs[index])
					acpIncarnationAssertLookups(t, first, ctx, inputs[index])
				}
				acpIncarnationAssertCount(t, database, ctx, 2)
				return
			}

			winner := -1
			conflicts := 0
			for index, result := range results {
				if result.err == nil {
					if winner == -1 {
						winner = index
					}
					continue
				}
				if !errors.Is(result.err, acpincarnation.ErrConflict) || !reflect.DeepEqual(result.record, acpincarnation.Record{}) {
					t.Fatal("registration conflict lost its typed error or returned a record")
				}
				conflicts++
			}
			if winner == -1 {
				t.Fatal("concurrent registration had no winner")
			}
			if scenario == "same" {
				if conflicts != 0 {
					t.Fatal("identical concurrent registrations did not share a receipt")
				}
				acpIncarnationAssertRecord(t, results[0].record, results[1].record)
				if results[0].record.Registration.RegistrationID != inputs[0].Registration.RegistrationID &&
					results[0].record.Registration.RegistrationID != inputs[1].Registration.RegistrationID {
					t.Fatal("registration returned an unrelated receipt")
				}
			} else {
				if conflicts != 1 {
					t.Fatal("conflicting registrations both succeeded")
				}
				acpIncarnationAssertRecord(t, results[winner].record, inputs[winner])
			}
			acpIncarnationAssertCount(t, database, ctx, 1)
			acpIncarnationAssertLookups(t, second, ctx, results[winner].record)
			before := acpIncarnationRows(t, database, ctx)
			loser := inputs[1-winner]
			if scenario != "same" {
				value, err := second.RegisterVerified(ctx, loser)
				if !errors.Is(err, acpincarnation.ErrConflict) || !reflect.DeepEqual(value, acpincarnation.Record{}) {
					t.Fatal("later candidate replaced an immutable registration")
				}
				if acpIncarnationRows(t, database, ctx) != before {
					t.Fatal("rejected registration changed persisted identity")
				}
			}
		})
	}
}

func TestAcpIncarnationRepositoryPreservesStartedAtNanoseconds(t *testing.T) {
	store, database, ctx := integrationRepository(t)
	starts := []string{"2026-10-01T01:02:03.123456788Z", "2026-10-01T01:02:03.123456789Z"}
	for index, start := range starts {
		input := acpIncarnationRecord(20 + index)
		input.Binding.StartedAt = start
		value, err := store.RegisterVerified(ctx, input)
		if err != nil {
			t.Fatal("register nanosecond identity failed")
		}
		acpIncarnationAssertRecord(t, value, input)
		acpIncarnationAssertLookups(t, store, ctx, input)
		var stored, dataType string
		if err := database.QueryRowContext(ctx, `
SELECT started_at,pg_typeof(started_at)::text FROM runtime_controller.acp_incarnation_registrations
WHERE controller_scope=$1 AND registration_id=$2`, input.Scope, input.Registration.RegistrationID).
			Scan(&stored, &dataType); err != nil || stored != start || dataType != "text" {
			t.Fatal("PostgreSQL rounded or changed the start identity")
		}
	}
	acpIncarnationAssertCount(t, database, ctx, 2)
}

func TestAcpIncarnationRepositoryConcurrentStopRetainsFirstPersistedReceipt(t *testing.T) {
	first, database, ctx := integrationRepository(t)
	second, _, closeSecond := acpIncarnationOpenRepository(t, ctx, first.lockDatabase, "")
	input := acpIncarnationRecord(30)
	if _, err := first.RegisterVerified(ctx, input); err != nil {
		t.Fatal("register stop fixture failed")
	}
	candidates := [2]acpincarnation.StopReceipt{
		{ReceiptID: acpIncarnationUUID(31), Reason: "container_stopped", ObservedAt: time.Date(2026, 10, 2, 1, 2, 3, 654321987, time.UTC)},
		{ReceiptID: acpIncarnationUUID(32), Reason: "container_restarted", ObservedAt: time.Date(2026, 10, 2, 1, 2, 4, 777888999, time.UTC)},
	}
	stores := [2]*Repository{first, second}
	results := acpIncarnationParallel(t, ctx, func(callCtx context.Context, index int) acpIncarnationResult {
		record, err := stores[index].RecordStopped(callCtx, input.Scope, input.Registration.RegistrationID, input.Binding, candidates[index])
		return acpIncarnationResult{record: record, err: err}
	})
	for _, result := range results {
		if result.err != nil || result.record.Stop == nil {
			t.Fatal("concurrent stop did not return a persisted receipt")
		}
	}
	acpIncarnationAssertRecord(t, results[0].record, results[1].record)
	winner := results[0].record
	if winner.Stop.ReceiptID != candidates[0].ReceiptID && winner.Stop.ReceiptID != candidates[1].ReceiptID {
		t.Fatal("stop receipt did not belong to either observation")
	}
	base := winner
	base.Stop = nil
	acpIncarnationAssertRecord(t, base, input)
	var persisted acpincarnation.StopReceipt
	if err := database.QueryRowContext(ctx, `
SELECT stop_receipt_id,stop_reason,stopped_at FROM runtime_controller.acp_incarnation_registrations
WHERE controller_scope=$1 AND registration_id=$2`, input.Scope, input.Registration.RegistrationID).
		Scan(&persisted.ReceiptID, &persisted.Reason, &persisted.ObservedAt); err != nil {
		t.Fatal("read persisted stop failed")
	}
	if winner.Stop.ReceiptID != persisted.ReceiptID || winner.Stop.Reason != persisted.Reason || !winner.Stop.ObservedAt.Equal(persisted.ObservedAt) {
		t.Fatal("first stop response did not use the actual PostgreSQL timestamp and receipt")
	}
	for _, candidate := range candidates {
		if candidate.ReceiptID == persisted.ReceiptID && candidate.Reason != persisted.Reason {
			t.Fatal("stop receipt mixed two observations")
		}
	}
	before := acpIncarnationRows(t, database, ctx)
	later := acpincarnation.StopReceipt{ReceiptID: acpIncarnationUUID(33), Reason: "container_removed", ObservedAt: time.Now().UTC()}
	replayed, err := second.RecordStopped(ctx, input.Scope, input.Registration.RegistrationID, input.Binding, later)
	if err != nil {
		t.Fatal("persisted stop replay failed")
	}
	acpIncarnationAssertRecord(t, replayed, winner)
	for _, scenario := range []string{"scope", "registration", "engine", "container", "started_at"} {
		scope, id, binding := input.Scope, input.Registration.RegistrationID, input.Binding
		switch scenario {
		case "scope":
			scope = "other-scope"
		case "registration":
			id = acpIncarnationUUID(34)
		case "engine":
			binding.EngineID = "other-engine"
		case "container":
			binding.ContainerID = strings.Repeat("b", 64)
		case "started_at":
			binding.StartedAt = "2026-10-01T01:02:03.123456788Z"
		}
		value, err := second.RecordStopped(ctx, scope, id, binding, later)
		if !errors.Is(err, acpincarnation.ErrConflict) || !reflect.DeepEqual(value, acpincarnation.Record{}) {
			t.Fatal("stop accepted a missing registration or different platform binding")
		}
	}
	if acpIncarnationRows(t, database, ctx) != before {
		t.Fatal("stop replay or conflict changed the first receipt")
	}
	closeSecond()
	reopened, _, _ := acpIncarnationOpenRepository(t, ctx, first.lockDatabase, "")
	acpIncarnationAssertLookups(t, reopened, ctx, winner)
	replayed, err = reopened.RecordStopped(ctx, input.Scope, input.Registration.RegistrationID, input.Binding, later)
	if err != nil {
		t.Fatal("stop replay after reopening failed")
	}
	acpIncarnationAssertRecord(t, replayed, winner)
	acpIncarnationAssertCount(t, database, ctx, 1)
}

func TestAcpIncarnationRepositoryWriteAndCommitFailuresRollBack(t *testing.T) {
	for _, mutation := range []string{"register", "stop"} {
		for _, timing := range []string{"statement", "commit"} {
			t.Run(mutation+"/"+timing, func(t *testing.T) {
				store, database, ctx := integrationRepository(t)
				input := acpIncarnationRecord(40)
				if mutation == "stop" {
					if _, err := store.RegisterVerified(ctx, input); err != nil {
						t.Fatal("register rollback fixture failed")
					}
				}
				before := acpIncarnationRows(t, database, ctx)
				removeFault := acpIncarnationInstallFault(t, database, ctx, timing == "commit")
				defer removeFault()
				stop := acpincarnation.StopReceipt{ReceiptID: acpIncarnationUUID(41), Reason: "container_removed", ObservedAt: time.Now().UTC()}
				write := func() (acpincarnation.Record, error) {
					if mutation == "register" {
						return store.RegisterVerified(ctx, input)
					}
					return store.RecordStopped(ctx, input.Scope, input.Registration.RegistrationID, input.Binding, stop)
				}
				value, err := write()
				var postgresError *pgconn.PgError
				if !errors.As(err, &postgresError) || postgresError.Code != "P0001" || !reflect.DeepEqual(value, acpincarnation.Record{}) {
					t.Fatal("failed write or commit was reported as a successful receipt")
				}
				if acpIncarnationRows(t, database, ctx) != before {
					t.Fatal("failed mutation left partial incarnation state")
				}
				removeFault()
				value, err = write()
				if err != nil {
					t.Fatal("original mutation did not succeed after removing its fault")
				}
				if mutation == "register" {
					acpIncarnationAssertRecord(t, value, input)
				} else if value.Stop == nil || value.Stop.ReceiptID != stop.ReceiptID {
					t.Fatal("retried stop did not persist its original receipt")
				}
				acpIncarnationAssertLookups(t, store, ctx, value)
				acpIncarnationAssertCount(t, database, ctx, 1)
			})
		}
	}
}

func TestAcpIncarnationRepositoryCancellationJoinsActualDatabaseWork(t *testing.T) {
	for _, method := range []string{"find", "get", "register", "stop"} {
		t.Run(method, func(t *testing.T) {
			primary, database, ctx := integrationRepository(t)
			input := acpIncarnationRecord(50)
			if _, err := primary.RegisterVerified(ctx, input); err != nil {
				t.Fatal("register cancellation fixture failed")
			}
			before := acpIncarnationRows(t, database, ctx)
			applicationName := "acp-incarnation-cancel-" + method
			worker, workerDatabase, closeWorker := acpIncarnationOpenRepository(t, ctx, primary.lockDatabase, applicationName)
			var workerPID int
			if err := workerDatabase.QueryRowContext(ctx, "SELECT pg_backend_pid()").Scan(&workerPID); err != nil {
				t.Fatal("read worker backend identity failed")
			}
			holder, err := database.BeginTx(ctx, nil)
			if err != nil {
				t.Fatal("begin held table lock failed")
			}
			var releaseOnce sync.Once
			release := func() {
				releaseOnce.Do(func() {
					if err := holder.Rollback(); err != nil && !errors.Is(err, sql.ErrTxDone) {
						t.Error("release held incarnation lock failed")
					}
				})
			}
			defer release()
			var holderPID int
			if err := holder.QueryRowContext(ctx, "SELECT pg_backend_pid()").Scan(&holderPID); err != nil || holderPID == workerPID {
				t.Fatal("held lock did not have an independent backend")
			}
			if _, err := holder.ExecContext(ctx, "LOCK TABLE runtime_controller.acp_incarnation_registrations IN ACCESS EXCLUSIVE MODE"); err != nil {
				t.Fatal("acquire incarnation table lock failed")
			}
			callCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
			done := make(chan acpIncarnationResult, 1)
			joined := false
			defer func() {
				cancel()
				// Release before joining even when a lock-observation assertion fails.
				release()
				if !joined {
					select {
					case <-done:
					case <-time.After(10 * time.Second):
						t.Error("cancelled incarnation operation did not actually join")
					}
				}
			}()
			go func() {
				result := acpIncarnationResult{}
				switch method {
				case "find", "get":
					var value *acpincarnation.Record
					if method == "find" {
						value, result.err = worker.FindRegistration(callCtx, input.Scope, input.Registration.MemberID, input.Registration.IncarnationID)
					} else {
						value, result.err = worker.GetRegistration(callCtx, input.Scope, input.Registration.RegistrationID)
					}
					if value != nil {
						result.record = *value
						result.found = true
					}
				case "register":
					candidate := acpIncarnationRecord(51)
					result.record, result.err = worker.RegisterVerified(callCtx, candidate)
				case "stop":
					stop := acpincarnation.StopReceipt{ReceiptID: acpIncarnationUUID(52), Reason: "container_stopped", ObservedAt: time.Now().UTC()}
					result.record, result.err = worker.RecordStopped(callCtx, input.Scope, input.Registration.RegistrationID, input.Binding, stop)
				}
				done <- result
			}()
			acpIncarnationWaitForLock(t, ctx, database, workerPID, holderPID, applicationName)
			cancel()
			var result acpIncarnationResult
			select {
			case result = <-done:
				joined = true
			case <-time.After(5 * time.Second):
				t.Fatal("cancelled operation did not return while the database lock remained held")
			}
			if !errors.Is(result.err, context.Canceled) || result.found || !reflect.DeepEqual(result.record, acpincarnation.Record{}) {
				t.Fatal("database cancellation became a success, miss, or nonempty result")
			}
			var originalWork, originalLocks, holderStillLocked bool
			if err := database.QueryRowContext(ctx, `
SELECT
  EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid=$1
          AND (state='active' OR state LIKE 'idle in transaction%' OR backend_xid IS NOT NULL)),
  EXISTS (SELECT 1 FROM pg_locks WHERE pid=$1),
  EXISTS (SELECT 1 FROM pg_locks WHERE pid=$2 AND granted AND mode='AccessExclusiveLock'
          AND relation='runtime_controller.acp_incarnation_registrations'::regclass)`, workerPID, holderPID).
				Scan(&originalWork, &originalLocks, &holderStillLocked); err != nil {
				t.Fatal("observe actual database cleanup failed")
			}
			if !holderStillLocked || workerDatabase.Stats().InUse != 0 {
				t.Fatalf("operation returned before cleanup joined: work=%t locks=%t holder=%t pool_in_use=%d", originalWork, originalLocks, holderStillLocked, workerDatabase.Stats().InUse)
			}
			if originalWork || originalLocks {
				// The owned connection has returned. Independently require the
				// server's actual locks and work to finish before fixture release;
				// a single cross-connection snapshot is not a client join receipt.
				cleanupCtx, stopCleanup := context.WithTimeout(ctx, 5*time.Second)
				defer stopCleanup()
				ticker := time.NewTicker(10 * time.Millisecond)
				defer ticker.Stop()
				for originalWork || originalLocks {
					select {
					case <-cleanupCtx.Done():
						t.Fatal("original PostgreSQL backend work did not finish after cancellation")
					case <-ticker.C:
					}
					if err := database.QueryRowContext(cleanupCtx, `SELECT
EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid=$1
AND (state='active' OR state LIKE 'idle in transaction%' OR backend_xid IS NOT NULL)),
EXISTS (SELECT 1 FROM pg_locks WHERE pid=$1)`, workerPID).Scan(&originalWork, &originalLocks); err != nil {
						t.Fatal("observe original backend cleanup failed")
					}
				}
				t.Log("original PostgreSQL backend work and locks cleared after the owned connection returned")
			}
			release()
			if acpIncarnationRows(t, database, ctx) != before {
				t.Fatal("cancelled operation changed incarnation persistence")
			}
			closeWorker()
			if workerDatabase.Stats().OpenConnections != 0 {
				t.Fatal("cancelled worker database retained a connection")
			}
		})
	}
}

func TestAcpIncarnationRepositoryUpgradeFromThirteenPreservesHistory(t *testing.T) {
	store, database, ctx := integrationRepository(t)
	// This test owns the isolated fixture database. Rebuild the actual v13
	// predecessor from its original migrations, rather than editing old SQL.
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal("begin predecessor schema fixture failed")
	}
	defer func() {
		if err := tx.Rollback(); err != nil && !errors.Is(err, sql.ErrTxDone) {
			t.Error("rollback predecessor fixture failed")
		}
	}()
	if _, err := tx.ExecContext(ctx, "DROP SCHEMA runtime_controller CASCADE"); err != nil {
		t.Fatal("reset isolated predecessor schema failed")
	}
	if _, err := tx.ExecContext(ctx, bootstrapSQL); err != nil {
		t.Fatal("bootstrap predecessor schema failed")
	}
	for _, migration := range schemaMigrations {
		if migration.version > 13 {
			break
		}
		if _, err := tx.ExecContext(ctx, migration.sql); err != nil {
			t.Fatal("apply original predecessor migration failed")
		}
		if _, err := tx.ExecContext(ctx, `
INSERT INTO runtime_controller.schema_migrations(version,name,checksum) VALUES ($1,$2,$3)`, migration.version, migration.name, migration.checksum); err != nil {
			t.Fatal("record predecessor migration failed")
		}
	}
	if err := tx.Commit(); err != nil {
		t.Fatal("commit predecessor fixture failed")
	}
	var version int
	var incarnationTable sql.NullString
	if err := database.QueryRowContext(ctx, `
SELECT (SELECT MAX(version) FROM runtime_controller.schema_migrations),
       to_regclass('runtime_controller.acp_incarnation_registrations')::text`).Scan(&version, &incarnationTable); err != nil || version != 13 || incarnationTable.Valid {
		t.Fatal("fixture is not the actual version thirteen predecessor")
	}
	operation := integrationOperation("incarnation-upgrade-retained", deployment.OperationInitializeRuntime, time.Now().UTC())
	operation.Transition = deployment.LifecycleInitializing
	accepted, replay, err := store.BeginTransition(ctx, operation)
	if err != nil || replay {
		t.Fatal("create retained lifecycle history failed")
	}
	persistedOperation, err := store.GetOperation(ctx, accepted.RequestID)
	if err != nil {
		t.Fatal("read retained lifecycle history before upgrade failed")
	}
	before := acpIncarnationLegacyRows(t, database, ctx)
	journal := acpIncarnationMigrationJournal(t, database, ctx)
	for range 2 {
		if err := Migrate(ctx, database); err != nil {
			t.Fatal("upgrade incarnation registry or repeat migration failed")
		}
		if !reflect.DeepEqual(acpIncarnationLegacyRows(t, database, ctx), before) || acpIncarnationMigrationJournal(t, database, ctx) != journal {
			t.Fatal("incarnation migration changed existing business history or old migration journal")
		}
		if err := database.QueryRowContext(ctx, "SELECT MAX(version) FROM runtime_controller.schema_migrations").Scan(&version); err != nil || version != 15 {
			t.Fatal("incarnation migrations did not install the registry and complete member history")
		}
		retained, err := store.GetOperation(ctx, accepted.RequestID)
		if err != nil || !reflect.DeepEqual(retained, persistedOperation) {
			t.Fatal("incarnation migration changed the retained lifecycle operation")
		}
		acpIncarnationAssertCount(t, database, ctx, 0)
	}
	input := acpIncarnationRecord(60)
	value, err := store.RegisterVerified(ctx, input)
	if err != nil {
		t.Fatal("upgraded registry did not accept a verified incarnation")
	}
	acpIncarnationAssertRecord(t, value, input)
}

type acpIncarnationResult struct {
	record acpincarnation.Record
	found  bool
	err    error
}

func acpIncarnationUUID(index int) string {
	return fmt.Sprintf("%08x-0000-4000-8000-%012x", index, index)
}

func acpIncarnationRecord(index int) acpincarnation.Record {
	return acpincarnation.Record{
		Scope: "incarnation-controller-scope",
		Registration: acpincarnation.Registration{
			RegistrationID: acpIncarnationUUID(index), MemberID: "acp-a", IncarnationID: acpIncarnationUUID(index + 1000),
		},
		NonceDigest: sha256.Sum256([]byte(strings.Repeat("e", 64))),
		Binding: acpincarnation.Binding{
			EngineID: "engine-a", ContainerID: strings.Repeat("a", 64), StartedAt: "2026-10-01T01:02:03.123456789Z",
		},
	}
}

func acpIncarnationAssertRecord(t *testing.T, actual, expected acpincarnation.Record) {
	t.Helper()
	actualStop, expectedStop := actual.Stop, expected.Stop
	actual.Stop, expected.Stop = nil, nil
	if actual != expected || (actualStop == nil) != (expectedStop == nil) {
		t.Fatal("incarnation record lost its complete identity or source")
	}
	if actualStop != nil && (actualStop.ReceiptID != expectedStop.ReceiptID || actualStop.Reason != expectedStop.Reason || !actualStop.ObservedAt.Equal(expectedStop.ObservedAt)) {
		t.Fatal("incarnation record changed its first persisted stop receipt")
	}
}

func acpIncarnationAssertLookups(t *testing.T, store *Repository, ctx context.Context, expected acpincarnation.Record) {
	t.Helper()
	byTuple, err := store.FindRegistration(ctx, expected.Scope, expected.Registration.MemberID, expected.Registration.IncarnationID)
	if err != nil || byTuple == nil {
		t.Fatal("lookup by incarnation tuple failed")
	}
	acpIncarnationAssertRecord(t, *byTuple, expected)
	byID, err := store.GetRegistration(ctx, expected.Scope, expected.Registration.RegistrationID)
	if err != nil || byID == nil {
		t.Fatal("lookup by registration identity failed")
	}
	acpIncarnationAssertRecord(t, *byID, expected)
}

func acpIncarnationAssertCount(t *testing.T, database *sql.DB, ctx context.Context, expected int) {
	t.Helper()
	var count int
	if err := database.QueryRowContext(ctx, "SELECT COUNT(*) FROM runtime_controller.acp_incarnation_registrations").Scan(&count); err != nil || count != expected {
		t.Fatal("incarnation registration count changed")
	}
}

func acpIncarnationOpenRepository(t *testing.T, ctx context.Context, lockDatabase *sql.DB, applicationName string) (*Repository, *sql.DB, func()) {
	t.Helper()
	// Only integrationRepository owns schema reset. Every additional repository
	// opens its own real pool against that same already-migrated database.
	database, err := OpenDatabase(ctx, os.Getenv("ANTNEST_RUNTIME_CONTROLLER_TEST_DATABASE_URL"), 1, 1)
	if err != nil {
		t.Fatal("open additional incarnation database failed")
	}
	var once sync.Once
	closeDatabase := func() {
		once.Do(func() {
			if err := database.Close(); err != nil {
				t.Error("close additional incarnation database failed")
			}
		})
	}
	t.Cleanup(closeDatabase)
	if applicationName != "" {
		if _, err := database.ExecContext(ctx, "SELECT set_config('application_name',$1,false)", applicationName); err != nil {
			t.Fatal("set owned incarnation backend application name failed")
		}
	}
	store, err := New(database, lockDatabase, time.Hour, 1_000_000)
	if err != nil {
		t.Fatal("construct additional incarnation repository failed")
	}
	return store, database, closeDatabase
}

func acpIncarnationParallel(t *testing.T, ctx context.Context, call func(context.Context, int) acpIncarnationResult) [2]acpIncarnationResult {
	t.Helper()
	callCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	start := make(chan struct{})
	results := [2]acpIncarnationResult{}
	var joined sync.WaitGroup
	for index := range results {
		joined.Add(1)
		go func() {
			defer joined.Done()
			<-start
			results[index] = call(callCtx, index)
		}()
	}
	done := make(chan struct{})
	go func() {
		joined.Wait()
		close(done)
	}()
	close(start)
	select {
	case <-done:
	case <-callCtx.Done():
		cancel()
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			t.Fatal("concurrent incarnation operations did not actually join")
		}
		t.Fatal("concurrent incarnation operations exceeded their deadline")
	}
	return results
}

func acpIncarnationRows(t *testing.T, database *sql.DB, ctx context.Context) string {
	t.Helper()
	var value string
	if err := database.QueryRowContext(ctx, `
SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY controller_scope,registration_id),'[]'::jsonb)::text
FROM runtime_controller.acp_incarnation_registrations r`).Scan(&value); err != nil {
		t.Fatal("snapshot incarnation rows failed")
	}
	return value
}

func acpIncarnationInstallFault(t *testing.T, database *sql.DB, ctx context.Context, deferred bool) func() {
	t.Helper()
	if _, err := database.ExecContext(ctx, `
CREATE FUNCTION runtime_controller.acp_incarnation_fixture_fault() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'incarnation fixture fault' USING ERRCODE='P0001'; END; $$`); err != nil {
		t.Fatal("install incarnation fault function failed")
	}
	var once sync.Once
	remove := func() {
		once.Do(func() {
			cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if _, err := database.ExecContext(cleanupCtx, "DROP TRIGGER IF EXISTS acp_incarnation_fixture_fault ON runtime_controller.acp_incarnation_registrations"); err != nil {
				t.Error("remove incarnation fault trigger failed")
			}
			if _, err := database.ExecContext(cleanupCtx, "DROP FUNCTION IF EXISTS runtime_controller.acp_incarnation_fixture_fault()"); err != nil {
				t.Error("remove incarnation fault function failed")
			}
		})
	}
	t.Cleanup(remove)
	query := `CREATE TRIGGER acp_incarnation_fixture_fault BEFORE INSERT OR UPDATE
ON runtime_controller.acp_incarnation_registrations FOR EACH ROW
EXECUTE FUNCTION runtime_controller.acp_incarnation_fixture_fault()`
	if deferred {
		query = `CREATE CONSTRAINT TRIGGER acp_incarnation_fixture_fault AFTER INSERT OR UPDATE
ON runtime_controller.acp_incarnation_registrations DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION runtime_controller.acp_incarnation_fixture_fault()`
	}
	if _, err := database.ExecContext(ctx, query); err != nil {
		t.Fatal("install incarnation fault trigger failed")
	}
	return remove
}

func acpIncarnationWaitForLock(t *testing.T, ctx context.Context, database *sql.DB, workerPID, holderPID int, applicationName string) {
	t.Helper()
	waitCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		var blocked bool
		if err := database.QueryRowContext(waitCtx, `
SELECT EXISTS (
 SELECT 1 FROM pg_stat_activity activity JOIN pg_locks waiting ON waiting.pid=activity.pid
 WHERE activity.pid=$1 AND activity.application_name=$3 AND activity.wait_event_type='Lock'
   AND $2=ANY(pg_blocking_pids(activity.pid)) AND NOT waiting.granted
   AND waiting.relation='runtime_controller.acp_incarnation_registrations'::regclass
)`, workerPID, holderPID, applicationName).Scan(&blocked); err != nil {
			t.Fatal("observe exact incarnation database lock wait failed")
		}
		if blocked {
			return
		}
		select {
		case <-ticker.C:
		case <-waitCtx.Done():
			t.Fatal("incarnation operation did not enter its actual held database lock")
		}
	}
}

func acpIncarnationMigrationJournal(t *testing.T, database *sql.DB, ctx context.Context) string {
	t.Helper()
	var value string
	if err := database.QueryRowContext(ctx, `
SELECT COALESCE(jsonb_agg(to_jsonb(m) ORDER BY version),'[]'::jsonb)::text
FROM runtime_controller.schema_migrations m WHERE version<=13`).Scan(&value); err != nil {
		t.Fatal("snapshot predecessor migration journal failed")
	}
	return value
}

func acpIncarnationLegacyRows(t *testing.T, database *sql.DB, ctx context.Context) map[string]string {
	t.Helper()
	rows, err := database.QueryContext(ctx, `
SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='runtime_controller' AND c.relkind='r'
  AND c.relname NOT IN ('schema_migrations','acp_incarnation_registrations','acp_incarnation_histories') ORDER BY c.relname`)
	if err != nil {
		t.Fatal("list predecessor business tables failed")
	}
	var tables []string
	for rows.Next() {
		var table string
		if err := rows.Scan(&table); err != nil {
			if closeErr := rows.Close(); closeErr != nil {
				t.Error("close predecessor table inventory failed")
			}
			t.Fatal("read predecessor business table failed")
		}
		tables = append(tables, table)
	}
	iterationErr := rows.Err()
	closeErr := rows.Close()
	if iterationErr != nil || closeErr != nil {
		t.Fatal("finish predecessor table inventory failed")
	}
	result := make(map[string]string, len(tables))
	for _, table := range tables {
		query := `SELECT COALESCE(jsonb_agg(value ORDER BY value::text),'[]'::jsonb)::text
FROM (SELECT to_jsonb(r) AS value FROM ` + (pgx.Identifier{"runtime_controller", table}).Sanitize() + ` r) snapshot`
		var value string
		if err := database.QueryRowContext(ctx, query).Scan(&value); err != nil {
			t.Fatal("snapshot predecessor business rows failed")
		}
		result[table] = value
	}
	return result
}

func TestAcpIncarnationRepositoryClassifiesOnlyOwnedUniqueConstraint(t *testing.T) {
	t.Run("registration primary key", func(t *testing.T) {
		store, database, ctx := integrationRepository(t)
		original := acpIncarnationRecord(70)
		if _, err := store.RegisterVerified(ctx, original); err != nil {
			t.Fatal("register primary key collision fixture failed")
		}
		before := acpIncarnationRows(t, database, ctx)
		candidate := acpIncarnationRecord(71)
		candidate.Registration.RegistrationID = original.Registration.RegistrationID
		value, err := store.RegisterVerified(ctx, candidate)
		if !errors.Is(err, acpincarnation.ErrConflict) || !reflect.DeepEqual(value, acpincarnation.Record{}) {
			t.Fatal("registration primary key collision lost its typed conflict")
		}
		if acpIncarnationRows(t, database, ctx) != before {
			t.Fatal("registration primary key collision changed the original binding")
		}
		acpIncarnationAssertLookups(t, store, ctx, original)
		acpIncarnationAssertCount(t, database, ctx, 1)
	})

	t.Run("unrelated unique violation", func(t *testing.T) {
		store, database, ctx := integrationRepository(t)
		t.Cleanup(func() {
			cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if _, err := database.ExecContext(cleanupCtx, "DROP TRIGGER IF EXISTS acp_incarnation_fixture_unrelated_unique ON runtime_controller.acp_incarnation_registrations"); err != nil {
				t.Error("remove unrelated unique violation trigger failed")
			}
			if _, err := database.ExecContext(cleanupCtx, "DROP FUNCTION IF EXISTS runtime_controller.acp_incarnation_fixture_unrelated_unique()"); err != nil {
				t.Error("remove unrelated unique violation function failed")
			}
		})
		if _, err := database.ExecContext(ctx, `
CREATE FUNCTION runtime_controller.acp_incarnation_fixture_unrelated_unique() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE unique_violation USING CONSTRAINT='unrelated_unique'; END; $$`); err != nil {
			t.Fatal("install unrelated unique violation function failed")
		}
		if _, err := database.ExecContext(ctx, `
CREATE TRIGGER acp_incarnation_fixture_unrelated_unique BEFORE INSERT
ON runtime_controller.acp_incarnation_registrations FOR EACH ROW
EXECUTE FUNCTION runtime_controller.acp_incarnation_fixture_unrelated_unique()`); err != nil {
			t.Fatal("install unrelated unique violation trigger failed")
		}
		value, err := store.RegisterVerified(ctx, acpIncarnationRecord(72))
		var postgresError *pgconn.PgError
		if errors.Is(err, acpincarnation.ErrConflict) || !errors.As(err, &postgresError) ||
			postgresError.Code != "23505" || postgresError.ConstraintName != "unrelated_unique" ||
			!reflect.DeepEqual(value, acpincarnation.Record{}) {
			t.Fatal("unrelated unique violation became a registration conflict or successful receipt")
		}
		acpIncarnationAssertCount(t, database, ctx, 0)
	})
}
