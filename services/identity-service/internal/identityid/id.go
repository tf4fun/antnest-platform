package identityid

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
)

func New() (string, error) {
	buffer := make([]byte, 18)
	if _, err := rand.Read(buffer); err != nil {
		return "", fmt.Errorf("generate identity ID: %w", err)
	}
	return "id_" + base64.RawURLEncoding.EncodeToString(buffer), nil
}

func MustNew() string {
	value, err := New()
	if err != nil {
		panic(err)
	}
	return value
}
