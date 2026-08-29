package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"

	"soft/antnest-platform/services/runtime-egress/internal/protocol"
)

type Service interface {
	Ensure(context.Context, protocol.Reservation) error
	Release(context.Context, protocol.GenerationKey) error
}

type Handler struct {
	service Service
	ready   func(context.Context) error
	mux     *http.ServeMux
}

func New(service Service, ready func(context.Context) error) (*Handler, error) {
	if service == nil || ready == nil {
		return nil, fmt.Errorf("egress service and readiness check are required")
	}
	handler := &Handler{service: service, ready: ready, mux: http.NewServeMux()}
	handler.mux.HandleFunc("GET /healthz", handler.health)
	handler.mux.HandleFunc("GET /readyz", handler.readiness)
	handler.mux.HandleFunc("PUT /internal/v1/reservations/{runtime_instance_id}/{generation}", handler.ensure)
	handler.mux.HandleFunc("DELETE /internal/v1/reservations/{runtime_instance_id}/{generation}", handler.release)
	return handler, nil
}

func (h *Handler) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	h.mux.ServeHTTP(writer, request)
}

func (*Handler) health(writer http.ResponseWriter, _ *http.Request) {
	writer.WriteHeader(http.StatusOK)
}

func (h *Handler) readiness(writer http.ResponseWriter, request *http.Request) {
	if err := h.ready(request.Context()); err != nil {
		problem(writer, http.StatusServiceUnavailable, "egress_not_ready", err)
		return
	}
	writer.WriteHeader(http.StatusOK)
}

func (h *Handler) ensure(writer http.ResponseWriter, request *http.Request) {
	key, err := pathKey(request)
	if err != nil {
		problem(writer, http.StatusBadRequest, "invalid_generation", err)
		return
	}
	var reservation protocol.Reservation
	if err := decodeJSON(request, &reservation); err != nil {
		problem(writer, http.StatusBadRequest, "invalid_reservation", err)
		return
	}
	if reservation.GenerationKey != key {
		problem(writer, http.StatusConflict, "generation_mismatch", errors.New("path and body generation differ"))
		return
	}
	if err := h.service.Ensure(request.Context(), reservation); err != nil {
		problem(writer, http.StatusConflict, "reservation_failed", err)
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func (h *Handler) release(writer http.ResponseWriter, request *http.Request) {
	key, err := pathKey(request)
	if err != nil {
		problem(writer, http.StatusBadRequest, "invalid_generation", err)
		return
	}
	if err := h.service.Release(request.Context(), key); err != nil {
		problem(writer, http.StatusConflict, "release_failed", err)
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func pathKey(request *http.Request) (protocol.GenerationKey, error) {
	generation, err := strconv.ParseUint(strings.TrimSpace(request.PathValue("generation")), 10, 64)
	if err != nil {
		return protocol.GenerationKey{}, fmt.Errorf("generation must be a positive integer")
	}
	key := protocol.GenerationKey{
		RuntimeInstanceID: strings.TrimSpace(request.PathValue("runtime_instance_id")),
		Generation:        generation,
	}
	return key, key.Validate()
}

func decodeJSON(request *http.Request, target any) error {
	decoder := json.NewDecoder(io.LimitReader(request.Body, 64<<10))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return fmt.Errorf("request body contains trailing JSON")
		}
		return err
	}
	return nil
}

func problem(writer http.ResponseWriter, status int, code string, err error) {
	writer.Header().Set("Content-Type", "application/problem+json")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(map[string]any{
		"status": status,
		"code":   code,
		"detail": err.Error(),
	})
}
