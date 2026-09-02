package server

import (
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

	if !admission.Allow("192.0.2.1", "engineering", "Alice@Example.COM") ||
		!admission.Allow("192.0.2.1", "ENGINEERING", "alice@example.com") {
		t.Fatal("valid attempts were rejected before the account limit")
	}
	if admission.Allow("192.0.2.2", "engineering", "alice@example.com") {
		t.Fatal("normalized account limit was bypassed from another source")
	}
	if !admission.Allow("192.0.2.1", "engineering", "bob@example.com") {
		t.Fatal("source limit was reached too early")
	}
	if admission.Allow("192.0.2.1", "engineering", "carol@example.com") {
		t.Fatal("source limit was bypassed with another account")
	}

	now = now.Add(5 * time.Minute)
	if !admission.Allow("192.0.2.1", "engineering", "alice@example.com") {
		t.Fatal("expired admission window did not reopen")
	}
}

func TestLoginAdmissionFailsClosedAtBoundedKeyCapacity(t *testing.T) {
	t.Parallel()
	admission := newLoginAdmission(loginAdmissionConfig{
		Window: time.Minute, SourceLimit: 10, AccountLimit: 10,
		MaxKeys: 1, Now: time.Now,
	})
	if !admission.Allow("192.0.2.1", "engineering", "alice@example.com") {
		t.Fatal("first key was rejected")
	}
	if admission.Allow("192.0.2.2", "engineering", "bob@example.com") {
		t.Fatal("new keys were admitted after bounded capacity was exhausted")
	}
}
