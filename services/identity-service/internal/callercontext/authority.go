package callercontext

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"time"

	jose "github.com/go-jose/go-jose/v4"
	protocol "github.com/tf4fun/antnest-platform/modules/service-authentication/callercontext"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/credentials"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
)

// Protocol types are shared; issuance and live-session policy remain Identity-owned.
type Keys = protocol.Keys
type Claims = protocol.Claims

const Header = protocol.Header
const Issuer = protocol.Issuer

var ErrInvalid = domain.NewError("caller_context_invalid", "Caller context verification failed", false)
var ErrDependency = domain.NewError("identity_dependency_unavailable", "Identity authorization dependency is unavailable", true)

type Session struct {
	ID        string
	Principal domain.Principal
	ExpiresAt time.Time
}

type SessionRepository interface {
	ResolveTokenSession(context.Context, string, time.Time) (Session, error)
	ResolveSession(context.Context, string, time.Time) (Session, error)
}

type Config struct {
	KID        string
	PrivateKey ed25519.PrivateKey
	Keys       Keys
	Repository SessionRepository
	Now        func() time.Time
	NewID      func() string
}

type Authority struct {
	signer     jose.Signer
	keys       Keys
	repository SessionRepository
	now        func() time.Time
	newID      func() string
}

func NewAuthority(config Config) (*Authority, error) {
	if !protocol.ValidKID(config.KID) || len(config.PrivateKey) != ed25519.PrivateKeySize || config.Repository == nil || config.Now == nil || config.NewID == nil {
		return nil, fmt.Errorf("CCT authority requires valid signing material, session repository, clock and ID generator")
	}
	if !slices.Equal(config.Keys[config.KID], config.PrivateKey.Public().(ed25519.PublicKey)) || len(config.Keys) > 8 {
		return nil, fmt.Errorf("CCT signing key must match its public JWKS identity")
	}
	keys := make(Keys, len(config.Keys))
	for id, public := range config.Keys {
		if !protocol.ValidKID(id) || len(public) != ed25519.PublicKeySize {
			return nil, fmt.Errorf("CCT verification key set is invalid")
		}
		keys[id] = slices.Clone(public)
	}
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.EdDSA, Key: slices.Clone(config.PrivateKey)},
		(&jose.SignerOptions{}).WithType("antnest-cct+jwt").WithHeader("kid", config.KID))
	if err != nil {
		return nil, fmt.Errorf("CCT signer initialization failed")
	}
	return &Authority{signer: signer, keys: keys, repository: config.Repository, now: config.Now, newID: config.NewID}, nil
}

func (a *Authority) Issue(ctx context.Context, accessToken, profile, agent string) (domain.Principal, string, error) {
	audience := profileAudience(profile)
	if len(audience) == 0 || agent != "" && !protocol.ValidID(agent) {
		return domain.Principal{}, "", domain.InvalidArgument("Caller context profile or Agent scope is invalid")
	}
	if accessToken == "" {
		return domain.Principal{}, "", domain.ErrUnauthenticated
	}
	now := a.now().UTC()
	session, err := a.repository.ResolveTokenSession(ctx, credentials.HashToken(accessToken), now)
	if err != nil {
		if errors.Is(err, domain.ErrNotFound) || errors.Is(err, domain.ErrUnauthenticated) {
			return domain.Principal{}, "", domain.ErrUnauthenticated
		}
		return domain.Principal{}, "", ErrDependency
	}
	if !session.Principal.Active || !session.ExpiresAt.After(now) || !protocol.ValidID(session.ID) {
		return domain.Principal{}, "", domain.ErrUnauthenticated
	}
	principal := session.Principal
	expiry := min(now.Unix()+60, session.ExpiresAt.Unix())
	claims := Claims{Issuer: Issuer, Subject: principal.UserID, Organization: principal.OrganizationID,
		Membership: principal.MembershipID, SystemRole: string(principal.SystemRole), OrganizationRole: string(principal.OrganizationRole),
		Session: session.ID, Audience: audience, IssuedAt: now.Unix(), ExpiresAt: expiry, ID: a.newID()}
	if agent != "" {
		claims.Agent = &agent
	}
	if expiry <= claims.IssuedAt {
		return domain.Principal{}, "", domain.ErrUnauthenticated
	}
	raw, err := json.Marshal(claims)
	if err != nil || !protocol.ValidClaims(raw, claims) {
		return domain.Principal{}, "", ErrDependency
	}
	signed, err := a.signer.Sign(raw)
	if err != nil {
		return domain.Principal{}, "", ErrDependency
	}
	token, err := signed.CompactSerialize()
	if err != nil {
		return domain.Principal{}, "", ErrDependency
	}
	return principal, token, nil
}

func (a *Authority) VerifySession(ctx context.Context, token string) (Claims, error) {
	now := a.now().UTC()
	claims, err := protocol.Verify(token, a.keys, protocol.Expected{Consumer: "identity-service", Now: now, Tolerance: 30})
	if err != nil {
		return Claims{}, ErrInvalid
	}
	session, err := a.repository.ResolveSession(ctx, claims.Session, now)
	if err != nil {
		if errors.Is(err, domain.ErrNotFound) || errors.Is(err, domain.ErrUnauthenticated) {
			return Claims{}, ErrInvalid
		}
		return Claims{}, ErrDependency
	}
	principal := session.Principal
	if session.ID != claims.Session || !principal.Active || !session.ExpiresAt.After(now) ||
		principal.UserID != claims.Subject || principal.OrganizationID != claims.Organization || principal.MembershipID != claims.Membership ||
		string(principal.SystemRole) != claims.SystemRole || string(principal.OrganizationRole) != claims.OrganizationRole {
		return Claims{}, ErrInvalid
	}
	return claims, nil
}

func (a *Authority) PublicJWKS() any {
	ids := make([]string, 0, len(a.keys))
	for id := range a.keys {
		ids = append(ids, id)
	}
	slices.Sort(ids)
	result := protocol.PublicKeys{Keys: make([]protocol.PublicKey, 0, len(ids))}
	for _, id := range ids {
		result.Keys = append(result.Keys, protocol.PublicKey{KID: id, Kty: "OKP", Crv: "Ed25519", Use: "sig", Alg: "EdDSA", X: base64.RawURLEncoding.EncodeToString(a.keys[id])})
	}
	return result
}

func profileAudience(profile string) []string {
	switch profile {
	case "console":
		return []string{"admin-console", "identity-service", "agent-controller", "skill-registry", "agent-acp-service"}
	case "workspace":
		return []string{"agent-ui", "agent-acp-service", "agent-controller"}
	case "acp":
		return []string{"agent-acp-service"}
	default:
		return nil
	}
}
