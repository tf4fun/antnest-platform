package identity

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
)

const CallerContextHeader = "Antnest-Caller-Context"

type resolutionKey struct{}
type principalKey struct{}
type resolution struct {
	Profile string
	Agent   string
}

// WithResolution selects a server-owned issuer profile and actual route scope.
func WithResolution(ctx context.Context, profile, agent string) context.Context {
	return context.WithValue(ctx, resolutionKey{}, resolution{profile, agent})
}

// ResolutionScope is read by the issuer client and deterministic service doubles.
func ResolutionScope(ctx context.Context) (string, string) {
	selection, _ := ctx.Value(resolutionKey{}).(resolution)
	return selection.Profile, selection.Agent
}

func WithPrincipal(ctx context.Context, principal Principal) context.Context {
	return context.WithValue(ctx, principalKey{}, principal)
}

func ForwardCallerContext(ctx context.Context, header http.Header) {
	header.Del(CallerContextHeader)
	if principal, ok := ctx.Value(principalKey{}).(Principal); ok && principal.CallerContext != "" {
		header.Set(CallerContextHeader, principal.CallerContext)
	}
}

// issuerContextExpiration checks framing of a trusted issuer response. This is
// not signature verification: consuming services authenticate the JWS themselves.
// Gateway neither re-signs the context nor takes authority from browser tokens.
func issuerContextExpiration(token string) (time.Time, error) {
	parts := strings.Split(token, ".")
	if len(token) > 8192 || len(parts) != 3 {
		return time.Time{}, fmt.Errorf("identity returned invalid caller context")
	}
	var payload []byte
	for index, part := range parts {
		decoded, err := base64.RawURLEncoding.Strict().DecodeString(part)
		if err != nil || part == "" || base64.RawURLEncoding.EncodeToString(decoded) != part || index == 2 && len(decoded) != 64 {
			return time.Time{}, fmt.Errorf("identity returned invalid caller context")
		}
		if index == 1 {
			payload = decoded
		}
	}
	var claims map[string]json.RawMessage
	if serviceauth.DecodeObject(payload, &claims) != nil {
		return time.Time{}, fmt.Errorf("identity returned invalid caller context")
	}
	// The issuer emits integer seconds. Accept JSON numeric integer spellings.
	expires, expErr := issuerDate(claims["exp"])
	issued, iatErr := issuerDate(claims["iat"])
	if expErr != nil || iatErr != nil || issued < 0 || expires > 9007199254740991 ||
		float64(int64(expires)) != expires || float64(int64(issued)) != issued || expires <= issued || expires-issued > 60 {
		return time.Time{}, fmt.Errorf("identity returned invalid caller context")
	}
	return time.Unix(int64(expires), 0), nil
}

func issuerDate(raw json.RawMessage) (float64, error) {
	if len(raw) == 0 || raw[0] != '-' && (raw[0] < '0' || raw[0] > '9') {
		return 0, fmt.Errorf("numeric issuer date required")
	}
	return strconv.ParseFloat(string(raw), 64)
}
