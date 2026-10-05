package callercontext

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	protocol "github.com/tf4fun/antnest-platform/modules/service-authentication/callercontext"
	"os"
	"path/filepath"
	"testing"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
)

func TestSigningFilesRequireExactKIDAndMatchingPublicKey(t *testing.T) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(private)
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	privatePath := filepath.Join(directory, "signing.pem")
	publicPath := filepath.Join(directory, "jwks.json")
	if err := os.WriteFile(privatePath, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), 0o600); err != nil {
		t.Fatal(err)
	}
	publicJSON, err := json.Marshal(protocol.PublicKeys{Keys: []protocol.PublicKey{{KID: "signer", Kty: "OKP", Crv: "Ed25519", Use: "sig", Alg: "EdDSA", X: base64.RawURLEncoding.EncodeToString(public)}}})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(publicPath, publicJSON, 0o600); err != nil {
		t.Fatal(err)
	}
	base := map[string]string{"ANTNEST_IDENTITY_CCT_SIGNING_KID": "signer",
		"ANTNEST_IDENTITY_CCT_SIGNING_KEY_FILE": privatePath, "ANTNEST_IDENTITY_CCT_JWKS_FILE": publicPath}
	lookup := func(environment map[string]string) serviceauth.LookupEnv {
		return func(key string) (string, bool) { value, present := environment[key]; return value, present }
	}
	if _, err := LoadSigning(lookup(base)); err != nil {
		t.Fatal(err)
	}
	for _, kid := range []string{"", " signer", "signer ", "\t", "different", "é"} {
		environment := make(map[string]string)
		for key, value := range base {
			environment[key] = value
		}
		environment["ANTNEST_IDENTITY_CCT_SIGNING_KID"] = kid
		if _, err := LoadSigning(lookup(environment)); err == nil {
			t.Fatalf("mismatched/non-exact signing kid %q accepted", kid)
		}
	}
	for key := range base {
		environment := make(map[string]string)
		for name, value := range base {
			if name != key {
				environment[name] = value
			}
		}
		if _, err := LoadSigning(lookup(environment)); err == nil {
			t.Fatalf("partial signing configuration without %s accepted", key)
		}
	}
	_, other, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	otherDER, err := x509.MarshalPKCS8PrivateKey(other)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(privatePath, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: otherDER}), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadSigning(lookup(base)); err == nil {
		t.Fatal("private/public mismatch accepted")
	}
}
