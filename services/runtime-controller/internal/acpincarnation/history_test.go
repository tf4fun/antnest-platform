package acpincarnation

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"testing"
	"testing/synctest"
	"time"
)

func (s *incarnationServiceStore) ReadRegistrationHistory(context.Context, string, string, *HistoryCursor) (HistoryPage, error) {
	s.calls.add("unexpected-history")
	return HistoryPage{}, errors.New("unexpected registration history read")
}

type incarnationHistoryStore struct {
	*incarnationServiceStore
	read func(context.Context, string, string, *HistoryCursor) (HistoryPage, error)
}

func (s *incarnationHistoryStore) ReadRegistrationHistory(ctx context.Context, scope, member string, cursor *HistoryCursor) (HistoryPage, error) {
	s.calls.add("history")
	return s.read(ctx, scope, member, cursor)
}

func newIncarnationHistoryFixture(t *testing.T) (*incarnationServiceFixture, *incarnationHistoryStore, *Service) {
	t.Helper()
	f := newIncarnationServiceFixture(t)
	store := &incarnationHistoryStore{
		incarnationServiceStore: f.store,
		read: func(context.Context, string, string, *HistoryCursor) (HistoryPage, error) {
			return HistoryPage{}, errors.New("history callback was not configured")
		},
	}
	service, err := New(f.scope, f.members, store, f.platform, f.prober)
	if err != nil {
		t.Fatal("valid history service fixture was rejected")
	}
	return f, store, service
}

func incarnationHistoryPage(member string, snapshot, after, count int) HistoryPage {
	page := HistoryPage{
		MemberID: member, HistoryID: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
		SnapshotRevision: strconv.Itoa(snapshot), AfterSequence: strconv.Itoa(after),
		Items: make([]HistoryEntry, 0, count),
	}
	for sequence := after + 1; sequence <= after+count; sequence++ {
		page.Items = append(page.Items, HistoryEntry{
			Sequence: strconv.Itoa(sequence),
			Registration: Registration{
				RegistrationID: fmt.Sprintf("00000000-0000-4000-8000-%012x", sequence),
				MemberID:       member, IncarnationID: fmt.Sprintf("00000000-0000-4000-8001-%012x", sequence),
			},
		})
	}
	if after+count < snapshot {
		page.NextCursor = &HistoryCursor{HistoryID: page.HistoryID, SnapshotRevision: page.SnapshotRevision, AfterSequence: strconv.Itoa(after + count)}
	}
	return page
}

func cloneIncarnationHistoryPage(page HistoryPage) HistoryPage {
	page.Items = append([]HistoryEntry{}, page.Items...)
	if page.NextCursor != nil {
		cursor := *page.NextCursor
		page.NextCursor = &cursor
	}
	return page
}

func TestHistoryReadsConfiguredMemberSnapshotInOrder(t *testing.T) {
	f, store, service := newIncarnationHistoryFixture(t)
	first := incarnationHistoryPage(f.member.ID, 65, 0, 64)
	last := incarnationHistoryPage(f.member.ID, 65, 64, 1)
	next := *first.NextCursor
	reads := 0
	store.read = func(_ context.Context, scope, member string, cursor *HistoryCursor) (HistoryPage, error) {
		requireIncarnationServiceEqual(t, scope, f.scope, "history read escaped the configured controller scope")
		requireIncarnationServiceEqual(t, member, f.member.ID, "history read used a different member")
		reads++
		if reads == 1 {
			if cursor != nil {
				t.Error("first history read supplied a continuation cursor")
			}
			return cloneIncarnationHistoryPage(first), nil
		}
		requireIncarnationServiceEqual(t, cursor, &next, "history continuation cursor was changed")
		return cloneIncarnationHistoryPage(last), nil
	}
	page, err := service.History(t.Context(), HistoryRequest{MemberID: f.member.ID})
	if err != nil {
		t.Fatal(err)
	}
	requireIncarnationServiceEqual(t, page, first, "first page changed original registration tuples, order, or snapshot")
	page, err = service.History(t.Context(), HistoryRequest{MemberID: f.member.ID, Cursor: &next})
	if err != nil {
		t.Fatal(err)
	}
	requireIncarnationServiceEqual(t, page, last, "continuation changed original registration tuples, order, or snapshot")
	requireIncarnationServiceEqual(t, next, *first.NextCursor, "history mutated the caller's cursor")
	requireIncarnationServiceEqual(t, f.calls.snapshot(), []string{"history", "history"}, "history performed platform, probe, stop, or other registry operations")
}

func TestHistoryEmptyRevisionZero(t *testing.T) {
	f, store, service := newIncarnationHistoryFixture(t)
	want := incarnationHistoryPage(f.member.ID, 0, 0, 0)
	store.read = func(_ context.Context, scope, member string, cursor *HistoryCursor) (HistoryPage, error) {
		requireIncarnationServiceEqual(t, scope, f.scope, "empty history used an unconfigured scope")
		requireIncarnationServiceEqual(t, member, f.member.ID, "empty history used a different member")
		if cursor != nil {
			t.Error("empty first history read supplied a cursor")
		}
		return cloneIncarnationHistoryPage(want), nil
	}
	page, err := service.History(t.Context(), HistoryRequest{MemberID: f.member.ID})
	if err != nil {
		t.Fatal(err)
	}
	requireIncarnationServiceEqual(t, page, want, "empty history invented a registration or cursor")
	requireIncarnationServiceEqual(t, f.calls.snapshot(), []string{"history"}, "empty history performed additional work")
}

func TestHistoryRejectsInvalidRequestBeforeStore(t *testing.T) {
	valid := HistoryCursor{HistoryID: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", SnapshotRevision: "65", AfterSequence: "64"}
	cases := []struct {
		name   string
		member string
		change func(*HistoryCursor)
	}{
		{name: "empty member", member: ""},
		{name: "uppercase member", member: "ACP-A"},
		{name: "member too long", member: strings.Repeat("a", 65)},
		{name: "noncanonical history id", member: "acp-a", change: func(c *HistoryCursor) { c.HistoryID = strings.ToUpper(c.HistoryID) }},
		{name: "invalid history id", member: "acp-a", change: func(c *HistoryCursor) { c.HistoryID = "not-a-history-id" }},
		{name: "noncanonical snapshot", member: "acp-a", change: func(c *HistoryCursor) { c.SnapshotRevision = "065" }},
		{name: "snapshot overflow", member: "acp-a", change: func(c *HistoryCursor) { c.SnapshotRevision = "9223372036854775808" }},
		{name: "negative sequence", member: "acp-a", change: func(c *HistoryCursor) { c.AfterSequence = "-1" }},
		{name: "noncanonical sequence", member: "acp-a", change: func(c *HistoryCursor) { c.AfterSequence = "064" }},
		{name: "sequence overflow", member: "acp-a", change: func(c *HistoryCursor) { c.AfterSequence = "9223372036854775808" }},
		{name: "sequence beyond snapshot", member: "acp-a", change: func(c *HistoryCursor) { c.AfterSequence = "66" }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f, _, service := newIncarnationHistoryFixture(t)
			request := HistoryRequest{MemberID: tc.member}
			if tc.change != nil {
				cursor := valid
				tc.change(&cursor)
				request.Cursor = &cursor
			}
			page, err := service.History(t.Context(), request)
			requireIncarnationServiceFailure(t, err, "invalid_request")
			requireIncarnationServiceEqual(t, page, HistoryPage{}, "invalid history input returned a usable page")
			requireIncarnationServiceEqual(t, f.calls.snapshot(), []string(nil), "invalid history input reached a dependency")
		})
	}
}

func TestHistoryRejectsUnconfiguredMemberBeforeStore(t *testing.T) {
	f, _, service := newIncarnationHistoryFixture(t)
	cursor := &HistoryCursor{HistoryID: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", SnapshotRevision: "65", AfterSequence: "64"}
	page, err := service.History(t.Context(), HistoryRequest{MemberID: "acp-foreign", Cursor: cursor})
	requireIncarnationServiceFailure(t, err, "acp_member_not_allowed")
	requireIncarnationServiceEqual(t, page, HistoryPage{}, "unconfigured member returned another member's history")
	requireIncarnationServiceEqual(t, f.calls.snapshot(), []string(nil), "unconfigured member reached a dependency")
}

func TestHistoryPreservesStorageAndDeadlineFailures(t *testing.T) {
	t.Run("storage failure", func(t *testing.T) {
		f, store, service := newIncarnationHistoryFixture(t)
		sentinel := errors.New("history storage failed")
		store.read = func(context.Context, string, string, *HistoryCursor) (HistoryPage, error) {
			return incarnationHistoryPage(f.member.ID, 1, 0, 1), sentinel
		}
		page, err := service.History(t.Context(), HistoryRequest{MemberID: f.member.ID})
		requireIncarnationServiceFailure(t, err, "acp_registry_unavailable")
		if !errors.Is(err, sentinel) {
			t.Error("history discarded the original storage failure")
		}
		requireIncarnationServiceEqual(t, page, HistoryPage{}, "storage failure returned a usable page")
		requireIncarnationServiceEqual(t, f.calls.snapshot(), []string{"history"}, "storage failure triggered other work")
	})
	t.Run("expired deadline", func(t *testing.T) {
		f, _, service := newIncarnationHistoryFixture(t)
		ctx, cancel := context.WithDeadline(t.Context(), time.Now().Add(-time.Second))
		defer cancel()
		page, err := service.History(ctx, HistoryRequest{MemberID: f.member.ID})
		requireIncarnationServiceFailure(t, err, "deadline_exceeded")
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Error("history discarded the original deadline failure")
		}
		requireIncarnationServiceEqual(t, page, HistoryPage{}, "expired history request returned a usable page")
		requireIncarnationServiceEqual(t, f.calls.snapshot(), []string(nil), "expired history request started new dependency work")
	})
}

func TestHistoryRejectsInvalidStorePage(t *testing.T) {
	cases := []struct {
		name         string
		continuation bool
		change       func(*HistoryPage)
	}{
		{name: "foreign member", change: func(p *HistoryPage) { p.MemberID = "acp-foreign" }},
		{name: "foreign registration member", change: func(p *HistoryPage) { p.Items[0].Registration.MemberID = "acp-foreign" }},
		{name: "invalid history id", change: func(p *HistoryPage) { p.HistoryID = "not-a-history-id" }},
		{name: "invalid registration tuple", change: func(p *HistoryPage) { p.Items[0].Registration.IncarnationID = "not-an-incarnation" }},
		{name: "sequence gap", change: func(p *HistoryPage) { p.Items[1].Sequence = "3" }},
		{name: "duplicate sequence", change: func(p *HistoryPage) { p.Items[1].Sequence = p.Items[0].Sequence }},
		{name: "duplicate registration", change: func(p *HistoryPage) { p.Items[1].Registration = p.Items[0].Registration }},
		{name: "changed snapshot", continuation: true, change: func(p *HistoryPage) { p.SnapshotRevision = "66" }},
		{name: "changed history id", continuation: true, change: func(p *HistoryPage) { p.HistoryID = "ffffffff-ffff-4fff-8fff-ffffffffffff" }},
		{name: "changed after sequence", continuation: true, change: func(p *HistoryPage) { p.AfterSequence = "63" }},
		{name: "wrong next cursor", change: func(p *HistoryPage) {
			*p = incarnationHistoryPage(p.MemberID, 65, 0, 64)
			p.NextCursor.AfterSequence = "63"
		}},
		{name: "foreign next cursor", change: func(p *HistoryPage) {
			*p = incarnationHistoryPage(p.MemberID, 65, 0, 64)
			p.NextCursor.HistoryID = "ffffffff-ffff-4fff-8fff-ffffffffffff"
		}},
		{name: "missing next cursor", change: func(p *HistoryPage) {
			*p = incarnationHistoryPage(p.MemberID, 65, 0, 64)
			p.NextCursor = nil
		}},
		{name: "terminal next cursor", change: func(p *HistoryPage) {
			p.NextCursor = &HistoryCursor{HistoryID: p.HistoryID, SnapshotRevision: p.SnapshotRevision, AfterSequence: "2"}
		}},
		{name: "more than 64 items", change: func(p *HistoryPage) { *p = incarnationHistoryPage(p.MemberID, 65, 0, 65) }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f, store, service := newIncarnationHistoryFixture(t)
			request := HistoryRequest{MemberID: f.member.ID}
			page := incarnationHistoryPage(f.member.ID, 2, 0, 2)
			if tc.continuation {
				page = incarnationHistoryPage(f.member.ID, 65, 64, 1)
				request.Cursor = &HistoryCursor{HistoryID: page.HistoryID, SnapshotRevision: "65", AfterSequence: "64"}
			}
			tc.change(&page)
			store.read = func(_ context.Context, scope, member string, cursor *HistoryCursor) (HistoryPage, error) {
				requireIncarnationServiceEqual(t, scope, f.scope, "invalid page read used an unconfigured scope")
				requireIncarnationServiceEqual(t, member, f.member.ID, "invalid page read used a different member")
				requireIncarnationServiceEqual(t, cursor, request.Cursor, "invalid page read changed the original cursor")
				return page, nil
			}
			got, err := service.History(t.Context(), request)
			requireIncarnationServiceFailure(t, err, "acp_registry_unavailable")
			requireIncarnationServiceEqual(t, got, HistoryPage{}, "invalid stored page became a successful history result")
			requireIncarnationServiceEqual(t, f.calls.snapshot(), []string{"history"}, "invalid stored page triggered other work")
		})
	}
}

func TestHistoryDoesNotReturnSuccessAfterStoreCancelsContext(t *testing.T) {
	f, store, service := newIncarnationHistoryFixture(t)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	store.read = func(context.Context, string, string, *HistoryCursor) (HistoryPage, error) {
		cancel()
		return incarnationHistoryPage(f.member.ID, 1, 0, 1), nil
	}
	page, err := service.History(ctx, HistoryRequest{MemberID: f.member.ID})
	requireIncarnationServiceFailure(t, err, "deadline_exceeded")
	if !errors.Is(err, context.Canceled) {
		t.Error("history discarded cancellation after the original read completed")
	}
	requireIncarnationServiceEqual(t, page, HistoryPage{}, "cancelled history request returned a usable page")
	requireIncarnationServiceEqual(t, f.calls.snapshot(), []string{"history"}, "cancelled history request triggered other work")
}

func TestHistoryCancellationJoinsHeldOriginalStoreAndRetainsLateFailure(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f, store, service := newIncarnationHistoryFixture(t)
		ctx, cancel := context.WithCancel(t.Context())
		entered, aborted, release := make(chan struct{}), make(chan struct{}), make(chan struct{})
		exited, returned := make(chan struct{}), make(chan struct{})
		var releaseOnce sync.Once
		sentinel := errors.New("original history read cleanup failed after cancellation")
		store.read = func(ctx context.Context, scope, member string, cursor *HistoryCursor) (HistoryPage, error) {
			defer close(exited)
			requireIncarnationServiceEqual(t, scope, f.scope, "held history read escaped its configured scope")
			requireIncarnationServiceEqual(t, member, f.member.ID, "held history read used a different member")
			close(entered)
			select {
			case <-ctx.Done():
				close(aborted)
			case <-release:
				return HistoryPage{}, errors.New("held history read was released before cancellation")
			}
			<-release
			return HistoryPage{}, sentinel
		}
		var page HistoryPage
		var err error
		go func() {
			defer close(returned)
			page, err = service.History(ctx, HistoryRequest{MemberID: f.member.ID})
		}()
		defer func() {
			cancel()
			releaseOnce.Do(func() { close(release) })
			<-returned
			select {
			case <-entered:
				<-exited
			default:
			}
		}()
		synctest.Wait()
		select {
		case <-entered:
		default:
			t.Fatal("history did not enter the original store call")
		}
		cancel()
		synctest.Wait()
		select {
		case <-aborted:
		default:
			t.Error("history did not cancel the original store context")
		}
		select {
		case <-returned:
			t.Error("history returned before the original store call joined")
		default:
		}
		select {
		case <-exited:
			t.Error("held original store call unexpectedly finished")
		default:
		}
		releaseOnce.Do(func() { close(release) })
		<-returned
		<-exited
		requireIncarnationServiceFailure(t, err, "deadline_exceeded")
		if !errors.Is(err, sentinel) || !errors.Is(err, context.Canceled) {
			t.Error("history lost the independent late failure or original cancellation")
		}
		requireIncarnationServiceEqual(t, page, HistoryPage{}, "cancelled held history read returned a usable page")
		requireIncarnationServiceEqual(t, f.calls.snapshot(), []string{"history"}, "held history read triggered platform, probe, stop, or other registry operations")
	})
}
