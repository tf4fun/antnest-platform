package rpc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/acpincarnation"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/observation"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/telemetry"
)

const acpIncarnationRequestBytes = 4096
const acpIncarnationResponseBytes = 8192

type AcpIncarnationService interface {
	Register(context.Context, acpincarnation.RegisterRequest) (acpincarnation.Registration, error)
	Inspect(context.Context, string) (acpincarnation.Inspection, error)
	History(context.Context, acpincarnation.HistoryRequest) (acpincarnation.HistoryPage, error)
}

// NewHandlerWithAcpIncarnations adds ACP-only registration, inspection and history routes. The existing service
// port and its Controller-only authorization remain separate.
func NewHandlerWithAcpIncarnations(
	service Service, hub *observation.Hub, heartbeat, requestTimeout time.Duration,
	security Security, incarnations AcpIncarnationService, skillPreparations ...SkillPreparationService,
) (*Handler, error) {
	if incarnations == nil {
		return nil, fmt.Errorf("ACP incarnation service is required")
	}
	h, err := NewHandler(service, hub, heartbeat, requestTimeout, security, skillPreparations...)
	if err != nil {
		return nil, err
	}
	h.incarnations = incarnations
	// Separate muxes avoid a wildcard inspection competing with the literal
	// register path. Exact path/method selection occurs before either mux.
	h.acpRegisterMux = http.NewServeMux()
	h.acpRegisterMux.Handle("POST /internal/acp-incarnations/register", telemetry.RPCHandler("POST /internal/acp-incarnations/register", http.HandlerFunc(h.registerAcpIncarnation)))
	h.acpRegisterMux.HandleFunc("/internal/acp-incarnations/register", h.methodNotAllowed)
	h.acpRegisterMux.Handle("POST /internal/acp-incarnations/history", telemetry.RPCHandler("POST /internal/acp-incarnations/history", http.HandlerFunc(h.historyAcpIncarnations)))
	h.acpRegisterMux.HandleFunc("/internal/acp-incarnations/history", h.methodNotAllowed)
	h.acpInspectMux = http.NewServeMux()
	h.acpInspectMux.Handle("GET /internal/acp-incarnations/{registration_id}", telemetry.RPCHandler("GET /internal/acp-incarnations/{registration_id}", http.HandlerFunc(h.inspectAcpIncarnation)))
	h.acpInspectMux.HandleFunc("/internal/acp-incarnations/{registration_id}", h.methodNotAllowed)
	return h, nil
}

func acpIncarnationRoute(r *http.Request) (register, matched bool) {
	if r.URL.EscapedPath() != r.URL.Path {
		return false, false
	}
	if r.URL.Path == "/internal/acp-incarnations/register" || r.URL.Path == "/internal/acp-incarnations/history" {
		return true, true
	}
	const prefix = "/internal/acp-incarnations/"
	id, found := strings.CutPrefix(r.URL.Path, prefix)
	return false, found && id != "" && !strings.Contains(id, "/")
}

func (h *Handler) serveAcpIncarnation(w http.ResponseWriter, r *http.Request, register bool) {
	budget := min(h.requestTimeout, 10*time.Second)
	deadline := time.Now().Add(budget)
	if parent, ok := r.Context().Deadline(); ok && parent.Before(deadline) {
		deadline = parent
	}
	// Reserve part of the total bound for the fixed-size response and socket
	// cleanup. A body/port deadline must still leave room to deliver a 504.
	reserve := min(100*time.Millisecond, max(time.Until(deadline)/10, 0))
	workDeadline := deadline.Add(-reserve)
	ctx, cancel := context.WithDeadline(r.Context(), workDeadline)
	defer cancel()
	bounded := r.WithContext(ctx)
	controller := http.NewResponseController(w)
	_ = controller.SetReadDeadline(workDeadline)
	_ = controller.SetWriteDeadline(deadline)
	interrupted := make(chan struct{})
	stop := context.AfterFunc(ctx, func() {
		now := time.Now()
		_ = controller.SetReadDeadline(now)
		// net/http also cancels its request context when a socket read hits
		// our work deadline. Preserve the remaining reply window in that case.
		if errors.Is(ctx.Err(), context.Canceled) && now.Before(workDeadline) {
			_ = controller.SetWriteDeadline(now)
		}
		close(interrupted)
	})
	defer func() {
		// Close is synchronous and uses the same read deadline; the original
		// body, port call and socket flush finish before this handler returns.
		if bounded.Body != nil {
			_ = bounded.Body.Close()
		}
		_ = controller.Flush()
		if !stop() {
			<-interrupted
		}
		_ = controller.SetReadDeadline(time.Time{})
		_ = controller.SetWriteDeadline(time.Time{})
		r.Pattern = bounded.Pattern
	}()
	_, err := h.security.Authentication.Authorize(bounded, []string{"agent-acp-service"})
	if err != nil {
		var failure *serviceauth.Failure
		if !errors.As(err, &failure) {
			failure = serviceauth.Unauthenticated()
		}
		if failure.Challenge != "" {
			w.Header().Set("WWW-Authenticate", failure.Challenge)
		}
		writeAcpIncarnationError(w, failure.Code)
		return
	}
	for name := range bounded.Header {
		if strings.HasPrefix(strings.ToLower(name), "x-antnest-") || strings.EqualFold(name, "Antnest-Caller-Context") || strings.EqualFold(name, "Authorization") || strings.EqualFold(name, "Cookie") {
			delete(bounded.Header, name)
		}
	}
	method := http.MethodGet
	if register {
		method = http.MethodPost
	}
	if bounded.Method != method {
		w.Header().Set("Allow", method)
		writeAcpIncarnationError(w, "method_not_allowed")
		return
	}
	if bounded.URL.RawQuery != "" || bounded.URL.ForceQuery {
		writeAcpIncarnationError(w, "invalid_request")
		return
	}
	if ctx.Err() != nil {
		writeAcpIncarnationError(w, "deadline_exceeded")
		return
	}
	if register {
		if !acpIncarnationJSON(bounded.Header) {
			writeAcpIncarnationError(w, "unsupported_media_type")
			return
		}
		h.acpRegisterMux.ServeHTTP(w, bounded)
	} else {
		h.acpInspectMux.ServeHTTP(w, bounded)
	}
}

func acpIncarnationJSON(header http.Header) bool {
	media, encodings := header.Values("Content-Type"), header.Values("Content-Encoding")
	if len(media) != 1 || len(encodings) > 1 || len(encodings) == 1 && !strings.EqualFold(encodings[0], "identity") {
		return false
	}
	kind, parameters, err := mime.ParseMediaType(media[0])
	return err == nil && kind == "application/json" && (len(parameters) == 0 || len(parameters) == 1 && strings.EqualFold(parameters["charset"], "utf-8"))
}

func (h *Handler) registerAcpIncarnation(w http.ResponseWriter, r *http.Request) {
	if r.ContentLength > acpIncarnationRequestBytes {
		writeAcpIncarnationError(w, "request_too_large")
		return
	}
	var raw []byte
	var err error
	if r.Body != nil {
		raw, err = io.ReadAll(io.LimitReader(r.Body, acpIncarnationRequestBytes+1))
	}
	if acpIncarnationTimedOut(r.Context(), err) {
		writeAcpIncarnationError(w, "deadline_exceeded")
		return
	}
	if len(raw) > acpIncarnationRequestBytes {
		writeAcpIncarnationError(w, "request_too_large")
		return
	}
	var input acpincarnation.RegisterRequest
	if err != nil || serviceauth.DecodeObject(raw, &input) != nil || !acpincarnation.ValidMemberID(input.MemberID) || !acpincarnation.ValidUUID(input.IncarnationID) || !acpincarnation.ValidNonce(input.RegistrationNonce) {
		writeAcpIncarnationError(w, "invalid_request")
		return
	}
	value, err := h.incarnations.Register(r.Context(), input)
	if err != nil || r.Context().Err() != nil {
		writeAcpIncarnationFailure(w, r.Context(), err, true)
		return
	}
	if !acpincarnation.ValidUUID(value.RegistrationID) || value.MemberID != input.MemberID || value.IncarnationID != input.IncarnationID {
		writeAcpIncarnationError(w, "internal_error")
		return
	}
	writeAcpIncarnationJSON(w, value)
}

func (h *Handler) inspectAcpIncarnation(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("registration_id")
	if !acpincarnation.ValidUUID(id) || r.ContentLength != 0 {
		writeAcpIncarnationError(w, "invalid_request")
		return
	}
	if r.Body != nil && r.Body != http.NoBody {
		raw, err := io.ReadAll(io.LimitReader(r.Body, 1))
		if acpIncarnationTimedOut(r.Context(), err) {
			writeAcpIncarnationError(w, "deadline_exceeded")
			return
		}
		if err != nil || len(raw) != 0 {
			writeAcpIncarnationError(w, "invalid_request")
			return
		}
	}
	value, err := h.incarnations.Inspect(r.Context(), id)
	if err != nil || r.Context().Err() != nil {
		writeAcpIncarnationFailure(w, r.Context(), err, false)
		return
	}
	if value.RegistrationID != id || !validAcpInspection(value) {
		writeAcpIncarnationError(w, "internal_error")
		return
	}
	if value.ObservedAt != nil {
		utc := value.ObservedAt.UTC()
		value.ObservedAt = &utc
	}
	if value.StopReceipt != nil {
		receipt := *value.StopReceipt
		receipt.ObservedAt = receipt.ObservedAt.UTC()
		value.StopReceipt = &receipt
	}
	writeAcpIncarnationJSON(w, value)
}

func validAcpInspection(value acpincarnation.Inspection) bool {
	switch value.State {
	case "unknown":
		return value.MemberID == "" && value.IncarnationID == "" && value.ObservedAt == nil && value.StopReceipt == nil &&
			(value.Reason == "unregistered" || value.Reason == "platform_unavailable" || value.Reason == "engine_changed" || value.Reason == "membership_unavailable")
	case "running", "stopped":
		if !acpincarnation.ValidMemberID(value.MemberID) || !acpincarnation.ValidUUID(value.IncarnationID) || value.Reason != "" {
			return false
		}
		if value.State == "running" {
			return value.ObservedAt != nil && !value.ObservedAt.IsZero() && value.StopReceipt == nil
		}
		receipt := value.StopReceipt
		return value.ObservedAt == nil && receipt != nil && acpincarnation.ValidUUID(receipt.ReceiptID) && !receipt.ObservedAt.IsZero() &&
			(receipt.Reason == "container_stopped" || receipt.Reason == "container_restarted" || receipt.Reason == "container_removed")
	default:
		return false
	}
}

func acpIncarnationTimedOut(ctx context.Context, err error) bool {
	var timeout net.Error
	return ctx.Err() != nil || errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) || errors.As(err, &timeout) && timeout.Timeout()
}

func writeAcpIncarnationFailure(w http.ResponseWriter, ctx context.Context, err error, register bool) {
	if acpIncarnationTimedOut(ctx, err) {
		writeAcpIncarnationError(w, "deadline_exceeded")
		return
	}
	code := "internal_error"
	var failure *acpincarnation.Failure
	if errors.As(err, &failure) {
		switch failure.Code {
		case "invalid_request", "acp_registry_unavailable", "deadline_exceeded", "internal_error":
			code = failure.Code
		case "acp_member_not_allowed", "acp_incarnation_unverified", "acp_incarnation_conflict", "acp_registration_unavailable":
			if register {
				code = failure.Code
			}
		}
	}
	writeAcpIncarnationError(w, code)
}

func writeAcpIncarnationError(w http.ResponseWriter, code string) {
	status, retryable := http.StatusInternalServerError, true
	switch code {
	case "service_unauthenticated":
		status, retryable = http.StatusUnauthorized, false
	case "caller_not_allowed", "acp_member_not_allowed", "acp_incarnation_unverified":
		status, retryable = http.StatusForbidden, false
	case "invalid_request":
		status, retryable = http.StatusBadRequest, false
	case "unsupported_media_type":
		status, retryable = http.StatusUnsupportedMediaType, false
	case "request_too_large":
		status, retryable = http.StatusRequestEntityTooLarge, false
	case "acp_incarnation_conflict":
		status, retryable = http.StatusConflict, false
	case "method_not_allowed":
		status, retryable = http.StatusMethodNotAllowed, false
	case "route_not_found":
		status, retryable = http.StatusNotFound, false
	case "acp_registration_unavailable", "acp_registry_unavailable":
		status = http.StatusServiceUnavailable
	case "deadline_exceeded":
		status = http.StatusGatewayTimeout
	default:
		code = "internal_error"
	}
	writeJSON(w, status, errorResponse{Code: code, Message: "ACP incarnation request did not complete", Retryable: retryable})
}

func writeAcpIncarnationJSON(w http.ResponseWriter, value any) {
	raw, err := json.Marshal(value)
	if err != nil || len(raw)+1 > acpIncarnationResponseBytes {
		writeAcpIncarnationError(w, "internal_error")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(append(raw, '\n'))
}
