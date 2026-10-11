package identity

import (
	"regexp"
	"time"
)

var publicIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$`)

// ValidPublicID matches the browser schemas; private CCT SIDs have their own
// established, broader syntax and must not be treated as public references.
func ValidPublicID(value string) bool { return publicIDPattern.MatchString(value) }

// SessionMetadata is issued by Identity. Reads preserve both deadlines;
// only the explicit activity operation may extend IdleExpiresAt.
type SessionMetadata struct {
	ExpiresAt          time.Time `json:"expires_at"`
	IdleExpiresAt      time.Time `json:"idle_expires_at"`
	ActivityIntervalMS int       `json:"activity_interval_ms"`
}

func (value SessionMetadata) Valid() bool {
	return !value.ExpiresAt.IsZero() && !value.IdleExpiresAt.IsZero() &&
		!value.IdleExpiresAt.After(value.ExpiresAt) &&
		value.ActivityIntervalMS >= 1 && value.ActivityIntervalMS <= 30000
}

func (principal Principal) SessionMetadata() SessionMetadata {
	return SessionMetadata{principal.ExpiresAt, principal.IdleExpiresAt, principal.ActivityIntervalMS}
}

func (result LoginResult) SessionMetadata() SessionMetadata {
	return SessionMetadata{result.ExpiresAt, result.IdleExpiresAt, result.ActivityIntervalMS}
}

func (result OIDCCallbackResult) SessionMetadata() SessionMetadata {
	return SessionMetadata{result.ExpiresAt, result.IdleExpiresAt, result.ActivityIntervalMS}
}
