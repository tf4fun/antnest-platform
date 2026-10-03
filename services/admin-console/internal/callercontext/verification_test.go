package callercontext

import (
	"encoding/json"
	"os"
	"testing"
	"time"
)

func TestVerifierConsumesSharedSignedVectors(t *testing.T) {
	raw, err := os.ReadFile("../../../../contracts/platform/caller-context-fixtures.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures struct {
		JWKS    json.RawMessage `json:"jwks"`
		Vectors []struct {
			Name         string  `json:"name"`
			Token        string  `json:"token"`
			Now          int64   `json:"now"`
			Tolerance    int64   `json:"tolerance"`
			Consumer     string  `json:"consumer"`
			Organization string  `json:"organization"`
			Agent        *string `json:"agent"`
			Valid        bool    `json:"valid"`
		} `json:"verification_vectors"`
	}
	if err := json.Unmarshal(raw, &fixtures); err != nil {
		t.Fatal(err)
	}
	keys, err := ParseKeys(fixtures.JWKS)
	if err != nil {
		t.Fatal(err)
	}
	for _, vector := range fixtures.Vectors {
		t.Run(vector.Name, func(t *testing.T) {
			_, err := Verify(vector.Token, keys, Expected{Consumer: vector.Consumer,
				Organization: vector.Organization, Agent: vector.Agent,
				Now: time.Unix(vector.Now, 0), Tolerance: vector.Tolerance})
			if (err == nil) != vector.Valid {
				t.Fatalf("accepted=%v want=%v error=%v", err == nil, vector.Valid, err)
			}
		})
	}
}

func TestPublicKeyParserRejectsPrivateAndAmbiguousMaterial(t *testing.T) {
	for _, raw := range []string{
		`{"keys":[]}`,
		`{"keys":[{"kid":"k","kty":"OKP","crv":"Ed25519","use":"sig","alg":"EdDSA","x":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","d":"private"}]}`,
		`{"keys":[{"kid":"k","kty":"OKP","crv":"X25519","use":"sig","alg":"EdDSA","x":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}]}`,
		`{"keys":[{"kid":"k","kty":"OKP","crv":"Ed25519","use":"enc","alg":"EdDSA","x":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}]}`,
		`{"keys":[{"kid":"k","kid":"other","kty":"OKP","crv":"Ed25519","use":"sig","alg":"EdDSA","x":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}]}`,
		`{"keys":[{"kid":"k","kty":"OKP","crv":"Ed25519","use":"sig","alg":"EdDSA","x":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},{"kid":"k","kty":"OKP","crv":"Ed25519","use":"sig","alg":"EdDSA","x":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}]}`,
	} {
		if _, err := ParseKeys([]byte(raw)); err == nil {
			t.Fatal("invalid public key set accepted")
		}
	}
}
