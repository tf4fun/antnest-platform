package serviceauth

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRegistryDependencyClientsDoNotForwardUserOrPeerAuthority(t *testing.T) {
	peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		for _, name := range []string{"Authorization", "Cookie", "Antnest-Caller-Context", "X-Antnest-Principal-ID"} {
			if r.Header.Get(name) != "" {
				t.Errorf("forwarded unrelated authority: %s", name)
			}
		}
		if len(r.Header.Values(Header)) != 1 {
			t.Error("missing own immediate-hop authority")
		}
		w.WriteHeader(204)
	}))
	defer peer.Close()
	env := outboundEnvironment(t, "agent-acp-service", testToken(t))
	clients, err := LoadOutbound(lookupEnvironment(env), map[string]string{"agent-acp-service": peer.URL})
	if err != nil {
		t.Fatal(err)
	}
	defer clients.CloseIdleConnections()
	req, err := http.NewRequestWithContext(t.Context(), "POST", peer.URL+"/internal/skill-sources/inspect", nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"Authorization", "Cookie", "Antnest-Caller-Context", "X-Antnest-Principal-ID", Header} {
		req.Header.Set(name, "incoming-private-value")
	}
	response, err := clients.HTTPClient().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
}
