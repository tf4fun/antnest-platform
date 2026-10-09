package instanceauth

import (
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/netip"
	"strings"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
)

const TunnelFile = Directory + "/tunnel.json"

var ErrTunnelRegistrationUnavailable = errors.New("tunnel registration unavailable")
var ErrTunnelRegistrationRejected = errors.New("tunnel registration rejected")

type TunnelDescriptor struct {
	KeyID      string `json:"key_id"`
	KeysFile   string `json:"keys_file"`
	KeysDigest string `json:"keys_digest"`
}
type TunnelRecord struct {
	KeyID      string   `json:"key_id"`
	KeysDigest string   `json:"keys_digest"`
	Sealed     Envelope `json:"sealed"`
}

func (r *TunnelRecord) Descriptor() TunnelDescriptor {
	if r == nil {
		return TunnelDescriptor{}
	}
	return TunnelDescriptor{KeyID: r.KeyID, KeysFile: TunnelFile, KeysDigest: r.KeysDigest}
}

type tunnelMaterial struct {
	RuntimePrivate string `json:"runtime_private_key"`
	EgressPrivate  string `json:"egress_private_key"`
	Preshared      string `json:"preshared_key"`
}
type runtimeTunnelFile struct {
	KeyID          string `json:"key_id"`
	RuntimePrivate string `json:"runtime_private_key"`
	EgressPublic   string `json:"egress_public_key"`
	Preshared      string `json:"preshared_key"`
}

// TunnelRegistration is a private RC -> Egress request. Never log/capture it.
type TunnelRegistration struct {
	KeyID           string `json:"key_id"`
	RuntimeRevision string `json:"runtime_revision"`
	TunnelIPv4      string `json:"tunnel_ipv4"`
	EgressPrivate   string `json:"egress_private_key"`
	RuntimePublic   string `json:"runtime_public_key"`
	Preshared       string `json:"preshared_key"`
}

func ValidTunnelKeyID(value string) bool {
	if len(value) != 36 || !strings.HasPrefix(value, "rtk_") {
		return false
	}
	data, err := hex.DecodeString(value[4:])
	return err == nil && hex.EncodeToString(data) == value[4:]
}
func validTunnelRecord(r *TunnelRecord) bool {
	if r == nil || !ValidTunnelKeyID(r.KeyID) || len(r.KeysDigest) != 71 || !strings.HasPrefix(r.KeysDigest, "sha256:") {
		return false
	}
	nonce, err := base64.RawURLEncoding.Strict().DecodeString(r.Sealed.Nonce)
	sealed, serr := base64.RawURLEncoding.Strict().DecodeString(r.Sealed.Ciphertext)
	return err == nil && serr == nil && len(nonce) == 12 && len(sealed) > 16 && len(sealed) < 1024
}
func (m *Manager) issueTunnel(id Identity, record *Record) error {
	runtime, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return errors.New("tunnel entropy unavailable")
	}
	egress, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return errors.New("tunnel entropy unavailable")
	}
	var psk [32]byte
	var keyID [16]byte
	if _, err := rand.Read(psk[:]); err != nil {
		return errors.New("tunnel entropy unavailable")
	}
	defer clear(psk[:])
	if _, err := rand.Read(keyID[:]); err != nil {
		return errors.New("tunnel entropy unavailable")
	}
	record.Tunnel = &TunnelRecord{KeyID: "rtk_" + hex.EncodeToString(keyID[:])}
	value := tunnelMaterial{RuntimePrivate: base64.RawURLEncoding.EncodeToString(runtime.Bytes()), EgressPrivate: base64.RawURLEncoding.EncodeToString(egress.Bytes()), Preshared: base64.RawURLEncoding.EncodeToString(psk[:])}
	plain, err := json.Marshal(value)
	if err != nil {
		return err
	}
	defer clear(plain)
	nonce := make([]byte, m.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return errors.New("tunnel entropy unavailable")
	}
	sealed := m.aead.Seal(nil, nonce, plain, aad(id, record.ConnectionID, "runtime-tunnel:"+record.Tunnel.KeyID))
	record.Tunnel.Sealed = Envelope{Nonce: base64.RawURLEncoding.EncodeToString(nonce), Ciphertext: base64.RawURLEncoding.EncodeToString(sealed)}
	file, err := tunnelFile(record.Tunnel.KeyID, value)
	if err != nil {
		return err
	}
	defer clear(file)
	record.Tunnel.KeysDigest = Digest(file)
	return nil
}
func (m *Manager) openTunnel(id Identity, record *Record) (tunnelMaterial, error) {
	invalid := errors.New("accepted tunnel material is invalid")
	if id.Validate() != nil || record == nil || !ValidConnectionID(record.ConnectionID) || !validTunnelRecord(record.Tunnel) {
		return tunnelMaterial{}, invalid
	}
	nonce, _ := base64.RawURLEncoding.Strict().DecodeString(record.Tunnel.Sealed.Nonce)
	sealed, _ := base64.RawURLEncoding.Strict().DecodeString(record.Tunnel.Sealed.Ciphertext)
	plain, err := m.aead.Open(nil, nonce, sealed, aad(id, record.ConnectionID, "runtime-tunnel:"+record.Tunnel.KeyID))
	if err != nil {
		return tunnelMaterial{}, invalid
	}
	defer clear(plain)
	var value tunnelMaterial
	if serviceauth.DecodeObject(plain, &value) != nil {
		return tunnelMaterial{}, invalid
	}
	for _, encoded := range []string{value.RuntimePrivate, value.EgressPrivate, value.Preshared} {
		data, err := base64.RawURLEncoding.Strict().DecodeString(encoded)
		if err != nil || len(data) != 32 || base64.RawURLEncoding.EncodeToString(data) != encoded {
			return tunnelMaterial{}, invalid
		}
		clear(data)
	}
	return value, nil
}
func publicKey(encoded string) (string, error) {
	data, err := base64.RawURLEncoding.Strict().DecodeString(encoded)
	if err != nil || len(data) != 32 {
		return "", errors.New("tunnel private key invalid")
	}
	defer clear(data)
	key, err := ecdh.X25519().NewPrivateKey(data)
	if err != nil {
		return "", errors.New("tunnel private key invalid")
	}
	return base64.RawURLEncoding.EncodeToString(key.PublicKey().Bytes()), nil
}
func tunnelFile(keyID string, value tunnelMaterial) ([]byte, error) {
	pub, err := publicKey(value.EgressPrivate)
	if err != nil {
		return nil, err
	}
	return json.Marshal(runtimeTunnelFile{KeyID: keyID, RuntimePrivate: value.RuntimePrivate, EgressPublic: pub, Preshared: value.Preshared})
}
func (m *Manager) TunnelFile(id Identity, record *Record) ([]byte, error) {
	value, err := m.openTunnel(id, record)
	if err != nil {
		return nil, err
	}
	file, err := tunnelFile(record.Tunnel.KeyID, value)
	if err != nil || Digest(file) != record.Tunnel.KeysDigest {
		clear(file)
		return nil, errors.New("tunnel receiver identity differs")
	}
	return file, nil
}
func (m *Manager) TunnelRegistration(id Identity, record *Record, revision, tunnelIPv4 string) (TunnelRegistration, error) {
	ip, err := netip.ParseAddr(tunnelIPv4)
	if err != nil || !ip.Is4() || !ip.IsGlobalUnicast() || len(revision) != 36 || !strings.HasPrefix(revision, "rtv_") {
		return TunnelRegistration{}, errors.New("tunnel registration identity invalid")
	}
	if _, err := hex.DecodeString(revision[4:]); err != nil {
		return TunnelRegistration{}, errors.New("tunnel registration identity invalid")
	}
	value, err := m.openTunnel(id, record)
	if err != nil {
		return TunnelRegistration{}, err
	}
	pub, err := publicKey(value.RuntimePrivate)
	if err != nil {
		return TunnelRegistration{}, err
	}
	return TunnelRegistration{KeyID: record.Tunnel.KeyID, RuntimeRevision: revision, TunnelIPv4: tunnelIPv4, EgressPrivate: value.EgressPrivate, RuntimePublic: pub, Preshared: value.Preshared}, nil
}
