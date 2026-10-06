package credentials

import (
	"context"

	secretencryption "github.com/tf4fun/antnest-platform/modules/secret-encryption"
)

type SealedSecret = secretencryption.SealedSecret

type Rekeyer interface {
	ActiveKeyID() string
	Rekey(context.Context, SealedSecret, string) (SealedSecret, error)
}

type SecretBox struct{ box *secretencryption.Box }

func NewSecretBox(key []byte) (*SecretBox, error) {
	return NewKeyring(secretencryption.Config{ActiveKID: secretencryption.LegacyKeyID, Keys: map[string][]byte{secretencryption.LegacyKeyID: key}})
}

func NewKeyring(config secretencryption.Config) (*SecretBox, error) {
	box, err := secretencryption.NewLocal(config, "identity-service")
	if err != nil {
		return nil, err
	}
	return &SecretBox{box: box}, nil
}

func (b *SecretBox) ActiveKeyID() string { return b.box.ActiveKeyID() }

func (b *SecretBox) Seal(plaintext []byte, recordID string) (SealedSecret, error) {
	return b.box.Seal(context.Background(), plaintext, []byte(recordID))
}

func (b *SecretBox) Open(sealed SealedSecret, recordID string) ([]byte, error) {
	return b.box.Open(context.Background(), sealed, []byte(recordID))
}

func (b *SecretBox) Rekey(ctx context.Context, sealed SealedSecret, recordID string) (SealedSecret, error) {
	return b.box.Rekey(ctx, sealed, []byte(recordID))
}
