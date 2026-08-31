package credentials

import (
	"strings"
	"testing"
)

func TestPasswordHashRoundTripAndRandomSalt(t *testing.T) {
	t.Parallel()

	first, err := HashPassword("correct horse battery staple")
	if err != nil {
		t.Fatalf("hash password: %v", err)
	}
	second, err := HashPassword("correct horse battery staple")
	if err != nil {
		t.Fatalf("hash second password: %v", err)
	}
	if first == second {
		t.Fatal("password hashes reused a salt")
	}
	if !strings.HasPrefix(first, "$argon2id$") {
		t.Fatalf("hash = %q, want argon2id PHC encoding", first)
	}
	if ok, err := VerifyPassword(first, "correct horse battery staple"); err != nil || !ok {
		t.Fatalf("verify correct password: ok=%t err=%v", ok, err)
	}
	if ok, err := VerifyPassword(first, "wrong"); err != nil || ok {
		t.Fatalf("verify wrong password: ok=%t err=%v", ok, err)
	}
}

func TestPasswordRejectsWeakAndMalformedInputs(t *testing.T) {
	t.Parallel()

	if _, err := HashPassword("short"); err == nil {
		t.Fatal("short password was accepted")
	}
	for _, encoded := range []string{"", "not-a-hash", "$argon2id$v=19$m=1,t=1,p=1$bad$bad"} {
		if _, err := VerifyPassword(encoded, "irrelevant-password"); err == nil {
			t.Fatalf("malformed hash %q was accepted", encoded)
		}
	}
}
