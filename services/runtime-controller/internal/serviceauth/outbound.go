package serviceauth

import (
	"crypto/tls"
	"fmt"
	"net/http"
	"net/url"
	"path/filepath"
	"slices"
	"strings"
)

type dependency struct {
	service   string
	origin    string
	transport *http.Transport
}

// Clients authenticates only configured, server-owned dependency origins.
// It never retains a raw token between requests.
type Clients struct {
	Config   Config
	mode     string
	tokenDir string
	byOrigin map[string]*dependency
	byName   map[string]*dependency
}

func LoadOutbound(lookup LookupEnv, endpoints map[string]string) (*Clients, error) {
	config, err := LoadConfig("runtime-controller", lookup)
	if err != nil {
		return nil, err
	}
	mode, insecure, err := loadMode(lookup)
	if err != nil {
		return nil, err
	}
	dir, _ := lookup("ANTNEST_SERVICE_AUTH_TOKEN_DIR")
	if mode == "token" && len(endpoints) > 0 && dir == "" {
		return nil, fmt.Errorf("ANTNEST_SERVICE_AUTH_TOKEN_DIR is required")
	}
	result := &Clients{Config: config, mode: mode, tokenDir: dir,
		byOrigin: make(map[string]*dependency), byName: make(map[string]*dependency)}
	for service, raw := range endpoints {
		target, err := url.Parse(raw)
		if !slices.Contains(Services, service) || service == "runtime-controller" || err != nil ||
			target.Host == "" || target.User != nil || target.Opaque != "" ||
			target.RawQuery != "" || target.Fragment != "" || target.ForceQuery ||
			(target.Scheme != "https" && (target.Scheme != "http" || !insecure)) {
			return nil, fmt.Errorf("invalid authenticated dependency URL for %s", service)
		}
		origin := strings.ToLower(target.Scheme + "://" + target.Host)
		if result.byOrigin[origin] != nil {
			return nil, fmt.Errorf("dependency origins must identify exactly one service")
		}
		transport := http.DefaultTransport.(*http.Transport).Clone()
		transport.Proxy = nil
		if target.Scheme == "https" {
			if config.ClientTLS == nil {
				return nil, fmt.Errorf("HTTPS dependency requires complete trusted TLS configuration")
			}
			transport.TLSClientConfig = config.ClientTLS.Clone()
			transport.TLSClientConfig.ServerName = target.Hostname()
			transport.TLSClientConfig.VerifyConnection = func(state tls.ConnectionState) error {
				if len(state.VerifiedChains) == 0 || len(state.PeerCertificates) == 0 || !certificateIdentity(state.PeerCertificates[0], service) {
					return fmt.Errorf("dependency TLS service identity is invalid")
				}
				return nil
			}
		}
		peer := &dependency{service: service, origin: origin, transport: transport}
		result.byOrigin[origin], result.byName[service] = peer, peer
		if mode == "token" {
			if _, err := result.token(service); err != nil {
				return nil, err
			}
		}
	}
	return result, nil
}

func (c *Clients) HTTPClient() *http.Client {
	return &http.Client{Transport: c, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

func (c *Clients) RoundTrip(original *http.Request) (*http.Response, error) {
	if original.URL == nil || original.URL.User != nil || original.URL.Opaque != "" {
		return nil, fmt.Errorf("unconfigured service origin")
	}
	peer := c.byOrigin[strings.ToLower(original.URL.Scheme+"://"+original.URL.Host)]
	if peer == nil || original.Host != "" && !strings.EqualFold(original.Host, original.URL.Host) {
		return nil, fmt.Errorf("unconfigured service origin")
	}
	request := original.Clone(original.Context())
	for name := range request.Header {
		if strings.HasPrefix(strings.ToLower(name), "x-antnest-") || strings.EqualFold(name, "Cookie") || strings.EqualFold(name, "Authorization") {
			delete(request.Header, name)
		}
	}
	if err := c.authenticate(peer.service, request.Header); err != nil {
		return nil, err
	}
	return peer.transport.RoundTrip(request)
}

func (c *Clients) authenticate(service string, headers http.Header) error {
	for name := range headers {
		if strings.EqualFold(name, Header) {
			delete(headers, name)
		}
	}
	if c.mode == "token" {
		token, err := c.token(service)
		if err != nil {
			return err
		}
		headers.Set(Header, "Bearer "+token)
	}
	return nil
}

func (c *Clients) token(service string) (string, error) {
	raw, err := ReadFile(filepath.Join(c.tokenDir, service), 86)
	if err != nil || !ValidToken(raw) {
		return "", fmt.Errorf("service credential unavailable for %s", service)
	}
	return string(raw), nil
}

func (c *Clients) CloseIdleConnections() {
	for _, peer := range c.byName {
		peer.transport.CloseIdleConnections()
	}
}
