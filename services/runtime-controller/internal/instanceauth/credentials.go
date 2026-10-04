// Package instanceauth owns RC's sealed, per-generation Runtime authority.
package instanceauth

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"syscall"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
)

const Directory = "/run/antnest-auth"
const CallersFile = Directory + "/callers.json"

type Identity struct {
	Scope      string
	AgentID    string
	Generation uint64
}

type Envelope struct {
	Nonce      string `json:"nonce"`
	Ciphertext string `json:"ciphertext"`
}

// Record contains no bearer. It is committed with the generation's operation.
type Record struct {
	ConnectionID   string   `json:"connection_id"`
	ReceiverDigest string   `json:"receiver_digest"`
	Controller     Envelope `json:"runtime_controller"`
	ACP            Envelope `json:"agent_acp_service"`
}

type Manager struct{ aead cipher.AEAD }

func New(key []byte) (*Manager, error) {
	if len(key) != 32 {
		return nil, fmt.Errorf("instance master key must contain exactly 32 bytes")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("instance cipher initialization failed")
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("instance cipher initialization failed")
	}
	return &Manager{aead: aead}, nil
}

func LoadKey(path string) ([]byte, error) {
	file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, fmt.Errorf("private instance master key is unavailable")
	}
	defer func() { _ = file.Close() }()
	stat, err := file.Stat()
	if err != nil || !stat.Mode().IsRegular() || stat.Mode().Perm() != 0600 || stat.Size() != 32 {
		return nil, fmt.Errorf("instance master key must be a private regular 32-byte file")
	}
	data, err := io.ReadAll(io.LimitReader(file, 33))
	if err != nil || len(data) != 32 {
		return nil, fmt.Errorf("instance master key must contain exactly 32 bytes")
	}
	return data, nil
}

func (i Identity) Validate() error {
	if len(i.Scope) == 0 || len(i.Scope) > 200 || len(i.AgentID) == 0 || len(i.AgentID) > 200 || i.Generation == 0 {
		return fmt.Errorf("instance identity is invalid")
	}
	for _, value := range []string{i.Scope, i.AgentID} {
		for _, b := range []byte(value) {
			if b < 33 || b > 126 {
				return fmt.Errorf("instance identity is invalid")
			}
		}
	}
	return nil
}

func ValidConnectionID(value string) bool {
	if len(value) != 36 || !strings.HasPrefix(value, "rci_") {
		return false
	}
	decoded, err := hex.DecodeString(value[4:])
	return err == nil && hex.EncodeToString(decoded) == value[4:]
}

func (m *Manager) Issue(id Identity) (*Record, error) {
	if err := id.Validate(); err != nil {
		return nil, err
	}
	var connection [16]byte
	if _, err := rand.Read(connection[:]); err != nil {
		return nil, fmt.Errorf("instance entropy is unavailable")
	}
	record := &Record{ConnectionID: "rci_" + hex.EncodeToString(connection[:])}
	for _, caller := range []string{"runtime-controller", "agent-acp-service"} {
		var raw [32]byte
		if _, err := rand.Read(raw[:]); err != nil {
			return nil, fmt.Errorf("instance entropy is unavailable")
		}
		token := base64.RawURLEncoding.EncodeToString(raw[:])
		nonce := make([]byte, m.aead.NonceSize())
		if _, err := rand.Read(nonce); err != nil {
			return nil, fmt.Errorf("instance entropy is unavailable")
		}
		sealed := Envelope{Nonce: base64.RawURLEncoding.EncodeToString(nonce), Ciphertext: base64.RawURLEncoding.EncodeToString(m.aead.Seal(nil, nonce, []byte(token), aad(id, record.ConnectionID, caller)))}
		if caller == "runtime-controller" {
			record.Controller = sealed
		} else {
			record.ACP = sealed
		}
	}
	profile, err := m.receiver(id, record)
	if err != nil {
		return nil, err
	}
	record.ReceiverDigest = Digest(profile)
	return record, nil
}

func (m *Manager) Open(id Identity, record *Record, caller string) (string, error) {
	if err := id.Validate(); err != nil || record == nil || !ValidConnectionID(record.ConnectionID) {
		return "", fmt.Errorf("instance credential is invalid")
	}
	var envelope Envelope
	switch caller {
	case "runtime-controller":
		envelope = record.Controller
	case "agent-acp-service":
		envelope = record.ACP
	default:
		return "", fmt.Errorf("instance caller is invalid")
	}
	nonce, err := base64.RawURLEncoding.Strict().DecodeString(envelope.Nonce)
	if err != nil || len(nonce) != m.aead.NonceSize() {
		return "", fmt.Errorf("instance credential is invalid")
	}
	sealed, err := base64.RawURLEncoding.Strict().DecodeString(envelope.Ciphertext)
	if err != nil {
		return "", fmt.Errorf("instance credential is invalid")
	}
	token, err := m.aead.Open(nil, nonce, sealed, aad(id, record.ConnectionID, caller))
	if err != nil || len(token) != 43 || !serviceauth.ValidToken(token) {
		return "", fmt.Errorf("instance credential is invalid")
	}
	return string(token), nil
}

func (m *Manager) receiver(id Identity, record *Record) ([]byte, error) {
	callers := map[string][]string{}
	for _, caller := range []string{"runtime-controller", "agent-acp-service"} {
		token, err := m.Open(id, record, caller)
		if err != nil {
			return nil, err
		}
		callers[caller] = []string{Digest([]byte(token))}
	}
	return json.Marshal(callers)
}

func (m *Manager) Receiver(id Identity, record *Record) ([]byte, error) {
	profile, err := m.receiver(id, record)
	if err != nil {
		return nil, err
	}
	if Digest(profile) != record.ReceiverDigest {
		return nil, fmt.Errorf("instance receiver identity differs")
	}
	return profile, nil
}

func Digest(data []byte) string {
	sum := sha256.Sum256(data)
	return "sha256:" + hex.EncodeToString(sum[:])
}

func Decode(data []byte) (*Record, error) {
	var record Record
	if len(data) > 4096 || serviceauth.DecodeObject(data, &record) != nil || !ValidConnectionID(record.ConnectionID) || len(record.ReceiverDigest) != 71 || !strings.HasPrefix(record.ReceiverDigest, "sha256:") {
		return nil, fmt.Errorf("accepted instance credential record is invalid")
	}
	for _, e := range []Envelope{record.Controller, record.ACP} {
		nonce, nerr := base64.RawURLEncoding.Strict().DecodeString(e.Nonce)
		sealed, serr := base64.RawURLEncoding.Strict().DecodeString(e.Ciphertext)
		if nerr != nil || serr != nil || len(nonce) != 12 || len(sealed) != 59 || base64.RawURLEncoding.EncodeToString(nonce) != e.Nonce || base64.RawURLEncoding.EncodeToString(sealed) != e.Ciphertext {
			return nil, fmt.Errorf("accepted instance credential record is invalid")
		}
	}
	return &record, nil
}

func aad(id Identity, connection, caller string) []byte {
	// Length-prefix every component; scope and names cannot create ambiguity.
	var b strings.Builder
	b.WriteString("antnest-runtime-authority-v1")
	for _, value := range []string{id.Scope, id.AgentID, strconv.FormatUint(id.Generation, 10), connection, caller} {
		b.WriteString("\x00" + strconv.Itoa(len(value)) + ":" + value)
	}
	return []byte(b.String())
}
