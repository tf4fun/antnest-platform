package serviceauth

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync/atomic"
	"testing"
)

func TestOutboundPrivateCallsIgnoreDefaultTransportProxy(t *testing.T) {
	var proxied, reached atomic.Int32
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		proxied.Add(1)
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer proxy.Close()
	token := testToken(t)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get(Header) != "Bearer "+token || r.Header.Get("Antnest-Caller-Context") != "verified-context" {
			t.Error("direct call lost its workload or caller authority")
		}
		reached.Add(1)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()
	original := http.DefaultTransport
	base := original.(*http.Transport).Clone()
	proxyURL, err := url.Parse(proxy.URL)
	if err != nil {
		t.Fatal(err)
	}
	base.Proxy = http.ProxyURL(proxyURL)
	http.DefaultTransport = base
	defer func() { http.DefaultTransport = original; base.CloseIdleConnections() }()
	env := outboundEnvironment(t, "identity-service", token)
	clients, err := LoadOutbound(lookupEnvironment(env), map[string]string{"identity-service": upstream.URL})
	if err != nil {
		t.Fatal(err)
	}
	defer clients.CloseIdleConnections()
	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, upstream.URL+"/rpc/identity/jwks", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Antnest-Caller-Context", "verified-context")
	response, err := clients.HTTPClient().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusNoContent || proxied.Load() != 0 || reached.Load() != 1 {
		t.Fatal("private service authority reached an inherited proxy")
	}
}
