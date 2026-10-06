package secretencryption

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"slices"
)

const envelopeVersion byte = 1

type SealedSecret struct {
	KeyID          string
	WrappedDataKey []byte
	Nonce          []byte
	Ciphertext     []byte
}

// KeyEncrypter is the adapter boundary for local master keys or a future KMS.
// Adapters must authenticate associatedData, including the exact key ID.
type KeyEncrypter interface {
	WrapDataKey(context.Context, string, []byte, []byte) ([]byte, error)
	UnwrapDataKey(context.Context, string, []byte, []byte) ([]byte, error)
}

type LegacyOpener interface {
	OpenLegacy(context.Context, []byte, []byte, []byte) ([]byte, error)
}

type Box struct {
	activeKID, purpose string
	wrapper            KeyEncrypter
	legacy             LegacyOpener
}

func New(activeKID, purpose string, wrapper KeyEncrypter, legacy LegacyOpener) (*Box, error) {
	if !keyIDPattern.MatchString(activeKID) || purpose == "" || wrapper == nil {
		return nil, ErrConfiguration
	}
	return &Box{activeKID: activeKID, purpose: purpose, wrapper: wrapper, legacy: legacy}, nil
}

func (box *Box) ActiveKeyID() string { return box.activeKID }

func (box *Box) Seal(ctx context.Context, plaintext, identity []byte) (SealedSecret, error) {
	if err := ctx.Err(); err != nil {
		return SealedSecret{}, err
	}
	if len(identity) == 0 {
		return SealedSecret{}, ErrMetadata
	}
	key := make([]byte, 32)
	defer clear(key)
	if _, err := rand.Read(key); err != nil {
		return SealedSecret{}, err
	}
	aead, err := newAEAD(key)
	if err != nil {
		return SealedSecret{}, err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return SealedSecret{}, err
	}
	ciphertext := aead.Seal(nil, nonce, plaintext, box.payloadAAD(identity))
	wrapped, err := box.wrapper.WrapDataKey(ctx, box.activeKID, key, box.wrapAAD(identity, box.activeKID))
	if err != nil {
		return SealedSecret{}, err
	}
	if len(wrapped) == 0 {
		return SealedSecret{}, ErrMetadata
	}
	return SealedSecret{KeyID: box.activeKID, WrappedDataKey: wrapped, Nonce: nonce, Ciphertext: ciphertext}, nil
}

func (box *Box) Open(ctx context.Context, sealed SealedSecret, identity []byte) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if err := validRecord(sealed, identity); err != nil {
		return nil, err
	}
	if sealed.WrappedDataKey == nil {
		if sealed.KeyID != LegacyKeyID || box.legacy == nil {
			return nil, ErrMetadata
		}
		return box.legacy.OpenLegacy(ctx, sealed.Nonce, sealed.Ciphertext, identity)
	}
	key, err := box.wrapper.UnwrapDataKey(ctx, sealed.KeyID, sealed.WrappedDataKey, box.wrapAAD(identity, sealed.KeyID))
	if err != nil {
		return nil, err
	}
	defer clear(key)
	return box.openPayload(key, sealed, identity)
}

func (box *Box) Rekey(ctx context.Context, sealed SealedSecret, identity []byte) (SealedSecret, error) {
	if err := ctx.Err(); err != nil {
		return SealedSecret{}, err
	}
	if err := validRecord(sealed, identity); err != nil {
		return SealedSecret{}, err
	}
	if sealed.WrappedDataKey == nil {
		plaintext, err := box.Open(ctx, sealed, identity)
		if err != nil {
			return SealedSecret{}, err
		}
		defer clear(plaintext)
		return box.Seal(ctx, plaintext, identity)
	}
	key, err := box.wrapper.UnwrapDataKey(ctx, sealed.KeyID, sealed.WrappedDataKey, box.wrapAAD(identity, sealed.KeyID))
	if err != nil {
		return SealedSecret{}, err
	}
	defer clear(key)
	plaintext, err := box.openPayload(key, sealed, identity)
	if err != nil {
		return SealedSecret{}, err
	}
	clear(plaintext)
	if sealed.KeyID == box.activeKID {
		return sealed, nil
	}
	wrapped, err := box.wrapper.WrapDataKey(ctx, box.activeKID, key, box.wrapAAD(identity, box.activeKID))
	if err != nil {
		return SealedSecret{}, err
	}
	if len(wrapped) == 0 {
		return SealedSecret{}, ErrMetadata
	}
	sealed.KeyID, sealed.WrappedDataKey = box.activeKID, wrapped
	return sealed, nil
}

// Authenticate computes a domain-separated MAC without exporting a data key.
// The envelope must authenticate before its key is used. Re-wrapping its master
// key preserves this MAC, while a new envelope has an independent MAC key.
func (box *Box) Authenticate(ctx context.Context, sealed SealedSecret, identity []byte, purpose string, value []byte) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if err := validRecord(sealed, identity); err != nil {
		return nil, err
	}
	if purpose == "" || len(sealed.WrappedDataKey) == 0 {
		return nil, ErrMetadata
	}
	key, err := box.wrapper.UnwrapDataKey(ctx, sealed.KeyID, sealed.WrappedDataKey, box.wrapAAD(identity, sealed.KeyID))
	if err != nil {
		return nil, err
	}
	defer clear(key)
	plaintext, err := box.openPayload(key, sealed, identity)
	if err != nil {
		return nil, err
	}
	clear(plaintext)
	derive := hmac.New(sha256.New, key)
	_, _ = derive.Write(frame([]byte("antnest-envelope-mac-key-v1"), box.payloadAAD(identity), []byte(purpose)))
	subkey := derive.Sum(nil)
	defer clear(subkey)
	mac := hmac.New(sha256.New, subkey)
	_, _ = mac.Write(value)
	return mac.Sum(nil), nil
}

func validRecord(sealed SealedSecret, identity []byte) error {
	if len(identity) == 0 || !keyIDPattern.MatchString(sealed.KeyID) || len(sealed.Nonce) != 12 || len(sealed.Ciphertext) < 16 {
		return ErrMetadata
	}
	return nil
}

func (box *Box) openPayload(key []byte, sealed SealedSecret, identity []byte) ([]byte, error) {
	if len(key) != 32 {
		return nil, ErrMetadata
	}
	aead, err := newAEAD(key)
	if err != nil {
		return nil, err
	}
	plaintext, err := aead.Open(nil, sealed.Nonce, sealed.Ciphertext, box.payloadAAD(identity))
	if err != nil {
		return nil, ErrAuthentication
	}
	return plaintext, nil
}

func (box *Box) payloadAAD(identity []byte) []byte {
	return frame([]byte("antnest-envelope-v1"), []byte(box.purpose), identity)
}
func (box *Box) wrapAAD(identity []byte, kid string) []byte {
	return frame(box.payloadAAD(identity), []byte(kid))
}

func frame(values ...[]byte) []byte {
	var result []byte
	for _, value := range values {
		result = binary.BigEndian.AppendUint32(result, uint32(len(value)))
		result = append(result, value...)
	}
	return result
}

type LocalKeyEncrypter struct{ keys map[string]cipher.AEAD }

func NewLocal(config Config, purpose string) (*Box, error) {
	wrapper := &LocalKeyEncrypter{keys: make(map[string]cipher.AEAD, len(config.Keys))}
	for kid, key := range config.Keys {
		if !keyIDPattern.MatchString(kid) || len(key) != 32 {
			return nil, ErrConfiguration
		}
		aead, err := newAEAD(key)
		if err != nil {
			return nil, err
		}
		wrapper.keys[kid] = aead
	}
	if wrapper.keys[config.ActiveKID] == nil {
		return nil, ErrConfiguration
	}
	return New(config.ActiveKID, purpose, wrapper, wrapper)
}

func newAEAD(key []byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, ErrConfiguration
	}
	return cipher.NewGCM(block)
}

func (wrapper *LocalKeyEncrypter) WrapDataKey(ctx context.Context, kid string, key, aad []byte) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	aead := wrapper.keys[kid]
	if aead == nil {
		return nil, ErrUnknownKey
	}
	if len(key) != 32 || len(aad) == 0 {
		return nil, ErrMetadata
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	wrapped := append([]byte{envelopeVersion}, nonce...)
	return aead.Seal(wrapped, nonce, key, aad), nil
}

func (wrapper *LocalKeyEncrypter) UnwrapDataKey(ctx context.Context, kid string, wrapped, aad []byte) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	aead := wrapper.keys[kid]
	if aead == nil {
		return nil, ErrUnknownKey
	}
	if len(wrapped) != 1+aead.NonceSize()+32+aead.Overhead() || wrapped[0] != envelopeVersion {
		return nil, ErrMetadata
	}
	nonce := wrapped[1 : 1+aead.NonceSize()]
	key, err := aead.Open(nil, nonce, wrapped[1+aead.NonceSize():], aad)
	if err != nil {
		return nil, ErrAuthentication
	}
	return key, nil
}

func (wrapper *LocalKeyEncrypter) OpenLegacy(ctx context.Context, nonce, ciphertext, aad []byte) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	aead := wrapper.keys[LegacyKeyID]
	if aead == nil {
		return nil, ErrUnknownKey
	}
	if len(nonce) != aead.NonceSize() {
		return nil, ErrMetadata
	}
	plaintext, err := aead.Open(nil, nonce, ciphertext, slices.Clone(aad))
	if err != nil {
		return nil, ErrAuthentication
	}
	return plaintext, nil
}
