package deployment

import (
	"encoding/base64"
	"encoding/json"
	"testing"
)

func TestMaintenanceVerifierSetNormalizesAndChangesDeploymentIdentity(t *testing.T) {
	first := base64.RawURLEncoding.EncodeToString(make([]byte, 32))
	secondBytes := make([]byte, 32)
	secondBytes[0] = 1
	second := base64.RawURLEncoding.EncodeToString(secondBytes)
	keys := MaintenanceVerifiers{Keys: []MaintenanceVerifierKey{
		{KID: "next", Algorithm: "Ed25519", PublicKeyBase64URL: second},
		{KID: "current", Algorithm: "Ed25519", PublicKeyBase64URL: first},
	}}
	normalized, err := keys.Normalize()
	if err != nil {
		t.Fatal(err)
	}
	if normalized.Keys[0].KID != "current" || normalized.Keys[1].KID != "next" {
		t.Fatalf("noncanonical verifier order: %+v", normalized.Keys)
	}
	base := testDeployment()
	base.RuntimeSpec.SkillMaintenanceVerifiers = &normalized
	encoded, err := json.Marshal(base.RuntimeSpec)
	if err != nil {
		t.Fatal(err)
	}
	var wire map[string]any
	if err := json.Unmarshal(encoded, &wire); err != nil {
		t.Fatal(err)
	}
	if wire["skill_maintenance_verifiers"] == nil {
		t.Fatal("verifier bootstrap missing from RuntimeSpec")
	}
	firstDigest, err := DigestValue(base)
	if err != nil {
		t.Fatal(err)
	}
	base.RuntimeSpec.SkillMaintenanceVerifiers = nil
	secondDigest, err := DigestValue(base)
	if err != nil {
		t.Fatal(err)
	}
	if firstDigest == secondDigest {
		t.Fatal("trusted key set is absent from deployment identity")
	}
	keys.Keys[0].KID = "changed"
	if normalized.Keys[1].KID != "next" {
		t.Fatal("normalized key set aliases caller input")
	}
}

func TestMaintenanceVerifierSetRejectsInvalidAndAmbiguousKeys(t *testing.T) {
	valid := base64.RawURLEncoding.EncodeToString(make([]byte, 32))
	for _, keys := range [][]MaintenanceVerifierKey{
		{{KID: "bad key", Algorithm: "Ed25519", PublicKeyBase64URL: valid}},
		{{KID: "one", Algorithm: "ECDSA", PublicKeyBase64URL: valid}},
		{{KID: "one", Algorithm: "Ed25519", PublicKeyBase64URL: valid + "="}},
		{{KID: "one", Algorithm: "Ed25519", PublicKeyBase64URL: "abc"}},
		{{KID: "one", Algorithm: "Ed25519", PublicKeyBase64URL: valid}, {KID: "one", Algorithm: "Ed25519", PublicKeyBase64URL: valid}},
		{{KID: "a", Algorithm: "Ed25519", PublicKeyBase64URL: valid}, {KID: "b", Algorithm: "Ed25519", PublicKeyBase64URL: valid}, {KID: "c", Algorithm: "Ed25519", PublicKeyBase64URL: valid}},
	} {
		if _, err := (MaintenanceVerifiers{Keys: keys}).Normalize(); err == nil {
			t.Fatalf("invalid maintenance verifier set accepted: %+v", keys)
		}
	}
}
