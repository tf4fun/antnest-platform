package outbound

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

type resolverFunc func(context.Context, string, string) ([]netip.Addr, error)

func (f resolverFunc) LookupNetIP(ctx context.Context, network, host string) ([]netip.Addr, error) {
	return f(ctx, network, host)
}

func TestSharedDestinationDecisions(t *testing.T) {
	var fixture struct {
		PolicyVersion int      `json:"policy_version"`
		Private       []string `json:"private_prefixes"`
		Denied        []string `json:"always_denied_prefixes"`
		Addresses     []struct {
			Name    string `json:"name"`
			Address string `json:"address"`
			Default bool   `json:"default_allowed"`
			OptIn   bool   `json:"private_opt_in_allowed"`
		} `json:"address_vectors"`
		URLs []struct {
			Name    string `json:"name"`
			URL     string `json:"url"`
			Allowed bool   `json:"syntax_allowed"`
		} `json:"url_vectors"`
		DNS []struct {
			Name    string   `json:"name"`
			Answers []string `json:"answers"`
			Default string   `json:"default_code"`
			OptIn   string   `json:"private_opt_in_code"`
		} `json:"dns_vectors"`
	}
	body, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "contracts", "platform", "provider-destination-fixtures.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(body, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.PolicyVersion != 1 {
		t.Fatal("unsupported destination fixture")
	}
	if strings.Join(fixture.Private, ",") != strings.Join(privateRanges, ",") || strings.Join(fixture.Denied, ",") != strings.Join(deniedRanges, ",") {
		t.Fatal("adapter ranges differ from shared contract")
	}
	for _, vector := range fixture.Addresses {
		t.Run("address/"+vector.Name, func(t *testing.T) {
			address, err := netip.ParseAddr(vector.Address)
			if err != nil {
				t.Fatal(err)
			}
			if NewPolicy(false).allowed(address) != vector.Default || NewPolicy(true).allowed(address) != vector.OptIn {
				t.Fatal("address decision differs")
			}
		})
	}
	for _, vector := range fixture.URLs {
		t.Run("url/"+vector.Name, func(t *testing.T) {
			_, err := parseEndpoint(vector.URL)
			if (err == nil) != vector.Allowed {
				t.Fatalf("syntax decision: %v", err)
			}
		})
	}
	for _, vector := range fixture.DNS {
		for _, optIn := range []bool{false, true} {
			t.Run("dns/"+vector.Name+map[bool]string{false: "/default", true: "/opt-in"}[optIn], func(t *testing.T) {
				policy := NewPolicy(optIn)
				policy.resolver = resolverFunc(func(context.Context, string, string) ([]netip.Addr, error) {
					if vector.Answers == nil {
						return nil, errors.New("synthetic DNS failure")
					}
					result := make([]netip.Addr, len(vector.Answers))
					for i, answer := range vector.Answers {
						result[i] = netip.MustParseAddr(answer)
					}
					return result, nil
				})
				err := policy.ValidateEndpoint(context.Background(), "https://provider.example/v1")
				code := "allowed"
				if errors.Is(err, ports.ErrProviderEndpointForbidden) {
					code = "provider_endpoint_forbidden"
				}
				if errors.Is(err, ports.ErrProviderEndpointUnavailable) {
					code = "provider_endpoint_unavailable"
				}
				expected := vector.Default
				if optIn {
					expected = vector.OptIn
				}
				if code != expected {
					t.Fatalf("DNS decision %s, want %s", code, expected)
				}
			})
		}
	}
}

func TestTransportPinsVerifiedAddressAndRevalidatesBeforeCredentials(t *testing.T) {
	const credential = "synthetic-provider-key"
	var lock sync.Mutex
	var hosts, authorizations []string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		lock.Lock()
		hosts = append(hosts, r.Host)
		authorizations = append(authorizations, r.Header.Get("Authorization"))
		lock.Unlock()
		if r.Header.Get("Antnest-Service-Authorization") != "" || r.Header.Get("Antnest-Caller-Context") != "" || r.Header.Get("Cookie") != "" || r.Header.Get("X-Antnest-Organization-Id") != "" {
			t.Error("internal authority reached Provider")
		}
		_, _ = io.WriteString(w, "ok")
	}))
	defer upstream.Close()
	policy := NewPolicy(false)
	lookups := 0
	policy.resolver = resolverFunc(func(context.Context, string, string) ([]netip.Addr, error) {
		lookups++
		if lookups == 1 {
			return []netip.Addr{netip.MustParseAddr("8.8.8.8")}, nil
		}
		return []netip.Addr{netip.MustParseAddr("127.0.0.1")}, nil
	})
	transport := NewTransport(policy)
	defer transport.CloseIdleConnections()
	dials := []string{}
	transport.dial = func(ctx context.Context, network, address string) (net.Conn, error) {
		dials = append(dials, address)
		return (&net.Dialer{}).DialContext(ctx, network, strings.TrimPrefix(upstream.URL, "http://"))
	}
	client := &http.Client{Transport: transport, Timeout: time.Second}
	for attempt := range 2 {
		request, err := http.NewRequestWithContext(context.Background(), http.MethodGet, "http://provider.example:8080/models", nil)
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Authorization", "Bearer "+credential)
		request.Header.Set("Antnest-Service-Authorization", "Bearer internal-workload")
		request.Header.Set("Antnest-Caller-Context", "internal-context")
		request.Header.Set("Cookie", "user-session")
		request.Header.Set("X-Antnest-Organization-Id", "org")
		response, err := client.Do(request)
		if attempt == 1 {
			if !errors.Is(err, ports.ErrProviderEndpointForbidden) {
				t.Fatalf("rebind was not rejected: %v", err)
			}
			continue
		}
		if err != nil {
			t.Fatal(err)
		}
		if _, err := io.Copy(io.Discard, response.Body); err != nil {
			t.Fatal(err)
		}
		if err := response.Body.Close(); err != nil {
			t.Fatal(err)
		}
	}
	lock.Lock()
	defer lock.Unlock()
	if lookups != 2 || len(dials) != 1 || dials[0] != "8.8.8.8:8080" || len(hosts) != 1 || hosts[0] != "provider.example:8080" || authorizations[0] != "Bearer "+credential {
		t.Fatal("checked socket, hostname or credential invariant failed")
	}
}

func TestTransportIgnoresProxyAndRejectsMixedAnswersWithoutDial(t *testing.T) {
	for _, proxy := range []string{"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"} {
		t.Setenv(proxy, "http://127.0.0.1:1")
	}
	policy := NewPolicy(false)
	policy.resolver = resolverFunc(func(context.Context, string, string) ([]netip.Addr, error) {
		return []netip.Addr{netip.MustParseAddr("8.8.8.8"), netip.MustParseAddr("::ffff:10.0.0.1")}, nil
	})
	transport := NewTransport(policy)
	defer transport.CloseIdleConnections()
	if transport.base.Proxy != nil {
		t.Fatal("Provider transport has an environment proxy")
	}
	transport.dial = func(context.Context, string, string) (net.Conn, error) {
		t.Fatal("mixed answers reached dial")
		return nil, nil
	}
	request, err := http.NewRequestWithContext(context.Background(), http.MethodGet, "https://provider.example/models", nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := transport.RoundTrip(request); !errors.Is(err, ports.ErrProviderEndpointForbidden) {
		t.Fatalf("mixed answer accepted: %v", err)
	}
}

func TestEndpointLookupUsesCallerDeadlineAndLiteralSkipsDNS(t *testing.T) {
	policy := NewPolicy(false)
	policy.resolver = resolverFunc(func(ctx context.Context, _, _ string) ([]netip.Addr, error) {
		<-ctx.Done()
		return nil, errors.New("sensitive provider.example DNS detail")
	})
	if err := policy.ValidateEndpoint(context.Background(), "https://8.8.8.8/models"); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	err := policy.ValidateEndpoint(ctx, "https://provider.example/models")
	if !errors.Is(err, ports.ErrProviderEndpointUnavailable) || strings.Contains(err.Error(), "provider.example") {
		t.Fatalf("unbounded lookup failure: %v", err)
	}
}

func TestPinnedHTTPSPreservesHostnameVerificationAndSNI(t *testing.T) {
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.TLS == nil || r.TLS.ServerName != "example.com" || r.Host != "example.com" {
			t.Error("TLS hostname or HTTP Host changed to an IP")
		}
		_, _ = io.WriteString(w, "ok")
	}))
	defer upstream.Close()
	policy := NewPolicy(false)
	policy.resolver = resolverFunc(func(context.Context, string, string) ([]netip.Addr, error) {
		return []netip.Addr{netip.MustParseAddr("8.8.8.8")}, nil
	})
	transport := NewTransport(policy)
	defer transport.CloseIdleConnections()
	roots := x509.NewCertPool()
	roots.AddCert(upstream.Certificate())
	transport.base.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: roots}
	transport.dial = func(ctx context.Context, network, address string) (net.Conn, error) {
		if address != "8.8.8.8:443" {
			t.Error("TLS dial did not use the verified literal")
		}
		return (&net.Dialer{}).DialContext(ctx, network, strings.TrimPrefix(upstream.URL, "https://"))
	}
	client := &http.Client{Transport: transport, Timeout: time.Second}
	request, err := http.NewRequestWithContext(t.Context(), http.MethodGet, "https://example.com/models", nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.Copy(io.Discard, response.Body); err != nil {
		t.Fatal(err)
	}
	if err := response.Body.Close(); err != nil {
		t.Fatal(err)
	}
	request, err = http.NewRequestWithContext(t.Context(), http.MethodGet, "https://wrong.example/models", nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.Do(request); err == nil {
		t.Fatal("hostname verification was bypassed")
	}
}
