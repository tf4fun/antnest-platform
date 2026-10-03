package callercontext

import (
	"context"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/tf4fun/antnest-platform/services/admin-console/internal/serviceauth"
)

type Verifier struct {
	endpoint           *url.URL
	client             *http.Client
	timeout            time.Duration
	mu                 sync.Mutex
	keys               Keys
	expiresAt          time.Time
	lastUnknownRefresh time.Time
}

func NewVerifier(rawIdentityURL string, client *http.Client, timeout time.Duration) (*Verifier, error) {
	base, err := url.Parse(rawIdentityURL)
	if err != nil || base.Host == "" || base.User != nil || (base.Scheme != "http" && base.Scheme != "https") || base.RawQuery != "" || base.Fragment != "" || client == nil || timeout <= 0 {
		return nil, ErrDependency
	}
	copyClient := *client
	copyClient.Jar = nil
	copyClient.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &Verifier{endpoint: base.ResolveReference(&url.URL{Path: "/rpc/identity/jwks"}), client: &copyClient, timeout: timeout}, nil
}

func (v *Verifier) Verify(ctx context.Context, token string, expected Expected) (Claims, error) {
	kid, err := tokenKID(token)
	if err != nil {
		return Claims{}, err
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	if ctx.Err() != nil {
		return Claims{}, ErrDependency
	}
	now := time.Now()
	if !now.Before(v.expiresAt) {
		if err := v.refresh(ctx); err != nil {
			return Claims{}, err
		}
	} else if v.keys[kid] == nil && now.Sub(v.lastUnknownRefresh) >= 5*time.Second {
		v.lastUnknownRefresh = now
		if err := v.refresh(ctx); err != nil {
			return Claims{}, err
		}
	}
	expected.Now = time.Now()
	return Verify(token, v.keys, expected)
}

func (v *Verifier) refresh(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, v.timeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, v.endpoint.String(), nil)
	if err != nil {
		return ErrDependency
	}
	request.Header.Set("Accept", "application/json")
	response, err := v.client.Do(request)
	if err != nil {
		return ErrDependency
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		return ErrDependency
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, 16385))
	if err != nil || len(raw) > 16384 {
		return ErrDependency
	}
	keys, err := ParseKeys(raw)
	if err != nil {
		return ErrDependency
	}
	v.keys, v.expiresAt = keys, time.Now().Add(30*time.Second)
	return nil
}

func tokenKID(token string) (string, error) {
	parts := strings.Split(token, ".")
	if len(token) > 8192 || len(parts) != 3 {
		return "", ErrInvalid
	}
	raw, err := decodeSegment(parts[0])
	if err != nil {
		return "", ErrInvalid
	}
	var header protectedHeader
	if serviceauth.DecodeObject(raw, &header) != nil || header.Type != "antnest-cct+jwt" || header.Alg != "EdDSA" || !validKID(header.KID) {
		return "", ErrInvalid
	}
	return header.KID, nil
}

type contextKey struct{}

func WithToken(ctx context.Context, token string) context.Context {
	return context.WithValue(ctx, contextKey{}, token)
}
func Forward(ctx context.Context, header http.Header) bool {
	header.Del(Header)
	if token, ok := ctx.Value(contextKey{}).(string); ok && token != "" {
		header.Set(Header, token)
		return true
	}
	return false
}
