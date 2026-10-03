package callercontext

import (
	"encoding/json"
	"fmt"
	"os"
	"testing"
	"time"
)

func TestNumericDatesUseJSONIntegerSemantics(t *testing.T) {
	authority, _, now := newTestAuthority(t)
	for _, date := range []struct {
		value string
		valid bool
	}{
		{"1800000000", true}, {"1800000000.0", true}, {"1.8e9", true},
		{"1800000000.5", false}, {`"1800000000"`, false}, {"null", false},
	} {
		t.Run(date.value, func(t *testing.T) {
			raw := []byte(fmt.Sprintf(`{"iss":"antnest://service/identity-service","sub":"admin","org":"org-1","mbr":"membership-1","sys_role":"admin","org_role":"admin","sid":"session-1","aud":["identity-service"],"iat":%s,"exp":1800000060,"jti":"unique"}`, date.value))
			signed, err := authority.signer.Sign(raw)
			if err != nil {
				t.Fatal(err)
			}
			token, err := signed.CompactSerialize()
			if err != nil {
				t.Fatal(err)
			}
			_, err = Verify(token, authority.keys, Expected{Consumer: "identity-service", Now: now})
			if (err == nil) != date.valid {
				t.Fatalf("accepted=%v want=%v", err == nil, date.valid)
			}
		})
	}
}

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
