package server

import (
	"bufio"
	"encoding/json"
	"net"
	"net/http"
)

// The existing HTTP response adapter retains its error until dispatch returns.
type adapterResponse struct {
	http.ResponseWriter
	err error
}

func (w *adapterResponse) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func (w *adapterResponse) Flush()                      { _ = http.NewResponseController(w.ResponseWriter).Flush() }
func (w *adapterResponse) FlushError() error {
	return http.NewResponseController(w.ResponseWriter).Flush()
}
func (w *adapterResponse) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	return http.NewResponseController(w.ResponseWriter).Hijack()
}
func (w *adapterResponse) fail(err error) {
	if w.err == nil {
		w.err = err
	}
}

type adapterFailure struct {
	status        int
	code, message string
	cause         error
}

func (f *adapterFailure) Error() string       { return f.message }
func (f *adapterFailure) Unwrap() error       { return f.cause }
func (f *adapterFailure) SafeCode() string    { return safeErrorCode(f.code) }
func (f *adapterFailure) SafeMessage() string { return f.message }
func (f *adapterFailure) HTTPStatus() int     { return f.status }

func retainFailure(response http.ResponseWriter, err error) {
	if target, ok := response.(interface{ fail(error) }); ok {
		target.fail(err)
	}
}

func writeFailure(response http.ResponseWriter, status int, code, message string, cause error) {
	retainFailure(response, &adapterFailure{status: status, code: code, message: message, cause: cause})
	response.Header().Set("Cache-Control", "no-store")
	writeJSON(response, status, map[string]string{"code": code, "message": message})
}

func safeErrorCode(code string) string {
	switch code {
	case "invalid_request", "invalid_idempotency_key", "unauthenticated", "forbidden", "not_found", "method_not_allowed", "invalid_current_password", "runtime_image_required", "principal_changed",
		"encoding_failed", "invalid_upstream_response", "dependency_unavailable", "dependency_invalid_response", "internal_error", "service_stopping", "streaming_unavailable", "application_unavailable", "upstream_rejected", "agent_inventory_unavailable",
		"provider_endpoint_forbidden", "provider_endpoint_unavailable", "provider_discovery_failed",
		"organization_mismatch", "actor_mismatch", "reference_not_found", "reference_disabled",
		"agent_not_found", "agent_network_not_found", "policy_revision_not_found", "resource_version_conflict", "agent_network_unavailable", "cleanup_failed", "conflict", "idempotency_conflict", "revision_not_found", "model_profile_not_found", "template_not_found", "operation_not_found":
		return code
	default:
		return "upstream_error"
	}
}

func protocolFailure(body []byte) error {
	var envelope struct {
		Code  string `json:"code"`
		Error *struct {
			Code json.RawMessage `json:"code"`
		} `json:"error"`
		IsError bool `json:"isError"`
	}
	if json.Unmarshal(body, &envelope) != nil {
		return nil
	}
	if envelope.Code == "" && envelope.Error == nil && !envelope.IsError {
		return nil
	}
	return &adapterFailure{status: 500, code: safeErrorCode(envelope.Code), message: "Upstream protocol returned a failure"}
}
