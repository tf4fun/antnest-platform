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
	env := outboundEnvironment(t, "agent-acp-service", token)
	clients, err := LoadOutbound("edge-gateway", GatewayHeaders, lookupEnvironment(env), map[string]string{"agent-acp-service": upstream.URL})
	if err != nil {
		t.Fatal(err)
	}
	defer clients.CloseIdleConnections()
	for _, socket := range []bool{false, true} {
		req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, upstream.URL+"/v1/acp", nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Antnest-Caller-Context", "verified-context")
		var response *http.Response
		if socket {
			transport, socketErr := clients.SocketConfig("agent-acp-service", req.Header)
			if socketErr != nil {
				t.Fatal(socketErr)
			}
			response, err = transport.RoundTrip(req)
		} else {
			response, err = clients.HTTPClient().Do(req)
		}
		if err != nil {
			t.Fatal(err)
		}
		_ = response.Body.Close()
		if response.StatusCode != http.StatusNoContent || proxied.Load() != 0 {
			t.Fatal("private service authority reached an inherited proxy")
		}
	}
	if reached.Load() != 2 {
		t.Fatal("HTTP and socket transports did not reach the configured peer")
	}
}
