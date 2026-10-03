package rpc

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/callercontext"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/identityid"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/serviceauth"
)

// Public synthetic test tokens. Real deployments generate random credentials.
const consoleTestToken = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
const gatewayTestToken = "AQECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
const controllerTestToken = "AgECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"

type rpcSessionStub struct {
	session callercontext.Session
	err     error
}

func (s *rpcSessionStub) ResolveTokenSession(context.Context, string, time.Time) (callercontext.Session, error) {
	return s.session, s.err
}
func (s *rpcSessionStub) ResolveSession(context.Context, string, time.Time) (callercontext.Session, error) {
	return s.session, s.err
}

func authenticationDependencies(t *testing.T, deps Dependencies) (Dependencies, *rpcSessionStub) {
	t.Helper()
	hashes := make(map[string][]string)
	for caller, token := range map[string]string{"admin-console": consoleTestToken, "edge-gateway": gatewayTestToken, "agent-controller": controllerTestToken} {
		hashes[caller] = []string{fmt.Sprintf("sha256:%x", sha256.Sum256([]byte(token)))}
	}
	raw, err := json.Marshal(hashes)
	if err != nil {
		t.Fatal(err)
	}
	receiver, err := serviceauth.ParseReceiver("identity-service", raw, false)
	if err != nil {
		t.Fatal(err)
	}
	pub, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	sessions := &rpcSessionStub{session: callercontext.Session{ID: "session-1", ExpiresAt: time.Now().Add(time.Hour), Principal: domain.Principal{UserID: "admin", OrganizationID: "org-1", MembershipID: "membership-1", Active: true, SystemRole: domain.SystemRoleAdmin, OrganizationRole: domain.OrganizationRoleAdmin}}}
	authority, err := callercontext.NewAuthority(callercontext.Config{KID: "test", PrivateKey: private, Keys: callercontext.Keys{"test": pub}, Repository: sessions, Now: time.Now, NewID: func() string { return identityid.MustNew("authtoken") }})
	if err != nil {
		t.Fatal(err)
	}
	deps.Authentication, deps.CallerContext = receiver, authority
	return deps, sessions
}

// Existing business-unit tests run with an explicitly authenticated precondition.
// Security tests use NewHandler directly and never infer credentials from bodies.
func authenticatedBusinessHandler(t *testing.T, deps Dependencies) http.Handler {
	t.Helper()
	deps, sessions := authenticationDependencies(t, deps)
	handler, err := NewHandler(deps)
	if err != nil {
		t.Fatal(err)
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatal(err)
		}
		r.Body = io.NopCloser(bytes.NewReader(raw))
		var fields map[string]json.RawMessage
		_ = json.Unmarshal(raw, &fields)
		sessions.session.Principal.UserID, sessions.session.Principal.OrganizationID = "admin", "org-1"
		for name, dest := range map[string]*string{"actor_principal_id": &sessions.session.Principal.UserID, "organization_id": &sessions.session.Principal.OrganizationID} {
			var value string
			if json.Unmarshal(fields[name], &value) == nil && domain.ValidID(value) {
				*dest = value
			}
		}
		caller := routeCallers[r.URL.Path]
		token := gatewayTestToken
		if len(caller) > 0 && caller[0] == "admin-console" {
			token = consoleTestToken
			_, cct, issueErr := deps.CallerContext.Issue(r.Context(), "test-user-access-token", "console", "")
			if issueErr != nil {
				t.Fatal(issueErr)
			}
			r.Header.Set(callercontext.Header, cct)
		} else if len(caller) > 0 && caller[0] == "agent-controller" {
			token = controllerTestToken
		}
		r.Header.Set(serviceauth.Header, "Bearer "+token)
		r.Header.Set("Content-Type", "application/json")
		if stub, ok := deps.LocalAuth.(*rpcServicesStub); ok && r.URL.Path == ContractRoutes["resolve_access_token"] {
			sessions.err = stub.resolveErr
		}
		handler.ServeHTTP(w, r)
	})
}
