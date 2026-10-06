package credentials

import (
	"bytes"
	"context"
	"encoding/binary"
	"strconv"
	"strings"
	"testing"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func TestCredentialAADBoundsEachIdentityFieldBeforeEncoding(t *testing.T) {
	for _, field := range []string{"organization", "reference", "version"} {
		for _, size := range []int{0, 1024, 1025} {
			t.Run(field+"/"+strconv.Itoa(size), func(t *testing.T) {
				identity := ports.CredentialIdentity{OrganizationID: "org", CredentialRef: "ref", CredentialVersion: "version"}
				value := strings.Repeat("x", size)
				switch field {
				case "organization":
					identity.OrganizationID = value
				case "reference":
					identity.CredentialRef = value
				case "version":
					identity.CredentialVersion = value
				}
				aad, err := credentialAAD(identity)
				if size == 0 || size > 1024 {
					if err == nil || aad != nil {
						t.Fatal("invalid identity encoded")
					}
					if size > 1024 && strings.Contains(err.Error(), value) {
						t.Fatal("identity leaked in error")
					}
					return
				}
				if err != nil {
					t.Fatal(err)
				}
				remaining := aad
				for _, expected := range []string{identity.OrganizationID, identity.CredentialRef, identity.CredentialVersion} {
					if len(remaining) < 4 {
						t.Fatal("missing length prefix")
					}
					length := int(binary.BigEndian.Uint32(remaining[:4]))
					remaining = remaining[4:]
					if length != len(expected) || length > len(remaining) || string(remaining[:length]) != expected {
						t.Fatal("AAD framing changed")
					}
					remaining = remaining[length:]
				}
				if len(remaining) != 0 {
					t.Fatal("unexpected AAD suffix")
				}
			})
		}
	}
}

func TestCredentialAADPreservesHistoricalEncoding(t *testing.T) {
	identity := ports.CredentialIdentity{OrganizationID: "org", CredentialRef: "ref", CredentialVersion: "version"}
	aad, err := credentialAAD(identity)
	if err != nil {
		t.Fatal(err)
	}
	want := []byte("\x00\x00\x00\x03org\x00\x00\x00\x03ref\x00\x00\x00\x07version")
	if !bytes.Equal(aad, want) {
		t.Fatal("historical credential identity encoding changed")
	}
}

func TestCredentialAADBoundsUTF8BytesAndAcceptsMaximumIdentity(t *testing.T) {
	value := strings.Repeat("é", 512)
	identity := ports.CredentialIdentity{OrganizationID: value, CredentialRef: value, CredentialVersion: value}
	aad, err := credentialAAD(identity)
	if err != nil || len(aad) != 3084 {
		t.Fatal("maximum byte-length identity rejected", err)
	}
	identity.CredentialRef += "é"
	if aad, err := credentialAAD(identity); err == nil || aad != nil {
		t.Fatal("oversized UTF-8 identity encoded")
	}
}

func TestSecretBoxRejectsOversizedIdentityAtEveryOperation(t *testing.T) {
	box, err := NewSecretBox(bytes.Repeat([]byte{29}, 32))
	if err != nil {
		t.Fatal(err)
	}
	identity := ports.CredentialIdentity{OrganizationID: "org", CredentialRef: "ref", CredentialVersion: "version"}
	sealed, err := box.Seal(t.Context(), identity, "synthetic-secret")
	if err != nil {
		t.Fatal(err)
	}
	identity.CredentialRef = strings.Repeat("x", 1025)
	operations := map[string]func(context.Context) error{
		"seal":  func(ctx context.Context) error { _, err := box.Seal(ctx, identity, "synthetic-secret"); return err },
		"open":  func(ctx context.Context) error { _, err := box.Open(ctx, identity, sealed); return err },
		"rekey": func(ctx context.Context) error { _, err := box.Rekey(ctx, identity, sealed); return err },
		"authenticate": func(ctx context.Context) error {
			_, err := box.Authenticate(ctx, identity, sealed, "test", []byte("value"))
			return err
		},
	}
	for name, run := range operations {
		t.Run(name, func(t *testing.T) {
			if err := run(t.Context()); err == nil || err.Error() != "provider credential identity exceeds 1024 bytes per field" {
				t.Fatal("identity bound not applied before cryptography", err)
			}
		})
	}
}
