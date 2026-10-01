package credentials

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"io"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

const LocalKeyVersion = "local-v1"

type SecretBox struct {
	aead cipher.AEAD
}

func NewSecretBox(key []byte) (*SecretBox, error) {
	if len(key) != 32 {
		return nil, fmt.Errorf("provider credential encryption key must contain exactly 32 bytes")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("create Provider credential cipher: %w", err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("create Provider credential AEAD: %w", err)
	}
	return &SecretBox{aead: aead}, nil
}

func (box *SecretBox) Seal(
	ctx context.Context, identity ports.CredentialIdentity, plaintext string,
) (ports.SealedSecret, error) {
	if err := ctx.Err(); err != nil {
		return ports.SealedSecret{}, err
	}
	aad, err := credentialAAD(identity)
	if err != nil {
		return ports.SealedSecret{}, err
	}
	nonce := make([]byte, box.aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return ports.SealedSecret{}, fmt.Errorf("generate Provider credential nonce: %w", err)
	}
	return ports.SealedSecret{
		Ciphertext: box.aead.Seal(nil, nonce, []byte(plaintext), aad),
		Nonce:      nonce, KeyVersion: LocalKeyVersion,
	}, nil
}

func (box *SecretBox) Open(
	ctx context.Context, identity ports.CredentialIdentity, sealed ports.SealedSecret,
) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if sealed.KeyVersion != LocalKeyVersion {
		return "", fmt.Errorf("unsupported Provider credential key version %q", sealed.KeyVersion)
	}
	if len(sealed.Nonce) != box.aead.NonceSize() {
		return "", fmt.Errorf("invalid Provider credential nonce")
	}
	aad, err := credentialAAD(identity)
	if err != nil {
		return "", err
	}
	plaintext, err := box.aead.Open(nil, sealed.Nonce, sealed.Ciphertext, aad)
	if err != nil {
		return "", fmt.Errorf("authenticate Provider credential: %w", err)
	}
	return string(plaintext), nil
}

func credentialAAD(identity ports.CredentialIdentity) ([]byte, error) {
	values := []string{identity.OrganizationID, identity.CredentialRef, identity.CredentialVersion}
	for _, value := range values {
		if value == "" {
			return nil, errors.New("provider credential identity is incomplete")
		}
	}
	length := 4*len(values) + len(values[0]) + len(values[1]) + len(values[2])
	result := make([]byte, 0, length)
	var encodedLength [4]byte
	for _, value := range values {
		binary.BigEndian.PutUint32(encodedLength[:], uint32(len(value)))
		result = append(result, encodedLength[:]...)
		result = append(result, value...)
	}
	return result, nil
}
