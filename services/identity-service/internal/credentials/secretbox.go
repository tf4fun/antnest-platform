package credentials

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"fmt"
)

type SealedSecret struct {
	Ciphertext []byte
	Nonce      []byte
}

type SecretBox struct {
	aead cipher.AEAD
}

func NewSecretBox(key []byte) (*SecretBox, error) {
	if len(key) != 32 {
		return nil, fmt.Errorf("secret box key must contain exactly 32 bytes")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("create AES cipher: %w", err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("create AES-GCM: %w", err)
	}
	return &SecretBox{aead: aead}, nil
}

func (b *SecretBox) Seal(plaintext []byte, recordID string) (SealedSecret, error) {
	if recordID == "" {
		return SealedSecret{}, fmt.Errorf("record identity is required")
	}
	nonce := make([]byte, b.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return SealedSecret{}, fmt.Errorf("generate AES-GCM nonce: %w", err)
	}
	ciphertext := b.aead.Seal(nil, nonce, plaintext, []byte(recordID))
	return SealedSecret{Ciphertext: ciphertext, Nonce: nonce}, nil
}

func (b *SecretBox) Open(sealed SealedSecret, recordID string) ([]byte, error) {
	if recordID == "" || len(sealed.Nonce) != b.aead.NonceSize() {
		return nil, fmt.Errorf("sealed secret metadata is invalid")
	}
	plaintext, err := b.aead.Open(nil, sealed.Nonce, sealed.Ciphertext, []byte(recordID))
	if err != nil {
		return nil, fmt.Errorf("open sealed secret: %w", err)
	}
	return plaintext, nil
}
