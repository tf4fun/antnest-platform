package main

import (
	"net"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func purposeHealthLookup(address string) func(string) (string, bool) {
	return func(name string) (string, bool) {
		switch name {
		case "ANTNEST_ADMIN_CONSOLE_LISTEN":
			return address, true
		case "ANTNEST_SERVICE_AUTH_MODE":
			return "token", true
		case "ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT":
			return "true", true
		default:
			return "", false
		}
	}
}

func TestHealthProbeUsesConfiguredHost(t *testing.T) {
	// Darwin cannot bind an unconfigured 127.0.0.2 alias. Prefer an assigned
	// non-loopback IPv4 address without modifying the host's interfaces. The
	// Docker case always verifies a non-loopback address, including proxy bypass.
	ipv4 := "127.0.0.1"
	addresses, err := net.InterfaceAddrs()
	if err != nil {
		t.Fatal(err)
	}
	for _, address := range addresses {
		if network, ok := address.(*net.IPNet); ok && network.IP.To4() != nil && !network.IP.IsLoopback() && network.IP.IsGlobalUnicast() {
			ipv4 = network.IP.String()
			break
		}
	}
	for _, host := range []string{ipv4, "::1"} {
		t.Run(host, func(t *testing.T) {
			listener, err := net.Listen("tcp", net.JoinHostPort(host, "0"))
			if err != nil {
				t.Fatal(err)
			}
			var requests atomic.Int32
			server := &http.Server{Handler: http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
				if request.URL.Path != "/status" {
					http.NotFound(response, request)
					return
				}
				requests.Add(1)
				response.WriteHeader(http.StatusOK)
			})}
			done := make(chan struct{})
			go func() { _ = server.Serve(listener); close(done) }()
			t.Cleanup(func() { _ = server.Close(); <-done })
			if err := checkHealth(purposeHealthLookup(listener.Addr().String())); err != nil {
				t.Fatalf("healthcheck must use the configured host: %v", err)
			}
			if requests.Load() != 1 {
				t.Fatalf("configured listener received %d probes", requests.Load())
			}
		})
	}
}

func TestHealthProbeRejectsRedirect(t *testing.T) {
	var redirects atomic.Int32
	other := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		redirects.Add(1)
		response.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(other.Close)
	local := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		http.Redirect(response, request, other.URL+"/status", http.StatusFound)
	}))
	t.Cleanup(local.Close)
	if err := checkHealth(purposeHealthLookup(local.Listener.Addr().String())); err == nil {
		t.Fatal("healthcheck must reject a redirect to another endpoint")
	}
	if redirects.Load() != 0 {
		t.Fatalf("redirect target received %d probes", redirects.Load())
	}
}
