package server

import (
	"fmt"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestLoginAdmissionBoundsSourceAndNormalizedAccount(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	admission := newLoginAdmission(loginAdmissionConfig{
		Window: 5 * time.Minute, SourceLimit: 3, AccountLimit: 2,
		MaxKeys: 16, Now: func() time.Time { return now },
	})

	if !admission.AllowPassword("192.0.2.1", "engineering", "Alice@Example.COM") ||
		!admission.AllowPassword("192.0.2.1", "ENGINEERING", "alice@example.com") {
		t.Fatal("valid attempts were rejected before the account limit")
	}
	if admission.AllowPassword("192.0.2.2", "engineering", "alice@example.com") {
		t.Fatal("normalized account limit was bypassed from another source")
	}
	if !admission.AllowPassword("192.0.2.1", "engineering", "bob@example.com") {
		t.Fatal("source limit was reached too early")
	}
	if admission.AllowPassword("192.0.2.1", "engineering", "carol@example.com") {
		t.Fatal("source limit was bypassed with another account")
	}

	now = now.Add(5 * time.Minute)
	if !admission.AllowPassword("192.0.2.1", "engineering", "alice@example.com") {
		t.Fatal("expired admission window did not reopen")
	}
}

func TestLoginAdmissionEvictsOldestWindowAtBoundedCapacity(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 10, 13, 9, 0, 0, 0, time.UTC)
	admission := newLoginAdmission(loginAdmissionConfig{
		Window: time.Minute, SourceLimit: 1, AccountLimit: 1,
		MaxKeys: 4, Now: func() time.Time { return now },
	})
	for index := 1; index <= 5; index++ {
		if !admission.AllowPassword(fmt.Sprintf("192.0.2.%d", index), "engineering", fmt.Sprintf("user%d@example.com", index)) {
			t.Fatalf("new key %d was refused at bounded capacity", index)
		}
		now = now.Add(time.Second)
	}
	if admission.AllowPassword("192.0.2.2", "engineering", "new@example.com") {
		t.Fatal("retained source limit was bypassed")
	}
	if admission.AllowPassword("192.0.2.6", "engineering", "user2@example.com") {
		t.Fatal("retained account limit was bypassed")
	}
	if admission.AllowPassword("192.0.2.2", "engineering", "new@example.com") {
		t.Fatal("account refusal evicted an unrelated retained source")
	}
	if !admission.AllowPassword("192.0.2.1", "engineering", "user1@example.com") {
		t.Fatal("oldest source/account windows were not evicted")
	}
}

func TestLoginAdmissionRefusalDoesNotRemoveExpiredState(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 10, 13, 9, 0, 0, 0, time.UTC)
	admission := newLoginAdmission(loginAdmissionConfig{
		Window: time.Minute, SourceLimit: 3, AccountLimit: 1,
		MaxKeys: 4, Now: func() time.Time { return now },
	})
	if !admission.AllowPassword("192.0.2.1", "engineering", "older@example.com") {
		t.Fatal("initial older window refused")
	}
	now = now.Add(10 * time.Second)
	if !admission.AllowPassword("192.0.2.2", "engineering", "limited@example.com") {
		t.Fatal("initial later window refused")
	}
	now = now.Add(50 * time.Second)
	before := snapshotLoginAdmission(t, admission)
	if admission.AllowPassword("192.0.2.1", "engineering", "limited@example.com") {
		t.Fatal("live account limit was bypassed")
	}
	if !reflect.DeepEqual(snapshotLoginAdmission(t, admission), before) {
		t.Fatal("refusal mutated admission tables, including expired state")
	}
}

func TestLoginAdmissionAccountPartsCannotAliasAcrossEmbeddedNUL(t *testing.T) {
	t.Parallel()
	admission := newLoginAdmission(loginAdmissionConfig{
		Window: time.Minute, SourceLimit: 10, AccountLimit: 1, MaxKeys: 8, Now: time.Now,
	})
	if !admission.AllowPassword("192.0.2.1", " A\x00B ", " C ") ||
		!admission.AllowPassword("192.0.2.2", "a", "b\x00c") {
		t.Fatal("different component boundaries shared a password account window")
	}
	if admission.AllowPassword("192.0.2.3", "a\x00b", "c") {
		t.Fatal("normalized aliases bypassed the account limit")
	}
}

func TestLoginAdmissionRetainsBoundedAccountKeys(t *testing.T) {
	t.Parallel()
	admission := newLoginAdmission(loginAdmissionConfig{
		Window: time.Minute, SourceLimit: 10, AccountLimit: 1, MaxKeys: 8, Now: time.Now,
	})
	if !admission.AllowPassword("192.0.2.1", strings.Repeat("o", 16000), strings.Repeat("e", 16000)) {
		t.Fatal("long but bounded login input was refused")
	}
	for key := range admission.accounts.entries {
		if len(key) != 32 {
			t.Fatalf("retained account key length=%d want=32", len(key))
		}
	}
}

type loginAdmissionTableSnapshot struct {
	entries map[[32]byte]loginAdmissionWindowSnapshot
	order   [][32]byte
}

type loginAdmissionWindowSnapshot struct {
	expiresAt time.Time
	count     int
}

func snapshotLoginAdmission(t *testing.T, admission *loginAdmission) map[string]loginAdmissionTableSnapshot {
	t.Helper()
	admission.mu.Lock()
	defer admission.mu.Unlock()
	result := make(map[string]loginAdmissionTableSnapshot)
	for _, item := range []struct {
		name  string
		table *loginAdmissionTable
		limit int
	}{
		{"password sources", &admission.sources, admission.sourceLimit},
		{"password accounts", &admission.accounts, admission.accountLimit},
		{"OIDC sources", &admission.oidcSources, admission.oidcSourceLimit},
	} {
		table := item.table
		if len(table.entries) > admission.maxKeys || len(table.entries) != table.order.Len() {
			t.Fatalf("%s map/list sizes=%d/%d capacity=%d", item.name, len(table.entries), table.order.Len(), admission.maxKeys)
		}
		state := loginAdmissionTableSnapshot{entries: make(map[[32]byte]loginAdmissionWindowSnapshot)}
		var previous time.Time
		for node := table.order.Front(); node != nil; node = node.Next() {
			window := node.Value.(*loginWindow)
			key := [32]byte(window.key)
			if table.entries[window.key] != node || window.count <= 0 || window.count > item.limit ||
				(!previous.IsZero() && window.expiresAt.Before(previous)) {
				t.Fatalf("%s has a stale FIFO node, invalid count or expiry inversion", item.name)
			}
			if _, exists := state.entries[key]; exists {
				t.Fatalf("%s has duplicate FIFO keys", item.name)
			}
			state.entries[key] = loginAdmissionWindowSnapshot{window.expiresAt, window.count}
			state.order = append(state.order, key)
			previous = window.expiresAt
		}
		result[item.name] = state
	}
	return result
}

func TestLoginAdmissionReadsOneClockValueUnderItsMutex(t *testing.T) {
	t.Parallel()
	var admission *loginAdmission
	samples, outsideLock := 0, false
	admission = newLoginAdmission(loginAdmissionConfig{
		Window: time.Minute, SourceLimit: 10, AccountLimit: 10, MaxKeys: 8,
		Now: func() time.Time {
			samples++
			if admission.mu.TryLock() {
				outsideLock = true
				admission.mu.Unlock()
			}
			return time.Date(2026, 10, 13, 9, 0, 0, 0, time.UTC)
		},
	})
	if !admission.AllowPassword("192.0.2.1", "engineering", "alice@example.com") || outsideLock || samples != 1 {
		t.Fatalf("admission clock samples=%d outside mutex=%v", samples, outsideLock)
	}
}

func TestLoginAdmissionFixedExpiryAndRecreationKeepOneNodePerKey(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 10, 13, 9, 0, 0, 0, time.UTC)
	admission := newLoginAdmission(loginAdmissionConfig{
		Window: time.Minute, SourceLimit: 2, AccountLimit: 2, MaxKeys: 2,
		Now: func() time.Time { return now },
	})
	for index := range 3 {
		if !admission.AllowPassword("192.0.2.1", "engineering", "alice@example.com") {
			t.Fatalf("request %d was refused; a hit may have extended expiry", index)
		}
		now = now.Add(30 * time.Second)
	}
	for index := range 20 {
		now = now.Add(30 * time.Second)
		if !admission.AllowPassword(fmt.Sprintf("192.0.2.%d", index%2+1), "engineering", fmt.Sprintf("user%d@example.com", index%2)) {
			t.Fatalf("recreated window %d was refused", index)
		}
		snapshotLoginAdmission(t, admission)
	}
}

func TestLoginAdmissionConcurrentFinalAllowanceIsAtomic(t *testing.T) {
	t.Parallel()
	for _, fixture := range []struct {
		name                            string
		distinctSources, distinctEmails bool
	}{
		{"same source and account", false, false},
		{"distinct sources compete for account", true, false},
		{"distinct accounts compete for source", false, true},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			admission := newLoginAdmission(loginAdmissionConfig{
				Window: time.Minute, SourceLimit: 2, AccountLimit: 2, MaxKeys: 64, Now: time.Now,
			})
			if !admission.AllowPassword("192.0.2.1", "engineering", "alice@example.com") {
				t.Fatal("first allowance was refused")
			}
			start := make(chan struct{})
			results := make(chan bool, 32)
			var workers sync.WaitGroup
			for index := range 32 {
				source, email := "192.0.2.1", "alice@example.com"
				if fixture.distinctSources {
					source = fmt.Sprintf("192.0.2.%d", index+2)
				}
				if fixture.distinctEmails {
					email = fmt.Sprintf("user%d@example.com", index)
				}
				workers.Go(func() {
					<-start
					results <- admission.AllowPassword(source, "engineering", email)
				})
			}
			close(start)
			workers.Wait()
			close(results)
			allowed := 0
			for result := range results {
				if result {
					allowed++
				}
			}
			if allowed != 1 {
				t.Fatalf("concurrent final allowances=%d want=1", allowed)
			}
			snapshotLoginAdmission(t, admission)
		})
	}
}

func TestLoginAdmissionOIDCCapacityAndExpiryStayIsolated(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 10, 13, 9, 0, 0, 0, time.UTC)
	admission := newLoginAdmission(loginAdmissionConfig{
		Window: time.Minute, SourceLimit: 1, AccountLimit: 1, OIDCSourceLimit: 1,
		MaxKeys: 2, Now: func() time.Time { return now },
	})
	if !admission.AllowPassword("192.0.2.1", "engineering", "oidc:workforce") {
		t.Fatal("password request refused")
	}
	before := snapshotLoginAdmission(t, admission)
	for index := 1; index <= 3; index++ {
		if !admission.AllowOIDCStart(fmt.Sprintf("192.0.2.%d", index)) {
			t.Fatalf("new OIDC source %d was refused", index)
		}
		now = now.Add(time.Second)
	}
	if admission.AllowOIDCStart("192.0.2.2") {
		t.Fatal("retained OIDC source bypassed its limit")
	}
	if !admission.AllowOIDCStart("192.0.2.1") {
		t.Fatal("oldest OIDC source was not evicted")
	}
	after := snapshotLoginAdmission(t, admission)
	for _, name := range []string{"password sources", "password accounts"} {
		if !reflect.DeepEqual(before[name], after[name]) {
			t.Fatalf("OIDC admission changed %s", name)
		}
	}
	now = now.Add(time.Minute)
	if !admission.AllowOIDCStart("192.0.2.1") {
		t.Fatal("expired OIDC source did not reopen")
	}
	snapshotLoginAdmission(t, admission)
}

func TestLoginAdmissionNormalizesSourceKeys(t *testing.T) {
	t.Parallel()
	for _, fixture := range []struct {
		name, first, second string
		distinct            bool
	}{
		{"IPv4 mapped", "::ffff:192.0.2.7", "192.0.2.7", false},
		{"same IPv6 prefix", "2001:db8:1:2::1", "2001:db8:1:2::ffff", false},
		{"different IPv6 prefix", "2001:db8:1:2::1", "2001:db8:1:3::1", true},
		{"invalid addresses share one key", "invalid-a", "invalid-b", false},
		{"zone is unknown", "fe80::1%eth0", "unknown", false},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			admission := newLoginAdmission(loginAdmissionConfig{
				Window: time.Minute, SourceLimit: 1, AccountLimit: 10, MaxKeys: 8, Now: time.Now,
			})
			if !admission.AllowPassword(fixture.first, "engineering", "first@example.com") {
				t.Fatal("first request was refused")
			}
			if got := admission.AllowPassword(fixture.second, "engineering", "second@example.com"); got != fixture.distinct {
				t.Fatalf("second source admitted=%v want=%v", got, fixture.distinct)
			}
		})
	}
}
