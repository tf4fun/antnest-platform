package tunnel

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/gorilla/websocket"

	"soft/antnest-platform/services/runtime-egress/internal/egress"
	"soft/antnest-platform/services/runtime-egress/internal/protocol"
)

const runtimeWebSocketSubprotocol = "antnest.runtime.v1"

type ReservationEnsurer interface {
	EnsureTunnel(context.Context, protocol.Reservation) error
}

type Gateway interface {
	OpenTunnel(context.Context, egress.TunnelIdentity) (egress.TunnelEndpoint, error)
}

type Server struct {
	verifier *TokenVerifier
	ensurer  ReservationEnsurer
	gateway  Gateway
	mtu      int
	upgrader websocket.Upgrader
}

func NewServer(
	verifier *TokenVerifier,
	ensurer ReservationEnsurer,
	gateway Gateway,
	mtu int,
) (*Server, error) {
	if verifier == nil || ensurer == nil || gateway == nil || mtu < 576 || mtu > 65535 {
		return nil, fmt.Errorf("token verifier, reservation ensurer, Gateway, and valid MTU are required")
	}
	return &Server{
		verifier: verifier,
		ensurer:  ensurer,
		gateway:  gateway,
		mtu:      mtu,
		upgrader: websocket.Upgrader{
			EnableCompression: false,
			Subprotocols:      []string{runtimeWebSocketSubprotocol},
			CheckOrigin: func(request *http.Request) bool {
				return strings.TrimSpace(request.Header.Get("Origin")) == ""
			},
		},
	}, nil
}

func (s *Server) TunnelHandler(writer http.ResponseWriter, request *http.Request) {
	if !offersRuntimeSubprotocol(request) {
		http.Error(writer, "Runtime WebSocket subprotocol is required", http.StatusUpgradeRequired)
		return
	}
	token, ok := bearerToken(request)
	if !ok {
		http.Error(writer, "Runtime egress token is required", http.StatusUnauthorized)
		return
	}
	claims, err := s.verifier.Verify(token)
	if err != nil {
		http.Error(writer, "Runtime egress token is invalid", http.StatusUnauthorized)
		return
	}
	if err := s.ensurer.EnsureTunnel(request.Context(), claims.Reservation); err != nil {
		http.Error(writer, "Runtime egress reservation is unavailable", http.StatusConflict)
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
	if err := s.serveTunnel(request.Context(), conn, claims); err != nil {
		_ = conn.Close()
	}
}

func (s *Server) serveTunnel(
	ctx context.Context,
	conn *websocket.Conn,
	claims protocol.TunnelClaims,
) error {
	key := egress.GenerationKey{
		RuntimeInstanceID: claims.Reservation.RuntimeInstanceID,
		Generation:        claims.Reservation.Generation,
	}
	endpoint, err := s.gateway.OpenTunnel(ctx, egress.TunnelIdentity{
		Key: key, AgentID: claims.Reservation.AgentID, RuntimeBootID: claims.RuntimeBootID,
		ConnectionEpoch: claims.ConnectionEpoch, PolicyRevision: claims.Reservation.PolicyRevision,
		PolicyEpoch: claims.Reservation.PolicyEpoch, TunnelVirtualIP: claims.Reservation.VirtualIP,
		AllocatorEpoch:       claims.Reservation.AllocatorEpoch,
		RuntimeFenceRevision: claims.Reservation.Generation,
	})
	if err != nil {
		return err
	}
	return pump(ctx, conn, endpoint, claims.ConnectionEpoch, claims.Reservation.PolicyEpoch, s.mtu)
}

func pump(
	ctx context.Context,
	conn *websocket.Conn,
	endpoint egress.TunnelEndpoint,
	connectionEpoch uint64,
	policyEpoch uint64,
	mtu int,
) error {
	ctx, cancel := context.WithCancelCause(ctx)
	defer cancel(nil)
	defer func() { _ = conn.Close() }()
	defer func() { endpoint.Close(context.Cause(ctx)) }()
	conn.SetReadLimit(int64(packetFrameHeader + maxPacketCount*(2+mtu)))

	writerDone := make(chan error, 1)
	go func() {
		err := writeDownlink(ctx, conn, endpoint.Downlink(), mtu)
		cancel(err)
		_ = conn.Close()
		writerDone <- err
	}()
	readerErr := readUplink(ctx, conn, endpoint, connectionEpoch, policyEpoch, mtu)
	cancel(readerErr)
	_ = conn.Close()
	writerErr := <-writerDone
	if readerErr == nil || readerErr == io.EOF {
		return writerErr
	}
	return readerErr
}

func readUplink(
	ctx context.Context,
	conn *websocket.Conn,
	endpoint egress.TunnelEndpoint,
	connectionEpoch uint64,
	policyEpoch uint64,
	mtu int,
) error {
	for {
		messageType, frame, err := conn.ReadMessage()
		if err != nil {
			return err
		}
		if messageType != websocket.BinaryMessage {
			return fmt.Errorf("Runtime tunnel received non-binary frame")
		}
		batch, err := DecodePacketBatch(frame, policyEpoch, mtu)
		if err != nil {
			return err
		}
		batch.ConnectionEpoch = connectionEpoch
		if err := endpoint.ReceiveUplink(ctx, batch); err != nil {
			return err
		}
	}
}

func writeDownlink(
	ctx context.Context,
	conn *websocket.Conn,
	downlink <-chan egress.PacketBatch,
	mtu int,
) error {
	for {
		select {
		case <-ctx.Done():
			return context.Cause(ctx)
		case batch, ok := <-downlink:
			if !ok {
				return io.EOF
			}
			frame, err := EncodePacketBatch(batch, mtu)
			if err != nil {
				return err
			}
			if err := conn.SetWriteDeadline(time.Now().Add(10 * time.Second)); err != nil {
				return err
			}
			if err := conn.WriteMessage(websocket.BinaryMessage, frame); err != nil {
				return err
			}
		}
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
