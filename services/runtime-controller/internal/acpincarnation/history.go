package acpincarnation

import (
	"context"
	"errors"
	"strconv"
)

const HistoryPageSize = 64

var ErrHistoryCursor = errors.New("invalid ACP registration history cursor")

type HistoryCursor struct {
	HistoryID        string `json:"history_id"`
	SnapshotRevision string `json:"snapshot_revision"`
	AfterSequence    string `json:"after_sequence"`
}

type HistoryRequest struct {
	MemberID string         `json:"member_id"`
	Cursor   *HistoryCursor `json:"cursor"`
}

type HistoryEntry struct {
	Sequence     string       `json:"sequence"`
	Registration Registration `json:"registration"`
}

// HistoryPage discovers original identities. It is not a stop receipt or an
// admission barrier against future process registrations.
type HistoryPage struct {
	MemberID         string         `json:"member_id"`
	HistoryID        string         `json:"history_id"`
	SnapshotRevision string         `json:"snapshot_revision"`
	AfterSequence    string         `json:"after_sequence"`
	Items            []HistoryEntry `json:"items"`
	NextCursor       *HistoryCursor `json:"next_cursor"`
}

func (s *Service) History(parent context.Context, input HistoryRequest) (HistoryPage, error) {
	ctx, cancel := context.WithTimeout(parent, operationTimeout)
	defer cancel()
	if input.Cursor != nil {
		cursor := *input.Cursor
		input.Cursor = &cursor
	}
	if !ValidHistoryRequest(input) {
		return HistoryPage{}, failure(ctx, "invalid_request", nil)
	}
	if _, exists := s.members[input.MemberID]; !exists {
		return HistoryPage{}, failure(ctx, "acp_member_not_allowed", nil)
	}
	if ctx.Err() != nil {
		return HistoryPage{}, failure(ctx, "deadline_exceeded", ctx.Err())
	}
	var cursor *HistoryCursor
	if input.Cursor != nil {
		copy := *input.Cursor
		cursor = &copy
	}
	page, err := s.store.ReadRegistrationHistory(ctx, s.scope, input.MemberID, cursor)
	if errors.Is(err, ErrHistoryCursor) {
		return HistoryPage{}, failure(ctx, "invalid_request", err)
	}
	if err != nil || ctx.Err() != nil || !ValidHistoryPage(input, page) {
		return HistoryPage{}, failure(ctx, "acp_registry_unavailable", err)
	}
	return page, nil
}

func HistoryPosition(value string) (int64, bool) {
	position, err := strconv.ParseInt(value, 10, 64)
	return position, err == nil && position >= 0 && strconv.FormatInt(position, 10) == value
}

func ValidHistoryRequest(input HistoryRequest) bool {
	if !ValidMemberID(input.MemberID) {
		return false
	}
	if input.Cursor == nil {
		return true
	}
	cursor := input.Cursor
	revision, validRevision := HistoryPosition(cursor.SnapshotRevision)
	after, validAfter := HistoryPosition(cursor.AfterSequence)
	return ValidUUID(cursor.HistoryID) && validRevision && validAfter && revision > 0 && after < revision
}

func ValidHistoryPage(input HistoryRequest, page HistoryPage) bool {
	if !ValidHistoryRequest(input) || page.MemberID != input.MemberID || !ValidUUID(page.HistoryID) || page.Items == nil {
		return false
	}
	revision, validRevision := HistoryPosition(page.SnapshotRevision)
	after, validAfter := HistoryPosition(page.AfterSequence)
	if !validRevision || !validAfter || after > revision {
		return false
	}
	if input.Cursor == nil {
		if after != 0 {
			return false
		}
	} else if page.HistoryID != input.Cursor.HistoryID || page.SnapshotRevision != input.Cursor.SnapshotRevision || page.AfterSequence != input.Cursor.AfterSequence {
		return false
	}
	if int64(len(page.Items)) != min(int64(HistoryPageSize), revision-after) {
		return false
	}
	registrations, incarnations := map[string]bool{}, map[string]bool{}
	for index, item := range page.Items {
		sequence, valid := HistoryPosition(item.Sequence)
		registration := item.Registration
		if !valid || sequence != after+int64(index)+1 || registration.MemberID != page.MemberID || !ValidUUID(registration.RegistrationID) || !ValidUUID(registration.IncarnationID) || registrations[registration.RegistrationID] || incarnations[registration.IncarnationID] {
			return false
		}
		registrations[registration.RegistrationID] = true
		incarnations[registration.IncarnationID] = true
	}
	last := after + int64(len(page.Items))
	if last == revision {
		return page.NextCursor == nil
	}
	return page.NextCursor != nil && *page.NextCursor == (HistoryCursor{HistoryID: page.HistoryID, SnapshotRevision: page.SnapshotRevision, AfterSequence: strconv.FormatInt(last, 10)})
}
