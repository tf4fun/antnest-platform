package server

import (
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
)

type clientAddressKey struct{}

func (h *handler) externalOrigin(request *http.Request) *url.URL {
	if h.publicOrigin != nil {
		return h.publicOrigin
	}
	// Startup permits this fallback only for a direct loopback HTTP listener.
	scheme := "http"
	if request.TLS != nil {
		scheme = "https"
	}
	return &url.URL{Scheme: scheme, Host: request.Host}
}

func (h *handler) sameOrigin(request *http.Request) bool {
	values := request.Header.Values("Origin")
	return len(values) == 1 && values[0] == h.externalOrigin(request).String()
}

func (h *handler) trustedProxy(address netip.Addr) bool {
	for _, prefix := range h.trustedProxies {
		if prefix.Contains(address.Unmap()) {
			return true
		}
	}
	return false
}

func (h *handler) clientAddress(request *http.Request) string {
	host, _, err := net.SplitHostPort(request.RemoteAddr)
	if err != nil {
		host = request.RemoteAddr
	}
	peer, err := netip.ParseAddr(host)
	if err != nil || peer.Zone() != "" {
		return "unknown"
	}
	peer = peer.Unmap()
	if !h.trustedProxy(peer) {
		return peer.String()
	}
	chain := strings.Split(strings.Join(request.Header.Values("X-Forwarded-For"), ","), ",")
	for index := len(chain) - 1; index >= 0; index-- {
		address, err := netip.ParseAddr(strings.TrimSpace(chain[index]))
		if err != nil || address.Zone() != "" {
			return peer.String()
		}
		address = address.Unmap()
		if !h.trustedProxy(address) {
			return address.String()
		}
	}
	return peer.String()
}

func clientAddress(request *http.Request) string {
	address, _ := request.Context().Value(clientAddressKey{}).(string)
	return address
}

func stripForwardingHeaders(header http.Header) {
	for name := range header {
		lower := strings.ToLower(name)
		if lower == "forwarded" || lower == "x-real-ip" || strings.HasPrefix(lower, "x-forwarded-") {
			delete(header, name)
		}
	}
}

func (h *handler) forwardingHeaders(header http.Header, request *http.Request) {
	stripForwardingHeaders(header)
	if address := clientAddress(request); address != "" && address != "unknown" {
		header.Set("X-Forwarded-For", address)
	}
	origin := h.externalOrigin(request)
	header.Set("X-Forwarded-Host", origin.Host)
	header.Set("X-Forwarded-Proto", origin.Scheme)
}
