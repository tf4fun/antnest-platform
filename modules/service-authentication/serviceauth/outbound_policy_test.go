package serviceauth

import (
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
)

func TestOutboundAuthorityPoliciesApplyToHTTPAndSocket(t *testing.T) {
	for _, profile := range []struct {
		caller         string
		policy         HeaderPolicy
		context, hints bool
	}{
		{"edge-gateway", GatewayHeaders, true, true},
		{"admin-console", CallerContextHeaders, true, false},
		{"agent-controller", CallerContextHeaders, true, false},
		{"runtime-controller", CallerContextHeaders, true, false},
		{"skill-registry", WorkloadOnlyHeaders, false, false},
	} {
		t.Run(profile.caller, func(t *testing.T) {
			token := testToken(t)
			peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				for _, name := range []string{"Authorization", "X-Antnest-Principal-ID", "X-Antnest-Future-Hint"} {
					if (r.Header.Get(name) != "") != profile.hints {
						t.Errorf("incorrect forwarding policy for %s", name)
					}
				}
				if (r.Header.Get("Antnest-Caller-Context") != "") != profile.context {
					t.Error("incorrect caller context policy")
				}
				if r.Header.Get("Cookie") != "" {
					t.Error("forwarded browser cookie")
				}
				if values := r.Header.Values(Header); len(values) != 1 || values[0] != "Bearer "+token {
					t.Error("did not replace peer credential")
				}
				w.WriteHeader(http.StatusNoContent)
			}))
			defer peer.Close()
			env := outboundEnvironment(t, "identity-service", token)
			clients, err := LoadOutbound(profile.caller, profile.policy, lookupEnvironment(env), map[string]string{"identity-service": peer.URL})
			if err != nil {
				t.Fatal(err)
			}
			defer clients.CloseIdleConnections()
			for _, socket := range []bool{false, true} {
				req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, peer.URL+"/rpc/identity/jwks", nil)
				if err != nil {
					t.Fatal(err)
				}
				for _, name := range []string{"Authorization", "aUthorization", "Cookie", "coOkie", "X-Antnest-Principal-ID", "x-antnest-future-hint", Header, "antnest-service-authorization", "antnest-caller-context"} {
					req.Header[name] = []string{"verified-adapter-value"}
				}
				original := req.Header.Clone()
				var response *http.Response
				if socket {
					transport, socketErr := clients.SocketConfig("identity-service", req.Header)
					if socketErr != nil {
						t.Fatal(socketErr)
					}
					response, err = transport.RoundTrip(req)
				} else {
					response, err = clients.HTTPClient().Do(req)
					if !reflect.DeepEqual(req.Header, original) {
						t.Error("mutated original HTTP headers")
					}
				}
				if err != nil {
					t.Fatal(err)
				}
				_ = response.Body.Close()
			}
		})
	}
}

func TestOutboundRejectsUnknownOrUnauthorizedHeaderPolicy(t *testing.T) {
	env := outboundEnvironment(t, "identity-service", testToken(t))
	for _, profile := range []struct {
		caller string
		policy HeaderPolicy
	}{
		{"admin-console", GatewayHeaders}, {"edge-gateway", HeaderPolicy(255)},
	} {
		clients, err := LoadOutbound(profile.caller, profile.policy, lookupEnvironment(env), map[string]string{"identity-service": "http://identity.internal"})
		if err == nil {
			clients.CloseIdleConnections()
			t.Error("accepted unauthorized authority policy")
		}
	}
}
