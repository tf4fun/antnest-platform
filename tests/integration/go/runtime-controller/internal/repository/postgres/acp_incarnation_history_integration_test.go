package postgres

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"reflect"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/acpincarnation"
)

func acpHistoryRead(t *testing.T, store *Repository, ctx context.Context, scope, member string, cursor *acpincarnation.HistoryCursor) acpincarnation.HistoryPage {
	t.Helper()
	page, err := store.ReadRegistrationHistory(ctx, scope, member, cursor)
	if err != nil {
		t.Fatal("read persisted member registration history failed")
	}
	return page
}

func acpHistoryAssertPage(t *testing.T, page acpincarnation.HistoryPage, member, historyID, revision, after string, registrations []acpincarnation.Registration) {
	t.Helper()
	if page.MemberID != member || page.HistoryID == "" || (historyID != "" && page.HistoryID != historyID) || page.SnapshotRevision != revision || page.AfterSequence != after || len(page.Items) != len(registrations) {
		t.Fatal("history page changed its member, persistent identity, frozen revision or exclusive cursor")
	}
	sequence, err := strconv.ParseInt(after, 10, 64)
	if err != nil {
		t.Fatal("invalid expected test history cursor")
	}
	for index, entry := range page.Items {
		if entry.Sequence != strconv.FormatInt(sequence+int64(index)+1, 10) || entry.Registration != registrations[index] {
			t.Fatal("history page lost a contiguous sequence or original complete registration")
		}
	}
}

func acpHistorySnapshot(t *testing.T, database *sql.DB, ctx context.Context) string {
	t.Helper()
	var snapshot string
	if err := database.QueryRowContext(ctx, `SELECT jsonb_build_object(
'heads',(SELECT COALESCE(jsonb_agg(to_jsonb(h) ORDER BY controller_scope,member_id),'[]'::jsonb)
         FROM runtime_controller.acp_incarnation_histories h),
'registrations',(SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY controller_scope,registration_id),'[]'::jsonb)
                 FROM runtime_controller.acp_incarnation_registrations r))::text`).Scan(&snapshot); err != nil {
		t.Fatal("snapshot member history and original registration facts failed")
	}
	return snapshot
}

func TestAcpIncarnationHistoryEmptyIdentityIsStableAcrossReopen(t *testing.T) {
	store, database, ctx := integrationRepository(t)
	input := acpIncarnationRecord(100)
	first := acpHistoryRead(t, store, ctx, input.Scope, input.Registration.MemberID, nil)
	acpHistoryAssertPage(t, first, input.Registration.MemberID, "", "0", "0", nil)
	if first.NextCursor != nil {
		t.Fatal("empty history returned a continuation")
	}
	var persistedID, revision string
	if err := database.QueryRowContext(ctx, "SELECT history_id::text,revision::text FROM runtime_controller.acp_incarnation_histories WHERE controller_scope=$1 AND member_id=$2", input.Scope, input.Registration.MemberID).Scan(&persistedID, &revision); err != nil || persistedID != first.HistoryID || revision != "0" {
		t.Fatal("empty member history did not persist its original identity and zero revision")
	}
	before := acpHistorySnapshot(t, database, ctx)
	if next := acpHistoryRead(t, store, ctx, input.Scope, input.Registration.MemberID, nil); !reflect.DeepEqual(first, next) {
		t.Fatal("repeated empty history invented a new history identity")
	}
	reopened, extra, closeExtra := acpIncarnationOpenRepository(t, ctx, store.lockDatabase, "")
	if next := acpHistoryRead(t, reopened, ctx, input.Scope, input.Registration.MemberID, nil); !reflect.DeepEqual(first, next) {
		t.Fatal("empty history identity was not persisted across connections")
	}
	closeExtra()
	if extra.Stats().OpenConnections != 0 || acpHistorySnapshot(t, database, ctx) != before {
		t.Fatal("empty replay changed persistence or retained its original connection")
	}
	acpIncarnationAssertCount(t, database, ctx, 0)
}

func TestAcpIncarnationHistoryPagesFreezeRevisionAndReplayExactly(t *testing.T) {
	store, database, ctx := integrationRepository(t)
	input := acpIncarnationRecord(200)
	registrations := make([]acpincarnation.Registration, 0, 66)
	for index := range 65 {
		record := acpIncarnationRecord(200 + index)
		stored, err := store.RegisterVerified(ctx, record)
		if err != nil {
			t.Fatal("append original history tuple failed")
		}
		acpIncarnationAssertRecord(t, stored, record)
		registrations = append(registrations, stored.Registration)
	}
	first := acpHistoryRead(t, store, ctx, input.Scope, input.Registration.MemberID, nil)
	acpHistoryAssertPage(t, first, input.Registration.MemberID, "", "65", "0", registrations[:64])
	if first.NextCursor == nil || *first.NextCursor != (acpincarnation.HistoryCursor{HistoryID: first.HistoryID, SnapshotRevision: "65", AfterSequence: "64"}) {
		t.Fatal("first page did not expose the fixed 64-item continuation")
	}
	appended, err := store.RegisterVerified(ctx, acpIncarnationRecord(265))
	if err != nil {
		t.Fatal("append during original history snapshot failed")
	}
	registrations = append(registrations, appended.Registration)
	last := acpHistoryRead(t, store, ctx, input.Scope, input.Registration.MemberID, first.NextCursor)
	acpHistoryAssertPage(t, last, input.Registration.MemberID, first.HistoryID, "65", "64", registrations[64:65])
	if last.NextCursor != nil {
		t.Fatal("frozen last page mixed the later append into its snapshot")
	}
	initialCursor := &acpincarnation.HistoryCursor{HistoryID: first.HistoryID, SnapshotRevision: "65", AfterSequence: "0"}
	if replay := acpHistoryRead(t, store, ctx, input.Scope, input.Registration.MemberID, initialCursor); !reflect.DeepEqual(first, replay) {
		t.Fatal("original first page changed when replayed after append")
	}
	if replay := acpHistoryRead(t, store, ctx, input.Scope, input.Registration.MemberID, first.NextCursor); !reflect.DeepEqual(last, replay) {
		t.Fatal("original continuation changed when replayed")
	}
	fresh := acpHistoryRead(t, store, ctx, input.Scope, input.Registration.MemberID, nil)
	acpHistoryAssertPage(t, fresh, input.Registration.MemberID, first.HistoryID, "66", "0", registrations[:64])
	if fresh.NextCursor == nil || fresh.NextCursor.SnapshotRevision != "66" {
		t.Fatal("fresh history did not capture the new committed revision")
	}
	freshLast := acpHistoryRead(t, store, ctx, input.Scope, input.Registration.MemberID, fresh.NextCursor)
	acpHistoryAssertPage(t, freshLast, input.Registration.MemberID, first.HistoryID, "66", "64", registrations[64:])
	if freshLast.NextCursor != nil {
		t.Fatal("fresh final page returned a spurious continuation")
	}
	acpIncarnationAssertCount(t, database, ctx, 66)
}

func TestAcpIncarnationHistoryConcurrentExactTupleRetriesDoNotAdvanceRevision(t *testing.T) {
	first, database, ctx := integrationRepository(t)
	second, extra, closeExtra := acpIncarnationOpenRepository(t, ctx, first.lockDatabase, "")
	input := acpIncarnationRecord(300)
	original, err := first.RegisterVerified(ctx, input)
	if err != nil {
		t.Fatal("register concurrent history fixture failed")
	}
	before := acpHistorySnapshot(t, database, ctx)
	stores := [2]*Repository{first, second}
	results := acpIncarnationParallel(t, ctx, func(callCtx context.Context, index int) acpIncarnationResult {
		retry := input
		retry.Registration.RegistrationID = acpIncarnationUUID(301 + index)
		value, err := stores[index].RegisterVerified(callCtx, retry)
		return acpIncarnationResult{record: value, err: err}
	})
	for _, result := range results {
		if result.err != nil {
			t.Fatal("exact concurrent tuple retry failed")
		}
		acpIncarnationAssertRecord(t, result.record, original)
	}
	page := acpHistoryRead(t, first, ctx, input.Scope, input.Registration.MemberID, nil)
	acpHistoryAssertPage(t, page, input.Registration.MemberID, "", "1", "0", []acpincarnation.Registration{original.Registration})
	if page.NextCursor != nil || acpHistorySnapshot(t, database, ctx) != before {
		t.Fatal("exact retries allocated a sequence, changed the head or replaced the original tuple")
	}
	closeExtra()
	if extra.Stats().OpenConnections != 0 {
		t.Fatal("concurrent retry database retained a connection")
	}
	acpIncarnationAssertCount(t, database, ctx, 1)
}

func TestAcpIncarnationHistoryRejectsForeignAndOutOfRangeCursorsWithoutMutation(t *testing.T) {
	store, database, ctx := integrationRepository(t)
	input := acpIncarnationRecord(400)
	for group := range 3 {
		for index := range 2 {
			record := acpIncarnationRecord(400 + group*2 + index)
			if group == 1 {
				record.Scope = "other-history-scope"
			} else if group == 2 {
				record.Registration.MemberID = "acp-b"
			}
			if _, err := store.RegisterVerified(ctx, record); err != nil {
				t.Fatal("seed independent member history failed")
			}
		}
	}
	page := acpHistoryRead(t, store, ctx, input.Scope, input.Registration.MemberID, nil)
	base := acpincarnation.HistoryCursor{HistoryID: page.HistoryID, SnapshotRevision: "2", AfterSequence: "0"}
	before := acpHistorySnapshot(t, database, ctx)
	for _, scenario := range []string{"scope", "member", "history", "future", "after_end", "after_beyond", "zero_snapshot", "overflow", "noncanonical"} {
		t.Run(scenario, func(t *testing.T) {
			cursor, scope, member := base, input.Scope, input.Registration.MemberID
			switch scenario {
			case "scope":
				scope = "other-history-scope"
			case "member":
				member = "acp-b"
			case "history":
				cursor.HistoryID = acpIncarnationUUID(499)
			case "future":
				cursor.SnapshotRevision = "3"
			case "after_end":
				cursor.AfterSequence = "2"
			case "after_beyond":
				cursor.AfterSequence = "3"
			case "zero_snapshot":
				cursor.SnapshotRevision = "0"
			case "overflow":
				cursor.SnapshotRevision = "9223372036854775808"
			case "noncanonical":
				cursor.AfterSequence = "00"
			}
			value, err := store.ReadRegistrationHistory(ctx, scope, member, &cursor)
			if err == nil || !reflect.DeepEqual(value, acpincarnation.HistoryPage{}) {
				t.Fatal("invalid continuation returned a history page")
			}
			if acpHistorySnapshot(t, database, ctx) != before {
				t.Fatal("rejected history cursor changed original registrations or history heads")
			}
		})
	}
	acpIncarnationAssertCount(t, database, ctx, 6)
}

func TestAcpIncarnationHistoryUpgradeFromFourteenBackfillsEveryOriginalRecord(t *testing.T) {
	store, database, ctx := integrationRepository(t)
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal("begin actual v14 predecessor failed")
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
		t.Fatal("bootstrap actual predecessor failed")
	}
	for _, migration := range schemaMigrations {
		if migration.version > 14 {
			break
		}
		if _, err := tx.ExecContext(ctx, migration.sql); err != nil {
			t.Fatal("apply original v14 migration failed")
		}
		if _, err := tx.ExecContext(ctx, "INSERT INTO runtime_controller.schema_migrations(version,name,checksum) VALUES ($1,$2,$3)", migration.version, migration.name, migration.checksum); err != nil {
			t.Fatal("record original predecessor migration failed")
		}
	}
	records := make([]acpincarnation.Record, 0, 5)
	for index := range 5 {
		record := acpIncarnationRecord(500 + index)
		record.NonceDigest[0] = byte(index + 1)
		record.Binding.EngineID = fmt.Sprintf("legacy-engine-%d", index)
		record.Binding.ContainerID = fmt.Sprintf("%064x", index+1)
		if index == 3 {
			record.Registration.MemberID = "acp-b"
		} else if index == 4 {
			record.Scope = "legacy-other-scope"
		}
		var receipt, reason, stopped any
		if index%2 == 0 {
			record.Stop = &acpincarnation.StopReceipt{ReceiptID: acpIncarnationUUID(550 + index), Reason: "container_stopped", ObservedAt: time.Date(2026, 10, 2, 1, 2, index, 123456000, time.UTC)}
			receipt, reason, stopped = record.Stop.ReceiptID, record.Stop.Reason, record.Stop.ObservedAt
		}
		// Insert the real old schema directly: the new RegisterVerified method
		// cannot be used to manufacture a version-fourteen predecessor.
		if _, err := tx.ExecContext(ctx, `INSERT INTO runtime_controller.acp_incarnation_registrations
(controller_scope,registration_id,member_id,incarnation_id,nonce_digest,engine_id,container_id,started_at,stop_receipt_id,stop_reason,stopped_at)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, record.Scope, record.Registration.RegistrationID,
			record.Registration.MemberID, record.Registration.IncarnationID, record.NonceDigest[:], record.Binding.EngineID,
			record.Binding.ContainerID, record.Binding.StartedAt, receipt, reason, stopped); err != nil {
			t.Fatal("insert original v14 registration and stop receipt failed")
		}
		records = append(records, record)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal("commit complete v14 fixture failed")
	}
	var version int
	var historyTable sql.NullString
	if err := database.QueryRowContext(ctx, `SELECT MAX(version),to_regclass('runtime_controller.acp_incarnation_histories')::text FROM runtime_controller.schema_migrations`).Scan(&version, &historyTable); err != nil || version != 14 || historyTable.Valid {
		t.Fatal("fixture was not the original version fourteen schema")
	}
	originalRows := acpHistoryLegacyRows(t, database, ctx)
	var journal string
	if err := database.QueryRowContext(ctx, "SELECT jsonb_agg(to_jsonb(m) ORDER BY version)::text FROM runtime_controller.schema_migrations m WHERE version<=14").Scan(&journal); err != nil {
		t.Fatal("snapshot predecessor journal failed")
	}
	historyIDs := make(map[string]string)
	for range 2 {
		if err := Migrate(ctx, database); err != nil {
			t.Fatal("backfill or repeated migration failed")
		}
		var repeatedJournal string
		if err := database.QueryRowContext(ctx, "SELECT jsonb_agg(to_jsonb(m) ORDER BY version)::text FROM runtime_controller.schema_migrations m WHERE version<=14").Scan(&repeatedJournal); err != nil || repeatedJournal != journal || acpHistoryLegacyRows(t, database, ctx) != originalRows {
			t.Fatal("history backfill changed an original registration, receipt or migration")
		}
		if err := database.QueryRowContext(ctx, "SELECT MAX(version) FROM runtime_controller.schema_migrations").Scan(&version); err != nil || version != 15 {
			t.Fatal("history backfill did not install exactly migration fifteen")
		}
		groups := make(map[string][]acpincarnation.Record)
		for _, original := range records {
			stored, err := store.GetRegistration(ctx, original.Scope, original.Registration.RegistrationID)
			if err != nil || stored == nil {
				t.Fatal("upgraded registry lost an original record")
			}
			acpIncarnationAssertRecord(t, *stored, original)
			group := original.Scope + "/" + original.Registration.MemberID
			groups[group] = append(groups[group], original)
		}
		for group, originals := range groups {
			page := acpHistoryRead(t, store, ctx, originals[0].Scope, originals[0].Registration.MemberID, nil)
			if page.MemberID != originals[0].Registration.MemberID || page.HistoryID == "" || page.SnapshotRevision != strconv.Itoa(len(originals)) || page.AfterSequence != "0" || page.NextCursor != nil || len(page.Items) != len(originals) {
				t.Fatal("backfill omitted a scope/member or allocated an incomplete head")
			}
			if previous := historyIDs[group]; previous != "" && previous != page.HistoryID {
				t.Fatal("repeated migration replaced a persistent history identity")
			}
			historyIDs[group] = page.HistoryID
			want := make(map[string]acpincarnation.Registration)
			for _, original := range originals {
				want[original.Registration.RegistrationID] = original.Registration
			}
			for index, entry := range page.Items {
				if entry.Sequence != strconv.Itoa(index+1) || want[entry.Registration.RegistrationID] != entry.Registration {
					t.Fatal("backfilled member history is not complete and contiguous")
				}
				delete(want, entry.Registration.RegistrationID)
			}
			if len(want) != 0 {
				t.Fatal("backfill duplicated or omitted a legacy registration")
			}
		}
	}
	var heads int
	if err := database.QueryRowContext(ctx, "SELECT COUNT(*) FROM runtime_controller.acp_incarnation_histories").Scan(&heads); err != nil || heads != 3 {
		t.Fatal("backfill did not retain exactly the original scope/member heads")
	}
	acpIncarnationAssertCount(t, database, ctx, len(records))
}

func acpHistoryLegacyRows(t *testing.T, database *sql.DB, ctx context.Context) string {
	t.Helper()
	var rows string
	if err := database.QueryRowContext(ctx, `SELECT jsonb_agg(to_jsonb(r)-'history_sequence' ORDER BY controller_scope,registration_id)::text
FROM runtime_controller.acp_incarnation_registrations r`).Scan(&rows); err != nil {
		t.Fatal("snapshot original v14 registration columns failed")
	}
	return rows
}

func TestAcpIncarnationHistoryRollbackAndCancelledWorkLeaveNoSequenceHoles(t *testing.T) {
	for _, scenario := range []string{"statement_rollback", "commit_rollback", "cancel_register", "cancel_read"} {
		t.Run(scenario, func(t *testing.T) {
			store, database, ctx := integrationRepository(t)
			input, candidate := acpIncarnationRecord(600), acpIncarnationRecord(601)
			if _, err := store.RegisterVerified(ctx, input); err != nil {
				t.Fatal("seed original history revision failed")
			}
			original := acpHistoryRead(t, store, ctx, input.Scope, input.Registration.MemberID, nil)
			before := acpHistorySnapshot(t, database, ctx)
			if scenario == "statement_rollback" || scenario == "commit_rollback" {
				removeFault := acpIncarnationInstallFault(t, database, ctx, scenario == "commit_rollback")
				defer removeFault()
				value, err := store.RegisterVerified(ctx, candidate)
				if err == nil || !reflect.DeepEqual(value, acpincarnation.Record{}) || acpHistorySnapshot(t, database, ctx) != before {
					t.Fatal("failed registration or commit left a head revision or tuple behind")
				}
				removeFault()
			} else {
				acpHistoryCancelHeldOperation(t, store, database, ctx, input, candidate, scenario == "cancel_read")
				if acpHistorySnapshot(t, database, ctx) != before {
					t.Fatal("cancelled original work changed history persistence")
				}
			}
			stored, err := store.RegisterVerified(ctx, candidate)
			if err != nil {
				t.Fatal("registration did not recover after original rollback completed")
			}
			acpIncarnationAssertRecord(t, stored, candidate)
			page := acpHistoryRead(t, store, ctx, input.Scope, input.Registration.MemberID, nil)
			acpHistoryAssertPage(t, page, input.Registration.MemberID, original.HistoryID, "2", "0", []acpincarnation.Registration{input.Registration, stored.Registration})
			if page.NextCursor != nil {
				t.Fatal("rollback or cancellation left a sequence hole")
			}
			acpIncarnationAssertCount(t, database, ctx, 2)
		})
	}
}

func acpHistoryCancelHeldOperation(t *testing.T, primary *Repository, database *sql.DB, ctx context.Context, input, candidate acpincarnation.Record, read bool) {
	t.Helper()
	name := "acp-history-cancel-register"
	if read {
		name = "acp-history-cancel-read"
	}
	worker, extra, closeExtra := acpIncarnationOpenRepository(t, ctx, primary.lockDatabase, name)
	var workerPID int
	if err := extra.QueryRowContext(ctx, "SELECT pg_backend_pid()").Scan(&workerPID); err != nil {
		t.Fatal("read original history backend identity failed")
	}
	holder, err := database.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal("begin independent history lock failed")
	}
	var once sync.Once
	release := func() {
		once.Do(func() {
			if err := holder.Rollback(); err != nil && !errors.Is(err, sql.ErrTxDone) {
				t.Error("release original history lock failed")
			}
		})
	}
	defer release()
	var holderPID int
	if err := holder.QueryRowContext(ctx, "SELECT pg_backend_pid()").Scan(&holderPID); err != nil || holderPID == workerPID {
		t.Fatal("history blocker did not have an independent backend")
	}
	if read {
		// A pure MVCC history implementation need not lock an existing head.
		// A table lock tests its real read cancellation without imposing that design.
		if _, err := holder.ExecContext(ctx, "LOCK TABLE runtime_controller.acp_incarnation_histories IN ACCESS EXCLUSIVE MODE"); err != nil {
			t.Fatal("hold actual history read relation failed")
		}
	} else {
		var id string
		if err := holder.QueryRowContext(ctx, "SELECT history_id FROM runtime_controller.acp_incarnation_histories WHERE controller_scope=$1 AND member_id=$2 FOR UPDATE", input.Scope, input.Registration.MemberID).Scan(&id); err != nil || id == "" {
			t.Fatal("hold original member history head row failed")
		}
	}
	callCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	type result struct {
		record acpincarnation.Record
		page   acpincarnation.HistoryPage
		err    error
	}
	done := make(chan result, 1)
	joined := false
	defer func() {
		cancel()
		release()
		if !joined {
			<-done
		}
	}()
	go func() {
		var value result
		if read {
			value.page, value.err = worker.ReadRegistrationHistory(callCtx, input.Scope, input.Registration.MemberID, nil)
		} else {
			value.record, value.err = worker.RegisterVerified(callCtx, candidate)
		}
		done <- value
	}()
	acpHistoryWaitForBackend(t, database, ctx, workerPID, holderPID, name, true)
	cancel()
	var value result
	select {
	case value = <-done:
		joined = true
	case <-time.After(5 * time.Second):
		t.Fatal("cancelled history operation did not join while the original lock remained held")
	}
	if !errors.Is(value.err, context.Canceled) || !reflect.DeepEqual(value.record, acpincarnation.Record{}) || !reflect.DeepEqual(value.page, acpincarnation.HistoryPage{}) || extra.Stats().InUse != 0 {
		t.Fatal("history cancellation became a result or returned before its owned connection joined")
	}
	acpHistoryWaitForBackend(t, database, ctx, workerPID, holderPID, name, false)
	var holderLocked bool
	if err := database.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND granted AND relation='runtime_controller.acp_incarnation_histories'::regclass)", holderPID).Scan(&holderLocked); err != nil || !holderLocked {
		t.Fatal("test released its actual history blocker before original cancellation cleanup")
	}
	closeExtra()
	if extra.Stats().OpenConnections != 0 {
		t.Fatal("cancelled history database retained an original connection")
	}
	release()
}

func acpHistoryWaitForBackend(t *testing.T, database *sql.DB, ctx context.Context, workerPID, holderPID int, name string, waiting bool) {
	t.Helper()
	observe, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		var ready bool
		query := `SELECT EXISTS(SELECT 1 FROM pg_stat_activity a
WHERE a.pid=$1 AND a.application_name=$3 AND a.wait_event_type='Lock'
 AND a.query LIKE '%acp_incarnation_histories%' AND $2=ANY(pg_blocking_pids(a.pid))
 AND EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=a.pid AND NOT l.granted))`
		if !waiting {
			query = `SELECT NOT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1
 AND (state='active' OR state LIKE 'idle in transaction%' OR backend_xid IS NOT NULL))
 AND NOT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1)`
		}
		var err error
		if waiting {
			err = database.QueryRowContext(observe, query, workerPID, holderPID, name).Scan(&ready)
		} else {
			err = database.QueryRowContext(observe, query, workerPID).Scan(&ready)
		}
		if err != nil {
			t.Fatal("observe original history backend work and locks failed")
		}
		if ready {
			return
		}
		select {
		case <-ticker.C:
		case <-observe.Done():
			t.Fatal("original history backend did not reach its required lock/cleanup boundary")
		}
	}
}
