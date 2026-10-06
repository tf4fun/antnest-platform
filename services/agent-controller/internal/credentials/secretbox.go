package credentials

import (
	"context"
	"encoding/binary"
	"errors"

	secretencryption "github.com/tf4fun/antnest-platform/modules/secret-encryption"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

const LocalKeyVersion = secretencryption.LegacyKeyID

type SecretBox struct{ box *secretencryption.Box }

func NewSecretBox(key []byte) (*SecretBox, error) {
	return NewKeyring(secretencryption.Config{ActiveKID: LocalKeyVersion, Keys: map[string][]byte{LocalKeyVersion: key}})
}

func NewKeyring(config secretencryption.Config) (*SecretBox, error) {
	box, err := secretencryption.NewLocal(config, "agent-controller")
	if err != nil {
		return nil, err
	}
	return &SecretBox{box: box}, nil
}

func (box *SecretBox) ActiveKeyID() string { return box.box.ActiveKeyID() }

func (box *SecretBox) Seal(ctx context.Context, identity ports.CredentialIdentity, plaintext string) (ports.SealedSecret, error) {
	aad, err := credentialAAD(identity)
	if err != nil {
		return ports.SealedSecret{}, err
	}
	sealed, err := box.box.Seal(ctx, []byte(plaintext), aad)
	return fromEnvelope(sealed), err
}

func (box *SecretBox) Open(ctx context.Context, identity ports.CredentialIdentity, sealed ports.SealedSecret) (string, error) {
	aad, err := credentialAAD(identity)
	if err != nil {
		return "", err
	}
	plaintext, err := box.box.Open(ctx, toEnvelope(sealed), aad)
	if err != nil {
		return "", err
	}
	defer clear(plaintext)
	return string(plaintext), nil
}

func (box *SecretBox) Rekey(ctx context.Context, identity ports.CredentialIdentity, sealed ports.SealedSecret) (ports.SealedSecret, error) {
	aad, err := credentialAAD(identity)
	if err != nil {
		return ports.SealedSecret{}, err
	}
	rotated, err := box.box.Rekey(ctx, toEnvelope(sealed), aad)
	return fromEnvelope(rotated), err
}

func (box *SecretBox) Authenticate(ctx context.Context, identity ports.CredentialIdentity, sealed ports.SealedSecret, purpose string, value []byte) ([]byte, error) {
	aad, err := credentialAAD(identity)
	if err != nil {
		return nil, err
	}
	return box.box.Authenticate(ctx, toEnvelope(sealed), aad, purpose, value)
}

func toEnvelope(sealed ports.SealedSecret) secretencryption.SealedSecret {
	return secretencryption.SealedSecret{KeyID: sealed.KeyVersion, WrappedDataKey: sealed.WrappedDataKey, Nonce: sealed.Nonce, Ciphertext: sealed.Ciphertext}
}

func fromEnvelope(sealed secretencryption.SealedSecret) ports.SealedSecret {
	return ports.SealedSecret{KeyVersion: sealed.KeyID, WrappedDataKey: sealed.WrappedDataKey, Nonce: sealed.Nonce, Ciphertext: sealed.Ciphertext}
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
