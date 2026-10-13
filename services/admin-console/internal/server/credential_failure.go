package server

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
	"github.com/tf4fun/antnest-platform/services/admin-console/internal/upstream"
)

type createUserFailure struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable *bool  `json:"retryable,omitempty"`
}

// Only user creation consumes Identity's password admission metadata. Do not
// extend the generic proxy's header allowlist or retry a credential mutation.
func (h *handler) forwardCreateLocalUser(response http.ResponseWriter, request *http.Request, payload any) {
	body, err := json.Marshal(payload)
	if err != nil {
		writeError(response, http.StatusInternalServerError, "encoding_failed", "Request could not be encoded")
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), h.requestTimeout)
	defer cancel()
	result, err := h.fetchBuffered(ctx, upstream.Identity, http.MethodPost, "/rpc/identity/create-local-user", "", body)
	if err != nil {
		// Keep cancellation and timeout classification in the safe telemetry
		// boundary while the public response remains independent of the cause.
		writeFailure(response, http.StatusServiceUnavailable, "identity_unavailable", "Identity Service is unavailable", err)
		return
	}
	if successful(result.status) {
		if !validCreateUserSuccess(result.body) {
			writeCreateUserUnavailable(response)
			return
		}
		h.writeProjected(response, request, upstream.Identity, result, projectDirectoryMember)
		return
	}
	var failure createUserFailure
	if serviceauth.DecodeObject(result.body, &failure) != nil {
		writeCreateUserUnavailable(response)
		return
	}
	if failure.Code == "credential_busy" {
		if result.status != http.StatusServiceUnavailable || failure.Message != "Password verification is busy" ||
			failure.Retryable == nil || !*failure.Retryable || !validCreateUserRetryAfter(result.header) {
			writeCreateUserUnavailable(response)
			return
		}
		response.Header().Set("Retry-After", "1")
	} else {
		legacy, ok := createUserLegacyFailures[failure.Code]
		if !ok || result.status != legacy.status ||
			(failure.Retryable != nil && *failure.Retryable != legacy.retryable) {
			writeCreateUserUnavailable(response)
			return
		}
		// Preserve known error semantics, never arbitrary upstream messages.
		failure.Message = legacy.message
	}
	retainFailure(response, &adapterFailure{status: result.status, code: failure.Code, message: failure.Message})
	response.Header().Set("Cache-Control", "no-store")
	writeJSON(response, result.status, failure)
}

func validCreateUserSuccess(body []byte) bool {
	var fields map[string]json.RawMessage
	if serviceauth.DecodeObject(body, &fields) != nil {
		return false
	}
	for name := range fields {
		if strings.EqualFold(name, "code") || strings.EqualFold(name, "message") || strings.EqualFold(name, "retryable") {
			return false
		}
	}
	return true
}

func validCreateUserRetryAfter(header http.Header) bool {
	var values []string
	for name, entries := range header {
		if strings.EqualFold(name, "Retry-After") {
			values = append(values, entries...)
		}
	}
	return len(values) == 1 && values[0] == "1"
}

func writeCreateUserUnavailable(response http.ResponseWriter) {
	// Parser, transport and upstream details may contain the submitted password.
	writeError(response, http.StatusServiceUnavailable, "identity_unavailable", "Identity Service is unavailable")
}

var createUserLegacyFailures = map[string]struct {
	status    int
	message   string
	retryable bool
}{
	"invalid_argument":                {400, "The request contains an invalid argument", false},
	"bad_request":                     {400, "Identity request is invalid", false},
	"forbidden":                       {403, "The principal is not allowed to perform this operation", false},
	"not_found":                       {404, "The requested identity resource does not exist", false},
	"conflict":                        {409, "The identity resource conflicts with an existing resource", false},
	"caller_context_required":         {401, "Caller context is required", false},
	"caller_context_invalid":          {401, "Caller context verification failed", false},
	"service_unauthenticated":         {401, "Service authentication rejected", false},
	"caller_not_allowed":              {403, "Service caller is not allowed", false},
	"actor_mismatch":                  {403, "Actor does not match caller context", false},
	"unsupported_media_type":          {415, "Identity request content type is invalid", false},
	"internal_error":                  {500, "Identity Service could not complete the request", true},
	"identity_dependency_unavailable": {503, "Identity authorization dependency is unavailable", true},
}
