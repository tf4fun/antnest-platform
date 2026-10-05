package outbound

import (
	"context"
	"net"
	"net/netip"
	"net/url"
	"strconv"
	"strings"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

// Keep these lists identical to the versioned platform decision fixtures.
var privateRanges = []string{
	"10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16",
	"172.16.0.0/12", "192.168.0.0/16", "::1/128", "fc00::/7", "fe80::/10", "fec0::/10",
}

var deniedRanges = []string{
	"0.0.0.0/8", "192.0.0.0/24", "192.0.2.0/24", "192.88.99.0/24",
	"198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4",
	"::/128", "64:ff9b::/96", "64:ff9b:1::/48", "100::/64", "100:0:0:1::/64",
	"2001::/32", "2001:2::/48", "2001:10::/28", "2001:db8::/32", "2002::/16",
	"3fff::/20", "5f00::/16", "ff00::/8",
}

type resolver interface {
	LookupNetIP(context.Context, string, string) ([]netip.Addr, error)
}

type Policy struct {
	allowPrivate bool
	resolver     resolver
	private      []netip.Prefix
	denied       []netip.Prefix
}

func NewPolicy(allowPrivate bool) *Policy {
	policy := &Policy{allowPrivate: allowPrivate, resolver: net.DefaultResolver}
	for _, value := range privateRanges {
		policy.private = append(policy.private, netip.MustParsePrefix(value))
	}
	for _, value := range deniedRanges {
		policy.denied = append(policy.denied, netip.MustParsePrefix(value))
	}
	return policy
}

func parseEndpoint(raw string) (*url.URL, error) {
	endpoint, err := url.Parse(raw)
	if err != nil || endpoint == nil || raw == "" || strings.TrimSpace(raw) != raw ||
		(endpoint.Scheme != "https" && endpoint.Scheme != "http") || endpoint.Opaque != "" ||
		endpoint.Hostname() == "" || endpoint.User != nil || endpoint.RawQuery != "" || endpoint.ForceQuery ||
		strings.Contains(raw, "#") || strings.Contains(endpoint.Host, "%") || strings.HasSuffix(endpoint.Host, ":") {
		return nil, ports.ErrProviderEndpointForbidden
	}
	if port := endpoint.Port(); port != "" {
		value, err := strconv.Atoi(port)
		if err != nil || value < 1 || value > 65535 {
			return nil, ports.ErrProviderEndpointForbidden
		}
	}
	return endpoint, nil
}

func (policy *Policy) allowed(address netip.Addr) bool {
	if !address.IsValid() || address.Zone() != "" {
		return false
	}
	address = address.Unmap()
	for _, prefix := range policy.denied {
		if prefix.Contains(address) {
			return false
		}
	}
	if !policy.allowPrivate {
		for _, prefix := range policy.private {
			if prefix.Contains(address) {
				return false
			}
		}
	}
	return true
}

func (policy *Policy) resolve(ctx context.Context, raw string) (*url.URL, []netip.Addr, error) {
	endpoint, err := parseEndpoint(raw)
	if err != nil {
		return nil, nil, err
	}
	if policy == nil || policy.resolver == nil {
		return nil, nil, ports.ErrProviderEndpointUnavailable
	}
	var addresses []netip.Addr
	if literal, err := netip.ParseAddr(endpoint.Hostname()); err == nil {
		addresses = []netip.Addr{literal}
	} else {
		addresses, err = policy.resolver.LookupNetIP(ctx, "ip", endpoint.Hostname())
		if err != nil || len(addresses) == 0 {
			return nil, nil, ports.ErrProviderEndpointUnavailable
		}
	}
	for i, address := range addresses {
		if !policy.allowed(address) {
			return nil, nil, ports.ErrProviderEndpointForbidden
		}
		addresses[i] = address.Unmap()
	}
	if ctx.Err() != nil {
		return nil, nil, ports.ErrProviderEndpointUnavailable
	}
	return endpoint, addresses, nil
}

// ValidateEndpoint resolves only and never opens a socket or sends a credential.
func (policy *Policy) ValidateEndpoint(ctx context.Context, raw string) error {
	_, _, err := policy.resolve(ctx, raw)
	return err
}
