package runtimeconn

import (
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"strings"

	"github.com/gorilla/websocket"
)

const runtimeWebSocketSubprotocol = "antnest.runtime.v1"

type HTTPServer struct {
	registry        *RuntimeRegistry
	maxMessageBytes int
	upgrader        websocket.Upgrader
}

func NewHTTPServer(registry *RuntimeRegistry, maxMessageBytes int) (*HTTPServer, error) {
	if registry == nil {
		return nil, fmt.Errorf("runtime JSON-RPC registry is required")
	}
	if maxMessageBytes <= 0 {
		return nil, fmt.Errorf("runtime JSON-RPC message limit must be positive")
	}
	return &HTTPServer{
		registry: registry, maxMessageBytes: maxMessageBytes,
		upgrader: websocket.Upgrader{
			EnableCompression: false,
			Subprotocols:      []string{runtimeWebSocketSubprotocol},
			CheckOrigin: func(request *http.Request) bool {
				return strings.TrimSpace(request.Header.Get("Origin")) == ""
			},
		},
	}, nil
}

func (s *HTTPServer) ControlHandler(writer http.ResponseWriter, request *http.Request) {
	if !offersRuntimeSubprotocol(request) {
		http.Error(writer, "Runtime WebSocket subprotocol is required", http.StatusUpgradeRequired)
		return
	}
	token, ok := bearerToken(request)
	if !ok || len(token) < 32 {
		http.Error(writer, "Runtime admission token is required", http.StatusUnauthorized)
		return
	}
	endpoint, err := remoteAddrPort(request.RemoteAddr)
	if err != nil {
		http.Error(writer, "Runtime remote endpoint is invalid", http.StatusBadRequest)
		return
	}
	conn, err := s.upgrader.Upgrade(writer, request, nil)
	if err != nil {
		return
	}
	if conn.Subprotocol() != runtimeWebSocketSubprotocol {
		_ = conn.Close()
		return
	}
	if err := s.registry.ServeControl(
		request.Context(),
		conn,
		s.maxMessageBytes,
		token,
		endpoint,
	); err != nil {
		_ = conn.Close()
	}
}

func offersRuntimeSubprotocol(request *http.Request) bool {
	if request == nil {
		return false
	}
	offers := make([]string, 0, 1)
	for _, value := range request.Header.Values("Sec-WebSocket-Protocol") {
		for _, offer := range strings.Split(value, ",") {
			if offer = strings.TrimSpace(offer); offer != "" {
				offers = append(offers, offer)
			}
		}
	}
	return len(offers) == 1 && offers[0] == runtimeWebSocketSubprotocol
}

func bearerToken(request *http.Request) (string, bool) {
	scheme, token, ok := strings.Cut(strings.TrimSpace(request.Header.Get("Authorization")), " ")
	token = strings.TrimSpace(token)
	return token, ok && strings.EqualFold(scheme, "Bearer") && token != ""
}

func remoteAddrPort(value string) (netip.AddrPort, error) {
	host, port, err := net.SplitHostPort(strings.TrimSpace(value))
	if err != nil {
		return netip.AddrPort{}, err
	}
	return netip.ParseAddrPort(net.JoinHostPort(host, port))
}
