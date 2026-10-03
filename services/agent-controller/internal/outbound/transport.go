package outbound

import (
	"context"
	"crypto/tls"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

type socketKey struct{}
type checkedSocket struct {
	port      string
	addresses []net.IP
}

type Transport struct {
	policy *Policy
	base   *http.Transport
	dial   func(context.Context, string, string) (net.Conn, error)
}

func NewTransport(policy *Policy) *Transport {
	transport := &Transport{
		policy: policy,
		dial:   (&net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
	}
	transport.base = &http.Transport{
		// A separate transport intentionally has no environment proxy, workload
		// credentials, redirect handling or unchecked hostname dial.
		Proxy: nil, DialContext: transport.dialChecked,
		TLSClientConfig:   &tls.Config{MinVersion: tls.VersionTLS12},
		ForceAttemptHTTP2: true, MaxIdleConns: 100, MaxIdleConnsPerHost: 4,
		IdleConnTimeout: 90 * time.Second, TLSHandshakeTimeout: 10 * time.Second,
		ExpectContinueTimeout: time.Second,
	}
	return transport
}

func (transport *Transport) RoundTrip(original *http.Request) (*http.Response, error) {
	if original == nil || original.URL == nil || original.Host != "" && original.Host != original.URL.Host {
		return nil, ports.ErrProviderEndpointForbidden
	}
	endpoint, addresses, err := transport.policy.resolve(original.Context(), original.URL.String())
	if err != nil {
		return nil, err
	}
	port := endpoint.Port()
	if port == "" {
		port = "443"
		if endpoint.Scheme == "http" {
			port = "80"
		}
	}
	socket := checkedSocket{port: port, addresses: make([]net.IP, len(addresses))}
	for i, address := range addresses {
		socket.addresses[i] = net.IP(address.AsSlice())
	}
	request := original.Clone(context.WithValue(original.Context(), socketKey{}, socket))
	for name := range request.Header {
		if strings.EqualFold(name, "Service-Authorization") || strings.EqualFold(name, "Caller-Context") ||
			strings.EqualFold(name, "Cookie") || strings.EqualFold(name, "Baggage") ||
			strings.HasPrefix(strings.ToLower(name), "x-antnest-") || strings.HasPrefix(strings.ToLower(name), "antnest-") {
			delete(request.Header, name)
		}
	}
	response, err := transport.base.RoundTrip(request)
	if err != nil {
		return nil, ports.ErrProviderDiscoveryFailed
	}
	return response, nil
}

func (transport *Transport) dialChecked(ctx context.Context, network, address string) (net.Conn, error) {
	socket, ok := ctx.Value(socketKey{}).(checkedSocket)
	_, port, err := net.SplitHostPort(address)
	if !ok || err != nil || port != socket.port || len(socket.addresses) == 0 {
		return nil, ports.ErrProviderEndpointForbidden
	}
	for _, ip := range socket.addresses {
		if ctx.Err() != nil {
			return nil, ports.ErrProviderDiscoveryFailed
		}
		connection, err := transport.dial(ctx, network, net.JoinHostPort(ip.String(), port))
		if err == nil {
			return connection, nil
		}
	}
	return nil, ports.ErrProviderDiscoveryFailed
}

func (transport *Transport) CloseIdleConnections() { transport.base.CloseIdleConnections() }
