package callercontext

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"math"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	jose "github.com/go-jose/go-jose/v4"

	"errors"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/serviceauth"
)

const Header = "Antnest-Caller-Context"
const Issuer = "antnest://service/identity-service"

var ErrInvalid = errors.New("caller_context_invalid")
var ErrDependency = errors.New("identity_dependency_unavailable")

type Keys map[string]ed25519.PublicKey

type publicKey struct {
	KID string `json:"kid"`
	Kty string `json:"kty"`
	Crv string `json:"crv"`
	Use string `json:"use"`
	Alg string `json:"alg"`
	X   string `json:"x"`
}

type publicKeys struct {
	Keys []publicKey `json:"keys"`
}

func ParseKeys(raw []byte) (Keys, error) {
	var document publicKeys
	if len(raw) > 16384 || serviceauth.DecodeObject(raw, &document) != nil || len(document.Keys) < 1 || len(document.Keys) > 8 {
		return nil, ErrInvalid
	}
	keys := make(Keys, len(document.Keys))
	for _, item := range document.Keys {
		if !validKID(item.KID) || keys[item.KID] != nil || item.Kty != "OKP" || item.Crv != "Ed25519" || item.Use != "sig" || item.Alg != "EdDSA" {
			return nil, ErrInvalid
		}
		key, err := decodeSegment(item.X)
		if err != nil || len(key) != ed25519.PublicKeySize {
			return nil, ErrInvalid
		}
		keys[item.KID] = ed25519.PublicKey(key)
	}
	return keys, nil
}

type protectedHeader struct {
	Type string `json:"typ"`
	Alg  string `json:"alg"`
	KID  string `json:"kid"`
}

type Claims struct {
	Issuer           string   `json:"iss"`
	Subject          string   `json:"sub"`
	Organization     string   `json:"org"`
	Membership       string   `json:"mbr"`
	SystemRole       string   `json:"sys_role"`
	OrganizationRole string   `json:"org_role"`
	Session          string   `json:"sid"`
	Audience         []string `json:"aud"`
	IssuedAt         int64    `json:"iat"`
	ExpiresAt        int64    `json:"exp"`
	ID               string   `json:"jti"`
	Agent            *string  `json:"agt,omitempty"`
}

type Expected struct {
	Consumer     string
	Organization string
	Agent        *string
	Now          time.Time
	Tolerance    int64
}

func Verify(token string, keys Keys, expected Expected) (Claims, error) {
	if len(token) > 8192 || expected.Tolerance < 0 || expected.Tolerance > 30 {
		return Claims{}, ErrInvalid
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return Claims{}, ErrInvalid
	}
	headerJSON, headerErr := decodeSegment(parts[0])
	claimsJSON, claimsErr := decodeSegment(parts[1])
	signature, signatureErr := decodeSegment(parts[2])
	if headerErr != nil || claimsErr != nil || signatureErr != nil || len(signature) != ed25519.SignatureSize {
		return Claims{}, ErrInvalid
	}
	var header protectedHeader
	if serviceauth.DecodeObject(headerJSON, &header) != nil || header.Type != "antnest-cct+jwt" || header.Alg != "EdDSA" || !validKID(header.KID) {
		return Claims{}, ErrInvalid
	}
	key := keys[header.KID]
	if len(key) != ed25519.PublicKeySize {
		return Claims{}, ErrInvalid
	}
	var claims Claims
	var wire struct {
		*Claims
		IssuedAt  json.RawMessage `json:"iat"`
		ExpiresAt json.RawMessage `json:"exp"`
	}
	wire.Claims = &claims
	if serviceauth.DecodeObject(claimsJSON, &wire) != nil {
		return Claims{}, ErrInvalid
	}
	issuedAt, issuedErr := numericDate(wire.IssuedAt)
	expiresAt, expiresErr := numericDate(wire.ExpiresAt)
	claims.IssuedAt, claims.ExpiresAt = issuedAt, expiresAt
	if issuedErr != nil || expiresErr != nil || !validClaims(claimsJSON, claims) {
		return Claims{}, ErrInvalid
	}
	signed, err := jose.ParseSignedCompact(token, []jose.SignatureAlgorithm{jose.EdDSA})
	if err != nil {
		return Claims{}, ErrInvalid
	}
	if _, err := signed.Verify(key); err != nil {
		return Claims{}, ErrInvalid
	}
	now := expected.Now.Unix()
	if claims.ExpiresAt <= claims.IssuedAt || claims.ExpiresAt-claims.IssuedAt > 60 ||
		claims.IssuedAt > now+expected.Tolerance || now >= claims.ExpiresAt+expected.Tolerance ||
		!slices.Contains(claims.Audience, expected.Consumer) ||
		(expected.Organization != "" && claims.Organization != expected.Organization) ||
		!sameAgent(claims.Agent, expected.Agent) {
		return Claims{}, ErrInvalid
	}
	return claims, nil
}

func numericDate(raw json.RawMessage) (int64, error) {
	// JSON Schema integers are numeric values; 1.0 and 1e0 are integers too.
	if len(raw) == 0 || raw[0] != '-' && (raw[0] < '0' || raw[0] > '9') {
		return 0, ErrInvalid
	}
	value, err := strconv.ParseFloat(string(raw), 64)
	if err != nil || value < 0 || value > 9007199254740991 || math.Trunc(value) != value {
		return 0, ErrInvalid
	}
	return int64(value), nil
}

func validClaims(raw []byte, claims Claims) bool {
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil {
		return false
	}
	for _, name := range []string{"iss", "sub", "org", "mbr", "sys_role", "org_role", "sid", "aud", "iat", "exp", "jti"} {
		value := fields[name]
		if len(value) == 0 || strings.TrimSpace(string(value)) == "null" {
			return false
		}
	}
	if agent, present := fields["agt"]; present && strings.TrimSpace(string(agent)) == "null" {
		return false
	}
	if claims.Issuer != Issuer || (claims.SystemRole != "user" && claims.SystemRole != "admin") ||
		(claims.OrganizationRole != "member" && claims.OrganizationRole != "admin") ||
		claims.IssuedAt < 0 || claims.ExpiresAt < 0 || claims.IssuedAt > 9007199254740991 || claims.ExpiresAt > 9007199254740991 {
		return false
	}
	for _, value := range []string{claims.Subject, claims.Organization, claims.Membership, claims.Session, claims.ID} {
		if !validID(value) {
			return false
		}
	}
	if claims.Agent != nil && !validID(*claims.Agent) {
		return false
	}
	consumers := []string{"identity-service", "admin-console", "agent-ui", "agent-acp-service", "agent-controller", "skill-registry"}
	if len(claims.Audience) < 1 || len(claims.Audience) > 5 {
		return false
	}
	seen := make(map[string]bool)
	for _, consumer := range claims.Audience {
		if seen[consumer] || !slices.Contains(consumers, consumer) {
			return false
		}
		seen[consumer] = true
	}
	return true
}

func validKID(value string) bool {
	if len(value) == 0 || len(value) > 128 {
		return false
	}
	for _, character := range value {
		if character < '!' || character > '~' {
			return false
		}
	}
	return true
}

func validID(value string) bool {
	if !utf8.ValidString(value) || utf8.RuneCountInString(value) < 1 || utf8.RuneCountInString(value) > 200 {
		return false
	}
	for _, character := range value {
		// Match the shared ECMAScript JSON-Schema whitespace class exactly.
		if character <= 32 || character == 127 || character == 0xa0 || character == 0x1680 ||
			(character >= 0x2000 && character <= 0x200a) || character == 0x2028 || character == 0x2029 ||
			character == 0x202f || character == 0x205f || character == 0x3000 || character == 0xfeff {
			return false
		}
	}
	return true
}

func decodeSegment(value string) ([]byte, error) {
	if value == "" {
		return nil, ErrInvalid
	}
	for _, character := range value {
		if (character < 'A' || character > 'Z') && (character < 'a' || character > 'z') && (character < '0' || character > '9') && character != '-' && character != '_' {
			return nil, ErrInvalid
		}
	}
	decoded, err := base64.RawURLEncoding.Strict().DecodeString(value)
	if err != nil || base64.RawURLEncoding.EncodeToString(decoded) != value {
		return nil, ErrInvalid
	}
	return decoded, nil
}

func sameAgent(actual, expected *string) bool {
	return actual == nil && expected == nil || actual != nil && expected != nil && *actual == *expected
}
