package postgres

import (
	"testing"
	"time"
)

func TestSignedLegacyExpiryToleratesOnlyPostgresPrecisionLoss(t *testing.T) {
	stored := time.Unix(100, 123456000).UTC()
	for _, delta := range []time.Duration{123, 789, -123, -789} {
		if !sameStoredLegacyExpiry(stored.Add(delta), stored) {
			t.Fatalf("rejected sub-microsecond storage difference %s", delta)
		}
	}
	for _, delta := range []time.Duration{time.Microsecond, -time.Microsecond, time.Second} {
		if sameStoredLegacyExpiry(stored.Add(delta), stored) {
			t.Fatalf("accepted material expiry difference %s", delta)
		}
	}
}
