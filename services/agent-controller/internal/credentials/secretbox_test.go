package credentials

import (
	"context"
	"testing"

	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestSecretBoxRoundTripBindsCredentialIdentity(t *testing.T) {
	t.Parallel()

	box, err := NewSecretBox([]byte("0123456789abcdef0123456789abcdef"))
	if err != nil {
		t.Fatalf("new SecretBox: %v", err)
	}
	identity := ports.CredentialIdentity{
		OrganizationID: "org-1", CredentialRef: "credential-1", CredentialVersion: "version-1",
	}
	sealed, err := box.Seal(context.Background(), identity, "provider-secret")
	if err != nil {
		t.Fatalf("seal credential: %v", err)
	}
	if len(sealed.Nonce) == 0 || len(sealed.Ciphertext) == 0 || sealed.KeyVersion != LocalKeyVersion {
		t.Fatalf("sealed credential is incomplete: %+v", sealed)
	}
	plaintext, err := box.Open(context.Background(), identity, sealed)
	if err != nil {
		t.Fatalf("open credential: %v", err)
	}
	if plaintext != "provider-secret" {
		t.Fatalf("opened credential = %q", plaintext)
	}

	wrongIdentity := identity
	wrongIdentity.OrganizationID = "org-2"
	if _, err := box.Open(context.Background(), wrongIdentity, sealed); err == nil {
		t.Fatal("credential opened with the wrong organization identity")
	}
}

func TestSecretBoxRejectsInvalidKeyAndKeyVersion(t *testing.T) {
	t.Parallel()

	if _, err := NewSecretBox([]byte("short")); err == nil {
		t.Fatal("short encryption key was accepted")
	}
	box, err := NewSecretBox([]byte("0123456789abcdef0123456789abcdef"))
	if err != nil {
		t.Fatalf("new SecretBox: %v", err)
	}
	identity := ports.CredentialIdentity{
		OrganizationID: "org-1", CredentialRef: "credential-1", CredentialVersion: "version-1",
	}
	if _, err := box.Open(context.Background(), identity, ports.SealedSecret{
		Nonce: make([]byte, 12), Ciphertext: []byte("ciphertext"), KeyVersion: "unknown",
	}); err == nil {
		t.Fatal("unknown key version was accepted")
	}
}
