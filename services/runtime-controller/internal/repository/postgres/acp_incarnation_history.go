package postgres

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/acpincarnation"
)

func (r *Repository) ReadRegistrationHistory(ctx context.Context, scope, member string, cursor *acpincarnation.HistoryCursor) (acpincarnation.HistoryPage, error) {
	if cursor != nil {
		copy := *cursor
		cursor = &copy
	}
	input := acpincarnation.HistoryRequest{MemberID: member, Cursor: cursor}
	if scope == "" || len(scope) > 200 || strings.TrimSpace(scope) != scope || !acpincarnation.ValidHistoryRequest(input) {
		return acpincarnation.HistoryPage{}, acpincarnation.ErrHistoryCursor
	}
	return acpRegistryTransaction(ctx, r.database, func(tx *sql.Tx) (acpincarnation.HistoryPage, error) {
		if cursor == nil {
			if err := ensureAcpHistoryHead(ctx, tx, scope, member); err != nil {
				return acpincarnation.HistoryPage{}, err
			}
		}
		page := acpincarnation.HistoryPage{MemberID: member, AfterSequence: "0", Items: []acpincarnation.HistoryEntry{}}
		var head int64
		if err := tx.QueryRowContext(ctx, "SELECT history_id,revision FROM runtime_controller.acp_incarnation_histories WHERE controller_scope=$1 AND member_id=$2 FOR SHARE", scope, member).Scan(&page.HistoryID, &head); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return acpincarnation.HistoryPage{}, acpincarnation.ErrHistoryCursor
			}
			return acpincarnation.HistoryPage{}, err
		}
		revision, after := head, int64(0)
		if cursor != nil {
			revision, _ = acpincarnation.HistoryPosition(cursor.SnapshotRevision)
			after, _ = acpincarnation.HistoryPosition(cursor.AfterSequence)
			if cursor.HistoryID != page.HistoryID || revision > head {
				return acpincarnation.HistoryPage{}, acpincarnation.ErrHistoryCursor
			}
			page.AfterSequence = cursor.AfterSequence
		}
		page.SnapshotRevision = strconv.FormatInt(revision, 10)
		rows, err := tx.QueryContext(ctx, `SELECT history_sequence::text,registration_id,member_id,incarnation_id
FROM runtime_controller.acp_incarnation_registrations r
WHERE controller_scope=$1 AND member_id=$2 AND history_sequence>$3 AND history_sequence<=$4
ORDER BY r.history_sequence LIMIT 64`, scope, member, after, revision)
		if err != nil {
			return acpincarnation.HistoryPage{}, err
		}
		for rows.Next() {
			var entry acpincarnation.HistoryEntry
			if err = rows.Scan(&entry.Sequence, &entry.Registration.RegistrationID, &entry.Registration.MemberID, &entry.Registration.IncarnationID); err != nil {
				return acpincarnation.HistoryPage{}, errors.Join(err, rows.Close())
			}
			page.Items = append(page.Items, entry)
		}
		if err = errors.Join(rows.Err(), rows.Close(), ctx.Err()); err != nil {
			return acpincarnation.HistoryPage{}, err
		}
		last := after + int64(len(page.Items))
		if last < revision {
			page.NextCursor = &acpincarnation.HistoryCursor{HistoryID: page.HistoryID, SnapshotRevision: page.SnapshotRevision, AfterSequence: strconv.FormatInt(last, 10)}
		}
		if !acpincarnation.ValidHistoryPage(input, page) {
			return acpincarnation.HistoryPage{}, fmt.Errorf("stored ACP member history is incomplete")
		}
		return page, nil
	})
}

func ensureAcpHistoryHead(ctx context.Context, tx *sql.Tx, scope, member string) error {
	_, err := tx.ExecContext(ctx, `INSERT INTO runtime_controller.acp_incarnation_histories(controller_scope,member_id,history_id,revision)
VALUES($1,$2,gen_random_uuid()::text,0) ON CONFLICT(controller_scope,member_id) DO NOTHING`, scope, member)
	return err
}
