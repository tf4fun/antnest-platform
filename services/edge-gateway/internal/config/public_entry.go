package config

import (
	"fmt"
	"net"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
)

// ParsePublicOrigin accepts an origin, never a URL prefix or a forwarded value.
func ParsePublicOrigin(raw string) (*url.URL, error) {
	origin, err := url.Parse(raw)
	if err != nil || (origin.Scheme != "https" && origin.Scheme != "http") || origin.Hostname() == "" ||
		origin.User != nil || origin.Path != "" || origin.RawPath != "" || origin.ForceQuery ||
		origin.RawQuery != "" || origin.Fragment != "" || strings.Contains(raw, "#") ||
		strings.ContainsAny(origin.Host, "\\ \t\r\n%") || strings.HasSuffix(origin.Host, ":") {
		return nil, fmt.Errorf("ANTNEST_EDGE_PUBLIC_ORIGIN must contain only an HTTP scheme, host and optional port")
	}
	if port := origin.Port(); port != "" {
		value, err := strconv.Atoi(port)
		if err != nil || value < 1 || value > 65535 {
			return nil, fmt.Errorf("ANTNEST_EDGE_PUBLIC_ORIGIN port is invalid")
		}
	}
	if origin.Scheme == "http" && !loopbackIP(origin.Hostname()) {
		return nil, fmt.Errorf("ANTNEST_EDGE_PUBLIC_ORIGIN requires HTTPS outside literal loopback addresses")
	}
	host := strings.ToLower(origin.Hostname())
	for _, character := range host {
		if character >= 0x80 {
			return nil, fmt.Errorf("ANTNEST_EDGE_PUBLIC_ORIGIN host must use ASCII or punycode")
		}
	}
	if ip, err := netip.ParseAddr(host); err == nil {
		host = ip.String()
		if ip.Is4In6() {
			bytes := ip.As16()
			host = fmt.Sprintf("::ffff:%x:%x", uint16(bytes[12])<<8|uint16(bytes[13]), uint16(bytes[14])<<8|uint16(bytes[15]))
		}
		if ip.Is6() {
			host = "[" + host + "]"
		}
	}
	port := origin.Port()
	if port != "" {
		number, _ := strconv.Atoi(port)
		port = strconv.Itoa(number)
		if origin.Scheme == "https" && port == "443" || origin.Scheme == "http" && port == "80" {
			port = ""
		}
	}
	origin.Host = host
	if port != "" {
		origin.Host += ":" + port
	}
	return origin, nil
}

func (config *Config) loadPublicEntry(lookup func(string) string) error {
	host, _, err := net.SplitHostPort(config.ListenAddress)
	if err != nil {
		return fmt.Errorf("ANTNEST_EDGE_LISTEN must be a host:port address")
	}
	loopback := loopbackIP(host)
	if (config.TLSCertFile == "") != (config.TLSKeyFile == "") {
		return fmt.Errorf("ANTNEST_EDGE_TLS_CERT_FILE and ANTNEST_EDGE_TLS_KEY_FILE must be configured together")
	}
	nativeTLS := config.TLSCertFile != ""
	if !config.CookieSecure && (!loopback || nativeTLS) {
		return fmt.Errorf("ANTNEST_EDGE_COOKIE_SECURE=false requires a literal loopback HTTP listener")
	}
	var origin *url.URL
	if config.PublicOrigin != "" {
		origin, err = ParsePublicOrigin(config.PublicOrigin)
		if err != nil {
			return err
		}
		config.PublicOrigin = origin.String()
	} else if !loopback || nativeTLS {
		return fmt.Errorf("ANTNEST_EDGE_PUBLIC_ORIGIN is required outside direct loopback HTTP")
	}
	if raw := strings.TrimSpace(lookup("ANTNEST_EDGE_TRUSTED_PROXIES")); raw != "" {
		for _, item := range strings.Split(raw, ",") {
			prefix, err := netip.ParsePrefix(strings.TrimSpace(item))
			if err != nil || prefix.Addr().Zone() != "" || prefix.Addr().Is4In6() {
				return fmt.Errorf("ANTNEST_EDGE_TRUSTED_PROXIES must contain IPv4 or IPv6 CIDRs")
			}
			config.TrustedProxies = append(config.TrustedProxies, prefix.Masked())
		}
	}
	if nativeTLS && (origin == nil || origin.Scheme != "https") {
		return fmt.Errorf("native TLS requires an HTTPS ANTNEST_EDGE_PUBLIC_ORIGIN")
	}
	if origin != nil && origin.Scheme == "https" {
		if !config.CookieSecure {
			return fmt.Errorf("HTTPS public origins require Secure cookies")
		}
		if !nativeTLS && len(config.TrustedProxies) == 0 {
			return fmt.Errorf("HTTPS on an HTTP listener requires ANTNEST_EDGE_TRUSTED_PROXIES")
		}
	}
	if origin == nil && len(config.TrustedProxies) != 0 {
		return fmt.Errorf("trusted proxies require an explicit ANTNEST_EDGE_PUBLIC_ORIGIN")
	}
	return nil
}

func loopbackIP(host string) bool {
	ip, err := netip.ParseAddr(host)
	return err == nil && ip.Zone() == "" && ip.Unmap().IsLoopback()
}
