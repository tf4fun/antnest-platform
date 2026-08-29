package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"soft/antnest-platform/services/runtime-provider-docker/internal/protocol"
)

type Driver interface {
	Ensure(context.Context, protocol.EnsureRequest) protocol.DriverResult
	Stop(context.Context, protocol.RuntimeTarget) protocol.DriverResult
	Remove(context.Context, protocol.RuntimeTarget, bool) protocol.DriverResult
}

type Handler struct {
	driver Driver
	ready  func(context.Context) error
	mux    *http.ServeMux
}

func New(driver Driver, ready func(context.Context) error) (*Handler, error) {
	if driver == nil || ready == nil {
		return nil, fmt.Errorf("Docker Runtime driver and readiness check are required")
	}
	handler := &Handler{driver: driver, ready: ready, mux: http.NewServeMux()}
	handler.mux.HandleFunc("GET /healthz", handler.health)
	handler.mux.HandleFunc("GET /readyz", handler.readiness)
	handler.mux.HandleFunc("PUT /internal/v1/runtimes/{agent_id}", handler.ensure)
	handler.mux.HandleFunc("POST /internal/v1/runtimes/{agent_id}/stop", handler.stop)
	handler.mux.HandleFunc("POST /internal/v1/runtimes/{agent_id}/remove", handler.remove)
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
		problem(writer, http.StatusServiceUnavailable, "docker_unavailable", err)
		return
	}
	writer.WriteHeader(http.StatusOK)
}

func (h *Handler) ensure(writer http.ResponseWriter, request *http.Request) {
	var input protocol.EnsureRequest
	if err := decodeJSON(request, &input); err != nil {
		problem(writer, http.StatusBadRequest, "invalid_runtime_spec", err)
		return
	}
	if strings.TrimSpace(request.PathValue("agent_id")) != input.AgentID {
		problem(writer, http.StatusConflict, "agent_mismatch", errors.New("path and body Agent identity differ"))
		return
	}
	writeResult(writer, h.driver.Ensure(request.Context(), input))
}

func (h *Handler) stop(writer http.ResponseWriter, request *http.Request) {
	var target protocol.RuntimeTarget
	if err := decodeJSON(request, &target); err != nil {
		problem(writer, http.StatusBadRequest, "invalid_runtime_target", err)
		return
	}
	if strings.TrimSpace(request.PathValue("agent_id")) != target.AgentID {
		problem(writer, http.StatusConflict, "agent_mismatch", errors.New("path and body Agent identity differ"))
		return
	}
	writeResult(writer, h.driver.Stop(request.Context(), target))
}

func (h *Handler) remove(writer http.ResponseWriter, request *http.Request) {
	var input protocol.RemoveRequest
	if err := decodeJSON(request, &input); err != nil {
		problem(writer, http.StatusBadRequest, "invalid_runtime_target", err)
		return
	}
	if strings.TrimSpace(request.PathValue("agent_id")) != input.Target.AgentID {
		problem(writer, http.StatusConflict, "agent_mismatch", errors.New("path and body Agent identity differ"))
		return
	}
	writeResult(writer, h.driver.Remove(request.Context(), input.Target, input.PurgeWorkspace))
}

func writeResult(writer http.ResponseWriter, result protocol.DriverResult) {
	writer.Header().Set("Content-Type", "application/json")
	if err := result.Outcome.Validate(); err != nil {
		problem(writer, http.StatusInternalServerError, "invalid_driver_result", err)
		return
	}
	_ = json.NewEncoder(writer).Encode(result)
}

func decodeJSON(request *http.Request, target any) error {
	decoder := json.NewDecoder(io.LimitReader(request.Body, 128<<10))
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
