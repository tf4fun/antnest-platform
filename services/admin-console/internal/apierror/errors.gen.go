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
	InvalidRequest                         = "invalid_request"
	Unauthenticated                        = "unauthenticated"
	Forbidden                              = "forbidden"
	NotFound                               = "not_found"
	Internal                               = "internal"
	Conflict                               = "conflict"
	InternalError                          = "internal_error"
	ResourceVersionConflict                = "resource_version_conflict"
	MethodNotAllowed                       = "method_not_allowed"
	PrincipalChanged                       = "principal_changed"
	IdentityUnavailable                    = "identity_unavailable"
	InvalidCurrentPassword                 = "invalid_current_password"
	CredentialBusy                         = "credential_busy"
	CredentialRateLimited                  = "credential_rate_limited"
	InvalidIdempotencyKey                  = "invalid_idempotency_key"
	RuntimeImageRequired                   = "runtime_image_required"
	InvalidArgument                        = "invalid_argument"
	BadRequest                             = "bad_request"
	UnsupportedMediaType                   = "unsupported_media_type"
	LimitExceeded                          = "limit_exceeded"
	EncodingFailed                         = "encoding_failed"
	StreamingUnavailable                   = "streaming_unavailable"
	UpstreamError                          = "upstream_error"
	UpstreamRejected                       = "upstream_rejected"
	InvalidUpstreamResponse                = "invalid_upstream_response"
	DependencyInvalidResponse              = "dependency_invalid_response"
	ProviderDiscoveryFailed                = "provider_discovery_failed"
	DependencyUnavailable                  = "dependency_unavailable"
	ServiceStopping                        = "service_stopping"
	ApplicationUnavailable                 = "application_unavailable"
	AgentInventoryUnavailable              = "agent_inventory_unavailable"
	IdentityDependencyUnavailable          = "identity_dependency_unavailable"
	ProviderEndpointUnavailable            = "provider_endpoint_unavailable"
	CleanupFailed                          = "cleanup_failed"
	Busy                                   = "busy"
	CallerContextRequired                  = "caller_context_required"
	CallerContextInvalid                   = "caller_context_invalid"
	ServiceUnauthenticated                 = "service_unauthenticated"
	CallerNotAllowed                       = "caller_not_allowed"
	OrganizationMismatch                   = "organization_mismatch"
	ActorMismatch                          = "actor_mismatch"
	AccessDenied                           = "access_denied"
	ProviderEndpointForbidden              = "provider_endpoint_forbidden"
	ReferenceNotFound                      = "reference_not_found"
	AgentNotFound                          = "agent_not_found"
	AgentNetworkNotFound                   = "agent_network_not_found"
	PolicyRevisionNotFound                 = "policy_revision_not_found"
	RevisionNotFound                       = "revision_not_found"
	ModelProfileNotFound                   = "model_profile_not_found"
	TemplateNotFound                       = "template_not_found"
	OperationNotFound                      = "operation_not_found"
	ReferenceDisabled                      = "reference_disabled"
	AgentNetworkUnavailable                = "agent_network_unavailable"
	PolicyRevisionConflict                 = "policy_revision_conflict"
	IdempotencyConflict                    = "idempotency_conflict"
	PreparationNotFound                    = "preparation_not_found"
	AuditNotFound                          = "audit_not_found"
	ResourceInUse                          = "resource_in_use"
	RequestIdConflict                      = "request_id_conflict"
	LifecycleConflict                      = "lifecycle_conflict"
	ExecutionConfigurationCapacityExceeded = "execution_configuration_capacity_exceeded"
	ExternalIdentityConflict               = "external_identity_conflict"
	ExternalIdentityRestoreRequired        = "external_identity_restore_required"
	InvalidModelSpec                       = "invalid_model_spec"
	InvalidCursor                          = "invalid_cursor"
	ExecutionAuditUnavailable              = "execution_audit_unavailable"
	InvalidPackage                         = "invalid_package"
	NameConflict                           = "name_conflict"
	ContentChanged                         = "content_changed"
	SourceInvalid                          = "source_invalid"
	TemporarilyUnavailable                 = "temporarily_unavailable"
	SourceUnavailable                      = "source_unavailable"
	Unavailable                            = "unavailable"
	ExternalIdentityLastMethod             = "external_identity_last_method"
	RevisionConflict                       = "revision_conflict"
	RequestConflict                        = "request_conflict"
)

type Metadata struct {
	Category   string
	HTTPStatus int
	Retryable  bool
}

var metadata = map[string]Metadata{
	InvalidRequest:                         {Category: "invalid_request", HTTPStatus: 400, Retryable: false},
	Unauthenticated:                        {Category: "unauthenticated", HTTPStatus: 401, Retryable: false},
	Forbidden:                              {Category: "forbidden", HTTPStatus: 403, Retryable: false},
	NotFound:                               {Category: "not_found", HTTPStatus: 404, Retryable: false},
	Internal:                               {Category: "internal", HTTPStatus: 500, Retryable: false},
	Conflict:                               {Category: "conflict", HTTPStatus: 409, Retryable: false},
	InternalError:                          {Category: "internal", HTTPStatus: 500, Retryable: false},
	ResourceVersionConflict:                {Category: "conflict", HTTPStatus: 409, Retryable: false},
	MethodNotAllowed:                       {Category: "invalid_request", HTTPStatus: 405, Retryable: false},
	PrincipalChanged:                       {Category: "conflict", HTTPStatus: 409, Retryable: false},
	IdentityUnavailable:                    {Category: "unavailable", HTTPStatus: 503, Retryable: true},
	InvalidCurrentPassword:                 {Category: "invalid_request", HTTPStatus: 400, Retryable: false},
	CredentialBusy:                         {Category: "unavailable", HTTPStatus: 503, Retryable: true},
	CredentialRateLimited:                  {Category: "rate_limited", HTTPStatus: 429, Retryable: true},
	InvalidIdempotencyKey:                  {Category: "invalid_request", HTTPStatus: 400, Retryable: false},
	RuntimeImageRequired:                   {Category: "invalid_request", HTTPStatus: 400, Retryable: false},
	InvalidArgument:                        {Category: "invalid_request", HTTPStatus: 400, Retryable: false},
	BadRequest:                             {Category: "invalid_request", HTTPStatus: 400, Retryable: false},
	UnsupportedMediaType:                   {Category: "invalid_request", HTTPStatus: 415, Retryable: false},
	LimitExceeded:                          {Category: "invalid_request", HTTPStatus: 413, Retryable: false},
	EncodingFailed:                         {Category: "internal", HTTPStatus: 500, Retryable: false},
	StreamingUnavailable:                   {Category: "internal", HTTPStatus: 500, Retryable: false},
	UpstreamError:                          {Category: "internal", HTTPStatus: 502, Retryable: false},
	UpstreamRejected:                       {Category: "internal", HTTPStatus: 502, Retryable: false},
	InvalidUpstreamResponse:                {Category: "unavailable", HTTPStatus: 502, Retryable: true},
	DependencyInvalidResponse:              {Category: "unavailable", HTTPStatus: 502, Retryable: true},
	ProviderDiscoveryFailed:                {Category: "unavailable", HTTPStatus: 502, Retryable: true},
	DependencyUnavailable:                  {Category: "unavailable", HTTPStatus: 503, Retryable: true},
	ServiceStopping:                        {Category: "unavailable", HTTPStatus: 503, Retryable: true},
	ApplicationUnavailable:                 {Category: "unavailable", HTTPStatus: 503, Retryable: true},
	AgentInventoryUnavailable:              {Category: "unavailable", HTTPStatus: 503, Retryable: true},
	IdentityDependencyUnavailable:          {Category: "unavailable", HTTPStatus: 503, Retryable: true},
	ProviderEndpointUnavailable:            {Category: "unavailable", HTTPStatus: 503, Retryable: true},
	CleanupFailed:                          {Category: "unavailable", HTTPStatus: 503, Retryable: true},
	Busy:                                   {Category: "rate_limited", HTTPStatus: 429, Retryable: true},
	CallerContextRequired:                  {Category: "unauthenticated", HTTPStatus: 401, Retryable: false},
	CallerContextInvalid:                   {Category: "unauthenticated", HTTPStatus: 401, Retryable: false},
	ServiceUnauthenticated:                 {Category: "unauthenticated", HTTPStatus: 401, Retryable: false},
	CallerNotAllowed:                       {Category: "forbidden", HTTPStatus: 403, Retryable: false},
	OrganizationMismatch:                   {Category: "forbidden", HTTPStatus: 403, Retryable: false},
	ActorMismatch:                          {Category: "forbidden", HTTPStatus: 403, Retryable: false},
	AccessDenied:                           {Category: "forbidden", HTTPStatus: 403, Retryable: false},
	ProviderEndpointForbidden:              {Category: "forbidden", HTTPStatus: 422, Retryable: false},
	ReferenceNotFound:                      {Category: "not_found", HTTPStatus: 404, Retryable: false},
	AgentNotFound:                          {Category: "not_found", HTTPStatus: 404, Retryable: false},
	AgentNetworkNotFound:                   {Category: "not_found", HTTPStatus: 404, Retryable: false},
	PolicyRevisionNotFound:                 {Category: "not_found", HTTPStatus: 404, Retryable: false},
	RevisionNotFound:                       {Category: "not_found", HTTPStatus: 404, Retryable: false},
	ModelProfileNotFound:                   {Category: "not_found", HTTPStatus: 404, Retryable: false},
	TemplateNotFound:                       {Category: "not_found", HTTPStatus: 404, Retryable: false},
	OperationNotFound:                      {Category: "not_found", HTTPStatus: 404, Retryable: false},
	ReferenceDisabled:                      {Category: "conflict", HTTPStatus: 409, Retryable: false},
	AgentNetworkUnavailable:                {Category: "conflict", HTTPStatus: 409, Retryable: false},
	PolicyRevisionConflict:                 {Category: "conflict", HTTPStatus: 409, Retryable: false},
	IdempotencyConflict:                    {Category: "conflict", HTTPStatus: 409, Retryable: false},
	PreparationNotFound:                    {Category: "not_found", HTTPStatus: 404, Retryable: false},
	AuditNotFound:                          {Category: "not_found", HTTPStatus: 404, Retryable: false},
	ResourceInUse:                          {Category: "conflict", HTTPStatus: 409, Retryable: false},
	RequestIdConflict:                      {Category: "conflict", HTTPStatus: 409, Retryable: false},
	LifecycleConflict:                      {Category: "conflict", HTTPStatus: 409, Retryable: false},
	ExecutionConfigurationCapacityExceeded: {Category: "conflict", HTTPStatus: 409, Retryable: false},
	ExternalIdentityConflict:               {Category: "conflict", HTTPStatus: 409, Retryable: false},
	ExternalIdentityRestoreRequired:        {Category: "conflict", HTTPStatus: 409, Retryable: false},
	InvalidModelSpec:                       {Category: "invalid_request", HTTPStatus: 400, Retryable: false},
	InvalidCursor:                          {Category: "invalid_request", HTTPStatus: 400, Retryable: false},
	ExecutionAuditUnavailable:              {Category: "unavailable", HTTPStatus: 503, Retryable: true},
	InvalidPackage:                         {Category: "invalid_request", HTTPStatus: 400, Retryable: false},
	NameConflict:                           {Category: "conflict", HTTPStatus: 409, Retryable: false},
	ContentChanged:                         {Category: "conflict", HTTPStatus: 409, Retryable: false},
	SourceInvalid:                          {Category: "unavailable", HTTPStatus: 502, Retryable: true},
	TemporarilyUnavailable:                 {Category: "unavailable", HTTPStatus: 503, Retryable: true},
	SourceUnavailable:                      {Category: "unavailable", HTTPStatus: 503, Retryable: true},
	Unavailable:                            {Category: "unavailable", HTTPStatus: 503, Retryable: true},
	ExternalIdentityLastMethod:             {Category: "conflict", HTTPStatus: 409, Retryable: false},
	RevisionConflict:                       {Category: "conflict", HTTPStatus: 409, Retryable: false},
	RequestConflict:                        {Category: "conflict", HTTPStatus: 409, Retryable: false},
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
