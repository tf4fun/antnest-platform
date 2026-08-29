package admission

import "testing"

func TestIssuerDerivesStableGenerationBoundCredentials(t *testing.T) {
	issuer, err := NewIssuer([]byte("01234567890123456789012345678901"))
	if err != nil {
		t.Fatalf("new issuer: %v", err)
	}
	first, err := issuer.Token("agent-1", 1)
	if err != nil {
		t.Fatalf("first token: %v", err)
	}
	replay, err := issuer.Token("agent-1", 1)
	if err != nil {
		t.Fatalf("replay token: %v", err)
	}
	next, err := issuer.Token("agent-1", 2)
	if err != nil {
		t.Fatalf("next token: %v", err)
	}
	if first != replay || first == next || len(first) < 32 {
		t.Fatalf("unexpected tokens: first=%q replay=%q next=%q", first, replay, next)
	}
	if !issuer.Verify("agent-1", 1, first) || issuer.Verify("agent-1", 2, first) {
		t.Fatal("token verification did not enforce generation")
	}
	if InstanceID("agent-1", 1) == InstanceID("agent-1", 2) {
		t.Fatal("runtime instance id did not enforce generation")
	}
}

func TestIssuerRejectsWeakSecretAndInvalidIdentity(t *testing.T) {
	if _, err := NewIssuer([]byte("short")); err == nil {
		t.Fatal("weak secret accepted")
	}
	issuer, err := NewIssuer([]byte("01234567890123456789012345678901"))
	if err != nil {
		t.Fatalf("new issuer: %v", err)
	}
	if _, err := issuer.Token("", 1); err == nil {
		t.Fatal("empty agent id accepted")
	}
	if _, err := issuer.Token("agent-1", 0); err == nil {
		t.Fatal("zero generation accepted")
	}
}
