package repository

import (
	"encoding/hex"
	"testing"
	"time"
)

func TestCredentialAttemptKeysSeparateNamespacesScopesAndUTF8Parts(t *testing.T) {
	known, err := loginAttemptKeys("org/α", "old-slug", "alice@example.test")
	if err != nil {
		t.Fatal(err)
	}
	if got := hex.EncodeToString(known[1].digest[:]); got != "453096e74d14ce567ff2d519fb9caef9c963a50736ed2fcc92555352db58e984" {
		t.Fatalf("length-prefixed UTF-8 key changed: %s", got)
	}
	renamed, _ := loginAttemptKeys("org/α", "new-slug", "alice@example.test")
	if renamed != known {
		t.Fatal("a display rename changed stable Organization buckets")
	}
	unknown, _ := loginAttemptKeys("", "org/α", "alice@example.test")
	reused, _ := loginAttemptKeys("another-org", "old-slug", "alice@example.test")
	otherAccount, _ := loginAttemptKeys("org/α", "old-slug", "other@example.test")
	if unknown[0] == known[0] || unknown[1] == known[1] || reused[0] == known[0] || reused[1] == known[1] ||
		otherAccount[0] != known[0] || otherAccount[1] == known[1] || known[0].digest == known[1].digest {
		t.Fatal("attempt keys crossed a namespace, account or scope boundary")
	}
	change, _ := passwordChangeAttemptKeys("org/α", "user-1")
	changeElsewhere, _ := passwordChangeAttemptKeys("another-org", "user-1")
	if change[0] != known[0] || change[1] != changeElsewhere[1] || change[0] == changeElsewhere[0] {
		t.Fatal("password-change counters must share Organization and retain global User identity")
	}
	left, _ := newCredentialAttemptKey(loginAttemptScope, "org-id", "a|b", "c")
	right, _ := newCredentialAttemptKey(loginAttemptScope, "org-id", "a", "b|c")
	if left == right {
		t.Fatal("length-prefixed keys have a delimiter collision")
	}
	if _, err := loginAttemptKeys("", "", "alice@example.test"); err == nil {
		t.Fatal("empty Organization namespace was admitted")
	}
	if _, err := loginAttemptKeys("org", "", ""); err == nil {
		t.Fatal("empty account was admitted")
	}
	if _, err := passwordChangeAttemptKeys("org", ""); err == nil {
		t.Fatal("empty User was admitted")
	}
	if _, err := newCredentialAttemptKey("email", "raw-identity"); err == nil {
		t.Fatal("unknown scope was admitted")
	}
}

func TestCredentialAttemptBackoffThresholdsSaturationAndFirstFailureWindow(t *testing.T) {
	for _, scope := range []credentialAttemptScope{loginAttemptScope, changeAttemptScope, organizationAttemptScope} {
		t.Run(string(scope), func(t *testing.T) {
			threshold := 5
			if scope == organizationAttemptScope {
				threshold = 100
			}
			created := time.Date(2026, 10, 13, 0, 0, 0, 0, time.UTC)
			firstFailure := created.Add(time.Minute)
			state := credentialAttemptState{windowStart: created}
			for n := 1; n <= threshold+20; n++ {
				// Policy arithmetic is checked without sleeping through real backoff.
				// Admission separately prevents invoking a failed outcome while locked.
				state = state.withFailure(scope, firstFailure)
				wantFailures := min(n, threshold+10)
				if state.failures != wantFailures || !state.windowStart.Equal(firstFailure) {
					t.Fatalf("counter saturation/window: n=%d state=%+v", n, state)
				}
				if n < threshold {
					if state.lockedUntil != nil {
						t.Fatal("backoff started before the threshold")
					}
					continue
				}
				wantDelay := min(time.Second<<min(n-threshold, 10), 15*time.Minute)
				if state.lockedUntil == nil || !state.lockedUntil.Equal(firstFailure.Add(wantDelay)) {
					t.Fatalf("backoff n=%d: want %s", n, wantDelay)
				}
			}
		})
	}
}

func TestCredentialAttemptExpiryRequiresBothWindowAndLockToEnd(t *testing.T) {
	now := time.Date(2026, 10, 13, 0, 30, 0, 0, time.UTC)
	past, future := now.Add(-time.Microsecond), now.Add(time.Microsecond)
	for _, row := range []struct {
		name   string
		state  credentialAttemptState
		expire bool
	}{
		{"window still open", credentialAttemptState{now.Add(-15*time.Minute + time.Microsecond), 5, &past}, false},
		{"lock still active", credentialAttemptState{now.Add(-16 * time.Minute), 5, &future}, false},
		{"exact window", credentialAttemptState{now.Add(-15 * time.Minute), 5, &past}, true},
		{"exact lock", credentialAttemptState{now.Add(-16 * time.Minute), 5, &now}, true},
		{"no lock", credentialAttemptState{now.Add(-16 * time.Minute), 4, nil}, true},
	} {
		t.Run(row.name, func(t *testing.T) {
			got := row.state.forAdmission(now)
			if row.expire {
				if got.failures != 0 || got.lockedUntil != nil {
					t.Fatal("expired state survived admission")
				}
				failed := got.withFailure(loginAttemptScope, now)
				if failed.failures != 1 || failed.lockedUntil != nil || !failed.windowStart.Equal(now) {
					t.Fatal("expired first failure did not start a fresh window")
				}
			} else if got != row.state {
				t.Fatal("active attempt state was reset")
			}
		})
	}
}
