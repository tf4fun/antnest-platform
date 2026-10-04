package serviceauth

import (
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func TestOutboundRemovesUnrelatedAuthorityAndPreservesCallerContext(t *testing.T) {
	token := testToken(t)
	peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		for name := range r.Header {
			if strings.HasPrefix(strings.ToLower(name), "x-antnest-") || strings.EqualFold(name, "Cookie") || strings.EqualFold(name, "Authorization") {
				t.Errorf("forwarded unrelated authority header: %s", name)
			}
		}
		if values := r.Header.Values(Header); len(values) != 1 || values[0] != "Bearer "+token {
			t.Error("did not replace the incoming peer authority")
		}
		if r.Header.Get("Antnest-Caller-Context") != "verified-context" {
			t.Error("lost the signed caller context")
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer peer.Close()
	env := outboundEnvironment(t, "identity-service", token)
	clients, err := LoadOutbound(lookupEnvironment(env), map[string]string{"identity-service": peer.URL})
	if err != nil {
		t.Fatal(err)
	}
	defer clients.CloseIdleConnections()
	req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, peer.URL+"/rpc/identity/list-users", nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"Authorization", "aUthorization", "Cookie", "coOkie", "X-Antnest-Principal-ID", "x-antnest-future-privilege", Header, "antnest-service-authorization"} {
		req.Header[name] = []string{"incoming-private-value"}
	}
	req.Header.Set("Antnest-Caller-Context", "verified-context")
	original := req.Header.Clone()
	response, err := clients.HTTPClient().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if !reflect.DeepEqual(req.Header, original) {
		t.Fatal("outbound authentication mutated the original request headers")
	}
}
