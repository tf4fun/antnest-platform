package e2e

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/callercontext"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/identityid"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/repository"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/rpc"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/serviceauth"
)

type identityAuthenticatedTransport struct {
	base          http.RoundTripper
	host          string
	tokens        map[string]string
	callerContext *string
}

func (t *identityAuthenticatedTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.URL.Host != t.host {
		return t.base.RoundTrip(r)
	}
	request := r.Clone(r.Context())
	request.Header = r.Header.Clone()
	caller := "admin-console"
	switch r.URL.Path {
	case rpc.ContractRoutes["resolve_owner_authorization"], rpc.ContractRoutes["resolve_principal"], rpc.ContractRoutes["list_principal_revocations"]:
		caller = "agent-controller"
	case rpc.ContractRoutes["local_login"], rpc.ContractRoutes["resolve_access_token"], rpc.ContractRoutes["revoke_access_token"], rpc.ContractRoutes["list_login_methods"], rpc.ContractRoutes["start_oidc_login"], "/protocol/oidc/callback":
		caller = "edge-gateway"
	default:
		if len(r.URL.Path) >= 9 && r.URL.Path[:9] == "/scim/v2/" {
			caller = "edge-gateway"
		}
	}
	request.Header.Set(serviceauth.Header, "Bearer "+t.tokens[caller])
	if caller == "admin-console" {
		request.Header.Set(callercontext.Header, *t.callerContext)
	}
	return t.base.RoundTrip(request)
}

func identityTestAuthentication(t *testing.T, store *repository.Store) (*serviceauth.Receiver, *callercontext.Authority, map[string]string) {
	t.Helper()
	tokens := make(map[string]string)
	hashes := make(map[string][]string)
	for _, caller := range []string{"edge-gateway", "admin-console", "agent-controller"} {
		entropy := make([]byte, 32)
		if _, err := rand.Read(entropy); err != nil {
			t.Fatal(err)
		}
		token := base64.RawURLEncoding.EncodeToString(entropy)
		tokens[caller] = token
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
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	authority, err := callercontext.NewAuthority(callercontext.Config{KID: "integration", PrivateKey: private, Keys: callercontext.Keys{"integration": public}, Repository: store.LocalAuth(), Now: time.Now, NewID: func() string { return identityid.MustNew("authtoken") }})
	if err != nil {
		t.Fatal(err)
	}
	return receiver, authority, tokens
}

func authenticatedIdentityClient(client *http.Client, serviceURL string, tokens map[string]string, cct *string) {
	target, _ := url.Parse(serviceURL)
	base := client.Transport
	if base == nil {
		base = http.DefaultTransport
	}
	client.Transport = &identityAuthenticatedTransport{base: base, host: target.Host, tokens: tokens, callerContext: cct}
}
