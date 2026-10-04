package callercontext

import (
	"bytes"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	protocol "github.com/tf4fun/antnest-platform/modules/service-authentication/callercontext"
	"slices"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
)

type Signing struct {
	KID        string
	PrivateKey ed25519.PrivateKey
	Keys       Keys
}

func LoadSigning(lookup serviceauth.LookupEnv) (Signing, error) {
	if lookup == nil {
		return Signing{}, fmt.Errorf("CCT signing environment lookup is required")
	}
	kid, _ := lookup("ANTNEST_IDENTITY_CCT_SIGNING_KID")
	if !protocol.ValidKID(kid) {
		return Signing{}, fmt.Errorf("ANTNEST_IDENTITY_CCT_SIGNING_KID must be exact printable non-space ASCII")
	}
	path, _ := lookup("ANTNEST_IDENTITY_CCT_SIGNING_KEY_FILE")
	raw, err := serviceauth.ReadFile(path, 4096)
	if err != nil || !bytes.HasPrefix(raw, []byte("-----BEGIN PRIVATE KEY-----")) {
		return Signing{}, fmt.Errorf("CCT signing key must be one bounded PKCS8 PEM private key")
	}
	block, rest := pem.Decode(raw)
	if block == nil || block.Type != "PRIVATE KEY" || len(block.Headers) != 0 || len(bytes.TrimSpace(rest)) != 0 {
		return Signing{}, fmt.Errorf("CCT signing key must be one unencrypted PKCS8 PEM private key")
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return Signing{}, fmt.Errorf("CCT signing private key is invalid")
	}
	private, valid := parsed.(ed25519.PrivateKey)
	if !valid || len(private) != ed25519.PrivateKeySize {
		return Signing{}, fmt.Errorf("CCT signing private key must use Ed25519")
	}
	publicPath, _ := lookup("ANTNEST_IDENTITY_CCT_JWKS_FILE")
	publicJSON, err := serviceauth.ReadFile(publicPath, 16384)
	if err != nil {
		return Signing{}, fmt.Errorf("CCT public JWKS file cannot be read")
	}
	keys, err := protocol.ParseKeys(publicJSON)
	if err != nil || !slices.Equal(keys[kid], private.Public().(ed25519.PublicKey)) {
		return Signing{}, fmt.Errorf("CCT signing identity must match its configured public JWKS")
	}
	return Signing{KID: kid, PrivateKey: private, Keys: keys}, nil
}
