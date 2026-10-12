package repository

import (
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"math"
	"time"
)

type credentialAttemptScope string

const (
	organizationAttemptScope   credentialAttemptScope = "organization"
	loginAttemptScope          credentialAttemptScope = "login_account"
	passwordChangeAttemptScope credentialAttemptScope = "password_change_user"
	credentialAttemptWindow                           = 15 * time.Minute
)

func (scope credentialAttemptScope) threshold() int {
	switch scope {
	case organizationAttemptScope:
		return 100
	case loginAttemptScope, passwordChangeAttemptScope:
		return 5
	default:
		return 0
	}
}

type credentialAttemptKey struct {
	scope  credentialAttemptScope
	digest [sha256.Size]byte
}

// Keys take already-normalized identities. Namespace tags and byte lengths
// prevent cross-scope, unknown-slug and delimiter collisions without persisting
// the underlying email, slug or User ID in attempt state or error messages.
func newCredentialAttemptKey(scope credentialAttemptScope, parts ...string) (credentialAttemptKey, error) {
	if scope.threshold() == 0 {
		return credentialAttemptKey{}, fmt.Errorf("invalid credential attempt scope")
	}
	hash := sha256.New()
	for _, part := range append([]string{"antnest.credentials.v1", string(scope)}, parts...) {
		if uint64(len(part)) > math.MaxUint32 {
			return credentialAttemptKey{}, fmt.Errorf("credential attempt key part exceeds its encoding limit")
		}
		var length [4]byte
		binary.BigEndian.PutUint32(length[:], uint32(len(part)))
		_, _ = hash.Write(length[:])
		_, _ = hash.Write([]byte(part))
	}
	key := credentialAttemptKey{scope: scope}
	copy(key.digest[:], hash.Sum(nil))
	return key, nil
}

func loginAttemptKeys(organizationID, normalizedSlug, normalizedEmail string) ([2]credentialAttemptKey, error) {
	if normalizedEmail == "" || (organizationID == "" && normalizedSlug == "") {
		return [2]credentialAttemptKey{}, fmt.Errorf("credential attempt requires a normalized login identity")
	}
	namespace := []string{"org-id", organizationID}
	if organizationID == "" {
		namespace = []string{"unknown-slug", normalizedSlug}
	}
	organization, err := newCredentialAttemptKey(organizationAttemptScope, namespace...)
	if err != nil {
		return [2]credentialAttemptKey{}, err
	}
	account, err := newCredentialAttemptKey(loginAttemptScope, append(namespace, normalizedEmail)...)
	return [2]credentialAttemptKey{organization, account}, err
}

func passwordChangeAttemptKeys(organizationID, userID string) ([2]credentialAttemptKey, error) {
	if organizationID == "" || userID == "" {
		return [2]credentialAttemptKey{}, fmt.Errorf("credential attempt requires verified Organization and User bindings")
	}
	organization, err := newCredentialAttemptKey(organizationAttemptScope, "org-id", organizationID)
	if err != nil {
		return [2]credentialAttemptKey{}, err
	}
	user, err := newCredentialAttemptKey(passwordChangeAttemptScope, userID)
	return [2]credentialAttemptKey{organization, user}, err
}

type credentialAttemptState struct {
	windowStart time.Time
	failures    int
	lockedUntil *time.Time
}

func (state credentialAttemptState) forAdmission(now time.Time) credentialAttemptState {
	if !now.Before(state.windowStart.Add(credentialAttemptWindow)) &&
		(state.lockedUntil == nil || !state.lockedUntil.After(now)) {
		return credentialAttemptState{windowStart: now}
	}
	return state
}

func (state credentialAttemptState) withFailure(scope credentialAttemptScope, now time.Time) credentialAttemptState {
	state = state.forAdmission(now)
	if state.failures == 0 {
		state.windowStart = now
	}
	threshold := scope.threshold()
	state.failures = min(state.failures+1, threshold+10)
	if state.failures >= threshold {
		delay := min(time.Second<<uint(state.failures-threshold), 15*time.Minute)
		until := now.Add(delay)
		state.lockedUntil = &until
	}
	return state
}

func (state credentialAttemptState) remaining(now time.Time) time.Duration {
	if state.lockedUntil == nil {
		return 0
	}
	return max(0, state.lockedUntil.Sub(now))
}
