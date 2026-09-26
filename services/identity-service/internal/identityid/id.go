package identityid

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
)

func New(kind string) (string, error) {
	switch kind {
	case "org", "user", "membership", "group", "groupmembership", "oidcprovider",
		"oidcsession", "oidcclaim", "externalidentity", "authtoken", "scimtoken", "event":
	default:
		return "", fmt.Errorf("unknown identity resource kind: %q", kind)
	}
	buffer := make([]byte, 16)
	if _, err := rand.Read(buffer); err != nil {
		return "", fmt.Errorf("generate identity ID: %w", err)
	}
	return kind + "_" + hex.EncodeToString(buffer), nil
}

func MustNew(kind string) string {
	value, err := New(kind)
	if err != nil {
		panic(err)
	}
	return value
}
