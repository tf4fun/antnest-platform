package apierror

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strconv"
	"time"
)

const (
	AccessDenied                           = "access_denied"
	ActorMismatch                          = "actor_mismatch"
	AgentNetworkNotFound                   = "agent_network_not_found"
	AgentNetworkUnavailable                = "agent_network_unavailable"
	AgentNotFound                          = "agent_not_found"
	AgentNotReady                          = "agent_not_ready"
	CallerContextInvalid                   = "caller_context_invalid"
	CallerContextRequired                  = "caller_context_required"
	CallerNotAllowed                       = "caller_not_allowed"
	CleanupFailed                          = "cleanup_failed"
	ConfigurationConflict                  = "configuration_conflict"
	DependencyInvalidResponse              = "dependency_invalid_response"
	DependencyUnavailable                  = "dependency_unavailable"
	ExecutionConfigurationCapacityExceeded = "execution_configuration_capacity_exceeded"
	Forbidden                              = "forbidden"
	IdentityDependencyUnavailable          = "identity_dependency_unavailable"
	Internal                               = "internal"
	InternalError                          = "internal_error"
	InvalidRequest                         = "invalid_request"
	LifecycleConflict                      = "lifecycle_conflict"
	LifecycleTimeout                       = "lifecycle_timeout"
	NotFound                               = "not_found"
	OperationNotFound                      = "operation_not_found"
	OrganizationMismatch                   = "organization_mismatch"
	PolicyRevisionConflict                 = "policy_revision_conflict"
	PolicyRevisionNotFound                 = "policy_revision_not_found"
	PreparationNotFound                    = "preparation_not_found"
	ProviderDiscoveryFailed                = "provider_discovery_failed"
	ProviderEndpointForbidden              = "provider_endpoint_forbidden"
	ProviderEndpointUnavailable            = "provider_endpoint_unavailable"
	ReferenceDisabled                      = "reference_disabled"
	ReferenceNotFound                      = "reference_not_found"
	RequestIdConflict                      = "request_id_conflict"
	RequestTooLarge                        = "request_too_large"
	ResourceInUse                          = "resource_in_use"
	ResourceVersionConflict                = "resource_version_conflict"
	RuntimeImageInvalid                    = "runtime_image_invalid"
	ServiceUnauthenticated                 = "service_unauthenticated"
	UnsupportedMediaType                   = "unsupported_media_type"
)

type Metadata struct {
	Category   string
	HTTPStatus int
	Retryable  bool
}

var metadata = map[string]Metadata{
	AccessDenied:                           {Category: "forbidden", HTTPStatus: 403, Retryable: false},
	ActorMismatch:                          {Category: "forbidden", HTTPStatus: 403, Retryable: false},
	AgentNetworkNotFound:                   {Category: "not_found", HTTPStatus: 404, Retryable: false},
	AgentNetworkUnavailable:                {Category: "conflict", HTTPStatus: 409, Retryable: false},
	AgentNotFound:                          {Category: "not_found", HTTPStatus: 404, Retryable: false},
	AgentNotReady:                          {Category: "conflict", HTTPStatus: 409, Retryable: true},
	CallerContextInvalid:                   {Category: "unauthenticated", HTTPStatus: 401, Retryable: false},
	CallerContextRequired:                  {Category: "unauthenticated", HTTPStatus: 401, Retryable: false},
	CallerNotAllowed:                       {Category: "forbidden", HTTPStatus: 403, Retryable: false},
	CleanupFailed:                          {Category: "unavailable", HTTPStatus: 503, Retryable: true},
	ConfigurationConflict:                  {Category: "conflict", HTTPStatus: 409, Retryable: false},
	DependencyInvalidResponse:              {Category: "unavailable", HTTPStatus: 502, Retryable: true},
	DependencyUnavailable:                  {Category: "unavailable", HTTPStatus: 503, Retryable: true},
	ExecutionConfigurationCapacityExceeded: {Category: "conflict", HTTPStatus: 409, Retryable: false},
	Forbidden:                              {Category: "forbidden", HTTPStatus: 403, Retryable: false},
	IdentityDependencyUnavailable:          {Category: "unavailable", HTTPStatus: 503, Retryable: true},
	Internal:                               {Category: "internal", HTTPStatus: 500, Retryable: false},
	InternalError:                          {Category: "internal", HTTPStatus: 500, Retryable: false},
	InvalidRequest:                         {Category: "invalid_request", HTTPStatus: 400, Retryable: false},
	LifecycleConflict:                      {Category: "conflict", HTTPStatus: 409, Retryable: false},
	LifecycleTimeout:                       {Category: "unavailable", HTTPStatus: 504, Retryable: true},
	NotFound:                               {Category: "not_found", HTTPStatus: 404, Retryable: false},
	OperationNotFound:                      {Category: "not_found", HTTPStatus: 404, Retryable: false},
	OrganizationMismatch:                   {Category: "forbidden", HTTPStatus: 403, Retryable: false},
	PolicyRevisionConflict:                 {Category: "conflict", HTTPStatus: 409, Retryable: false},
	PolicyRevisionNotFound:                 {Category: "not_found", HTTPStatus: 404, Retryable: false},
	PreparationNotFound:                    {Category: "not_found", HTTPStatus: 404, Retryable: false},
	ProviderDiscoveryFailed:                {Category: "unavailable", HTTPStatus: 502, Retryable: true},
	ProviderEndpointForbidden:              {Category: "forbidden", HTTPStatus: 422, Retryable: false},
	ProviderEndpointUnavailable:            {Category: "unavailable", HTTPStatus: 503, Retryable: true},
	ReferenceDisabled:                      {Category: "conflict", HTTPStatus: 409, Retryable: false},
	ReferenceNotFound:                      {Category: "not_found", HTTPStatus: 404, Retryable: false},
	RequestIdConflict:                      {Category: "conflict", HTTPStatus: 409, Retryable: false},
	RequestTooLarge:                        {Category: "invalid_request", HTTPStatus: 413, Retryable: false},
	ResourceInUse:                          {Category: "conflict", HTTPStatus: 409, Retryable: false},
	ResourceVersionConflict:                {Category: "conflict", HTTPStatus: 409, Retryable: false},
	RuntimeImageInvalid:                    {Category: "invalid_request", HTTPStatus: 400, Retryable: false},
	ServiceUnauthenticated:                 {Category: "unauthenticated", HTTPStatus: 401, Retryable: false},
	UnsupportedMediaType:                   {Category: "invalid_request", HTTPStatus: 415, Retryable: false},
}

type Error struct {
	Code      string         `json:"code"`
	Category  string         `json:"category"`
	Message   string         `json:"message"`
	Retryable bool           `json:"retryable"`
	RequestID string         `json:"request_id"`
	Details   map[string]any `json:"details,omitempty"`
}

func New(code, message, requestID string) Error {
	meta, ok := metadata[code]
	if !ok {
		code = Internal
		meta = metadata[Internal]
		message = "Internal service error"
	}
	if !validRequestID(requestID) {
		requestID = randomRequestID()
	}
	return Error{
		Code:      code,
		Category:  meta.Category,
		Message:   message,
		Retryable: meta.Retryable,
		RequestID: requestID,
	}
}

func WriteError(w http.ResponseWriter, status int, code, message string, retryable bool) {
	requestID := w.Header().Get("X-Request-ID")
	if !validRequestID(requestID) {
		requestID = randomRequestID()
		w.Header().Set("X-Request-ID", requestID)
	}
	envelope := New(code, message, requestID)
	if _, ok := metadata[code]; ok {
		envelope.Retryable = retryable
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(envelope)
}

func validRequestID(requestID string) bool {
	if requestID == "" || len(requestID) > 128 {
		return false
	}
	for i := 0; i < len(requestID); i++ {
		c := requestID[i]
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '.' || c == '_' || c == ':' || c == '-' {
			continue
		}
		return false
	}
	return true
}

func randomRequestID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err == nil {
		return hex.EncodeToString(b[:])
	}
	return "req-" + strconv.FormatInt(time.Now().UnixNano(), 16)
}
