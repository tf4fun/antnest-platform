// Package serviceauth implements Controller's internal connection boundary.
// End-user caller context and business authorization remain separate checks.
package serviceauth

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net/http"
	"slices"
	"strings"
)

const Header = "Antnest-Service-Authorization"

var Services = []string{
	"identity-service", "edge-gateway", "admin-console", "agent-ui",
	"agent-controller", "agent-acp-service", "runtime-controller", "skill-registry",
	"runtime-egress", "antnest-runtime",
}

type Failure struct {
	Code      string
	Status    int
	Challenge string
}

func (f *Failure) Error() string { return f.Code }

func Unauthenticated() *Failure {
	return &Failure{Code: "service_unauthenticated", Status: http.StatusUnauthorized,
		Challenge: `Bearer realm="antnest-service"`}
}

type credential struct {
	caller string
	digest [sha256.Size]byte
}

type Receiver struct {
	mode        string
	credentials []credential
}

func ParseReceiver(service string, raw []byte, allowSelf bool) (*Receiver, error) {
	if !slices.Contains(Services, service) {
		return nil, fmt.Errorf("unknown receiver service identity")
	}
	var callers map[string][]string
	if err := DecodeObject(raw, &callers); err != nil {
		return nil, fmt.Errorf("invalid service authentication callers JSON")
	}
	result := &Receiver{mode: "token"}
	seen := make(map[string]bool)
	for caller, hashes := range callers {
		if !slices.Contains(Services, caller) || (!allowSelf && caller == service) || len(hashes) < 1 || len(hashes) > 2 {
			return nil, fmt.Errorf("invalid service authentication caller entry")
		}
		for _, hash := range hashes {
			if len(hash) != 71 || !strings.HasPrefix(hash, "sha256:") || seen[hash] {
				return nil, fmt.Errorf("invalid or duplicate service authentication hash")
			}
			for _, character := range hash[7:] {
				if (character < '0' || character > '9') && (character < 'a' || character > 'f') {
					return nil, fmt.Errorf("invalid service authentication hash encoding")
				}
			}
			decoded, err := hex.DecodeString(hash[7:])
			if err != nil {
				return nil, fmt.Errorf("invalid service authentication hash encoding")
			}
			entry := credential{caller: caller}
			copy(entry.digest[:], decoded)
			result.credentials = append(result.credentials, entry)
			seen[hash] = true
		}
	}
	return result, nil
}

func ValidToken(raw []byte) bool {
	if len(raw) < 43 || len(raw) > 86 {
		return false
	}
	for _, character := range raw {
		if (character < 'A' || character > 'Z') && (character < 'a' || character > 'z') &&
			(character < '0' || character > '9') && character != '-' && character != '_' {
			return false
		}
	}
	decoded, err := base64.RawURLEncoding.Strict().DecodeString(string(raw))
	return err == nil && len(decoded) >= 32 && len(decoded) <= 64 &&
		base64.RawURLEncoding.EncodeToString(decoded) == string(raw)
}

func (r *Receiver) Authorize(request *http.Request, allowed []string) (string, error) {
	if r == nil {
		return "", Unauthenticated()
	}
	var caller string
	if r.mode == "mtls" {
		caller = verifiedTLSCaller(request)
	} else {
		values := request.Header.Values(Header)
		if len(values) != 1 || len(values[0]) < 7 || !strings.EqualFold(values[0][:7], "Bearer ") ||
			!ValidToken([]byte(values[0][7:])) {
			return "", Unauthenticated()
		}
		digest := sha256.Sum256([]byte(values[0][7:]))
		matches := 0
		for _, entry := range r.credentials {
			match := subtle.ConstantTimeCompare(digest[:], entry.digest[:])
			matches += match
			if match == 1 {
				caller = entry.caller
			}
		}
		if matches != 1 {
			return "", Unauthenticated()
		}
	}
	if caller == "" {
		return "", Unauthenticated()
	}
	if !slices.Contains(allowed, caller) {
		return caller, &Failure{Code: "caller_not_allowed", Status: http.StatusForbidden}
	}
	return caller, nil
}

func verifiedTLSCaller(request *http.Request) string {
	if request.TLS == nil || len(request.TLS.VerifiedChains) == 0 || len(request.TLS.PeerCertificates) == 0 {
		return ""
	}
	leaf := request.TLS.PeerCertificates[0]
	if len(leaf.URIs) != 1 || len(request.TLS.VerifiedChains[0]) == 0 ||
		!leaf.Equal(request.TLS.VerifiedChains[0][0]) {
		return ""
	}
	for _, service := range Services {
		if leaf.URIs[0].String() == "antnest://service/"+service {
			return service
		}
	}
	return ""
}
