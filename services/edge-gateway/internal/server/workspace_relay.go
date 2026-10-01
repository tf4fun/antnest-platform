package server

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/gorilla/websocket"

	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/identity"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/telemetry"
)

const maximumACPMessageBytes = 64 << 20

func (h *handler) relayWorkspaceACP(
	response http.ResponseWriter, request *http.Request,
	token string, principal identity.Principal,
) {
	upstream, status, err := h.dialWorkspaceACP(request, principal)
	if err != nil {
		h.logger.ErrorContext(request.Context(), "ACP connection failed", "error_class", "upstream_unavailable")
		writeError(response, status, "agent_unavailable", "Agent connection is unavailable")
		return
	}
	defer func() { _ = upstream.Close() }()
	upgrader := websocket.Upgrader{HandshakeTimeout: h.requestTimeout, CheckOrigin: sameOrigin}
	if protocol := upstream.Subprotocol(); protocol != "" {
		upgrader.Subprotocols = []string{protocol}
	}
	client, err := upgrader.Upgrade(response, request, response.Header().Clone())
	if err != nil {
		return
	}
	defer func() { _ = client.Close() }()
	result := relayMessages(request.Context(), client, upstream, h.requestTimeout, maximumACPMessageBytes, h.acpMessages,
		func(ctx context.Context) *relayEnd { return h.checkRelaySession(ctx, token, principal) })
	h.logger.InfoContext(request.Context(), "ACP connection closed",
		"close_code", result.code, "reason", result.reason)
}

func (h *handler) dialWorkspaceACP(request *http.Request, principal identity.Principal) (*websocket.Conn, int, error) {
	transport := telemetry.BaseHTTPTransport(h.httpClient.Transport)
	configured, ok := transport.(*http.Transport)
	if !ok {
		return nil, http.StatusServiceUnavailable, fmt.Errorf("ACP requires an HTTP transport with socket configuration")
	}
	dialer := websocket.Dialer{
		Proxy: configured.Proxy, NetDialContext: configured.DialContext,
		NetDialTLSContext: configured.DialTLSContext, TLSClientConfig: configured.TLSClientConfig,
		HandshakeTimeout: h.requestTimeout, Subprotocols: websocket.Subprotocols(request),
	}
	target := *h.agentACPURL
	target.Scheme = "ws"
	if h.agentACPURL.Scheme == "https" {
		target.Scheme = "wss"
	}
	target.Path, target.RawPath, target.RawQuery = "/"+request.PathValue("acp_version")+"/acp", "", ""
	headers := make(http.Header)
	setACPIdentity(headers, principal, request.PathValue("agent_id"))
	connection, response, err := telemetry.DialWebSocket(request.Context(), &dialer, target.String(), headers)
	status := http.StatusServiceUnavailable
	if response != nil && response.StatusCode >= 400 && response.StatusCode < 500 {
		status = response.StatusCode
	}
	if response != nil && response.Body != nil {
		_ = response.Body.Close()
	}
	return connection, status, err
}

func (h *handler) checkRelaySession(ctx context.Context, token string, original identity.Principal) *relayEnd {
	ctx, cancel := context.WithTimeout(ctx, h.requestTimeout)
	defer cancel()
	current, err := h.identity.Resolve(ctx, token)
	if err != nil && !identity.IsCode(err, "unauthenticated") && !identity.IsCode(err, "inactive_principal") {
		return &relayEnd{websocket.CloseTryAgainLater, "identity_unavailable"}
	}
	if err != nil || !current.Active || current.UserID == "" || current.OrganizationID == "" || current.MembershipID == "" ||
		current.UserID != original.UserID || current.OrganizationID != original.OrganizationID || current.MembershipID != original.MembershipID {
		return &relayEnd{websocket.ClosePolicyViolation, "session_rejected"}
	}
	return nil
}

type relayEnd struct {
	code   int
	reason string
}

func (end *relayEnd) Error() string { return end.reason }

func relayMessages(
	ctx context.Context, client, upstream *websocket.Conn, timeout time.Duration, limit int64,
	permits chan struct{},
	admit func(context.Context) *relayEnd,
) relayEnd {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	client.SetReadLimit(limit)
	upstream.SetReadLimit(limit)
	completed := make(chan relayEnd, 2)
	go func() { completed <- relayDirection(ctx, client, upstream, timeout, permits, admit) }()
	go func() { completed <- relayDirection(ctx, upstream, client, timeout, permits, nil) }()
	pending := 2
	var result relayEnd
	select {
	case result = <-completed:
		pending--
	case <-ctx.Done():
	}
	if ctx.Err() != nil {
		result = relayEnd{websocket.CloseGoingAway, "connection_closed"}
	}
	// A cancelled request must notify peers before sockets unblock the readers.
	deadline := time.Now().Add(min(timeout, time.Second))
	message := websocket.FormatCloseMessage(result.code, result.reason)
	_ = client.WriteControl(websocket.CloseMessage, message, deadline)
	_ = upstream.WriteControl(websocket.CloseMessage, message, deadline)
	cancel()
	_ = client.Close()
	_ = upstream.Close()
	for range pending {
		<-completed
	}
	return result
}

func relayDirection(
	ctx context.Context, source, destination *websocket.Conn, timeout time.Duration,
	permits chan struct{},
	admit func(context.Context) *relayEnd,
) relayEnd {
	for {
		kind, reader, err := source.NextReader()
		if err != nil {
			return peerRelayEnd(err)
		}
		if result := relayMessage(ctx, source, destination, reader, kind, timeout, permits, admit); result != nil {
			return *result
		}
	}
}

func relayMessage(
	ctx context.Context, source, destination *websocket.Conn, reader io.Reader, kind int,
	timeout time.Duration, permits chan struct{}, admit func(context.Context) *relayEnd,
) *relayEnd {
	wait, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	select {
	case permits <- struct{}{}:
		defer func() { <-permits }()
	case <-wait.Done():
		return &relayEnd{websocket.CloseTryAgainLater, "relay_capacity"}
	}
	if err := source.SetReadDeadline(time.Now().Add(time.Minute)); err != nil {
		return relayFailure(err)
	}
	message, err := io.ReadAll(reader)
	if err != nil {
		return relayFailure(err)
	}
	if err := source.SetReadDeadline(time.Time{}); err != nil {
		return relayFailure(err)
	}
	if ctx.Err() != nil {
		return &relayEnd{websocket.CloseGoingAway, "connection_closed"}
	}
	send := func(payload []byte) error {
		if err := destination.SetWriteDeadline(time.Now().Add(timeout)); err != nil {
			return err
		}
		return destination.WriteMessage(kind, payload)
	}
	if admit == nil {
		err = send(message)
	} else {
		err = telemetry.RelayACPMessage(ctx, kind, message, func(ctx context.Context) error {
			if rejection := admit(ctx); rejection != nil {
				return rejection
			}
			return ctx.Err()
		}, send)
	}
	if err != nil {
		var rejection *relayEnd
		if errors.As(err, &rejection) {
			return rejection
		}
		return relayFailure(err)
	}
	return nil
}

func relayFailure(err error) *relayEnd {
	result := peerRelayEnd(err)
	return &result
}

func peerRelayEnd(err error) relayEnd {
	if errors.Is(err, websocket.ErrReadLimit) {
		return relayEnd{websocket.CloseMessageTooBig, "message_too_large"}
	}
	var closed *websocket.CloseError
	if errors.As(err, &closed) {
		switch closed.Code {
		case 1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011, 1012, 1013:
			return relayEnd{closed.Code, "peer_closed"}
		}
	}
	return relayEnd{websocket.CloseInternalServerErr, "connection_failed"}
}

func setACPIdentity(headers http.Header, principal identity.Principal, agentID string) {
	headers.Set(HeaderOrganizationID, principal.OrganizationID)
	headers.Set(HeaderPrincipalID, principal.UserID)
	headers.Set(HeaderAgentID, agentID)
}
