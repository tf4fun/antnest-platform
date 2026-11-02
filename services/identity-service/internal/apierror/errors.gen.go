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
	ActorMismatch                   = "actor_mismatch"
	BadRequest                      = "bad_request"
	CallerContextInvalid            = "caller_context_invalid"
	CallerContextRequired           = "caller_context_required"
	CallerNotAllowed                = "caller_not_allowed"
	Conflict                        = "conflict"
	CredentialBusy                  = "credential_busy"
	CredentialRateLimited           = "credential_rate_limited"
	ExternalIdentityConflict        = "external_identity_conflict"
	ExternalIdentityLastMethod      = "external_identity_last_method"
	ExternalIdentityRestoreRequired = "external_identity_restore_required"
	Forbidden                       = "forbidden"
	IdentityDependencyUnavailable   = "identity_dependency_unavailable"
	InactivePrincipal               = "inactive_principal"
	Internal                        = "internal"
	InternalError                   = "internal_error"
	InvalidArgument                 = "invalid_argument"
	InvalidCurrentPassword          = "invalid_current_password"
	InvalidReference                = "invalid_reference"
	InvalidRequest                  = "invalid_request"
	LastOrganizationAdmin           = "last_organization_admin"
	NotFound                        = "not_found"
	OidcAuthorizationFailed         = "oidc_authorization_failed"
	OidcCompletedTokenUnavailable   = "oidc_completed_token_unavailable"
	OidcExchangeClaimInvalid        = "oidc_exchange_claim_invalid"
	OidcExchangeFailed              = "oidc_exchange_failed"
	OidcExchangeInProgress          = "oidc_exchange_in_progress"
	OidcIdentityFailed              = "oidc_identity_failed"
	OidcMembershipRequired          = "oidc_membership_required"
	OidcPersistenceFailed           = "oidc_persistence_failed"
	OidcProviderChanged             = "oidc_provider_changed"
	OidcProviderClientIdImmutable   = "oidc_provider_client_id_immutable"
	OidcProviderFailed              = "oidc_provider_failed"
	OidcProviderIssuerImmutable     = "oidc_provider_issuer_immutable"
	OidcProviderSecretFailed        = "oidc_provider_secret_failed"
	OidcSessionExpired              = "oidc_session_expired"
	OidcSessionFailed               = "oidc_session_failed"
	OidcTokenFailed                 = "oidc_token_failed"
	PreconditionFailed              = "precondition_failed"
	RateLimited                     = "rate_limited"
	ServiceUnauthenticated          = "service_unauthenticated"
	Unauthenticated                 = "unauthenticated"
	Unavailable                     = "unavailable"
	UnsupportedMediaType            = "unsupported_media_type"
	VersionConflict                 = "version_conflict"
)

type Metadata struct {
	Category   string
	HTTPStatus int
	Retryable  bool
}

var metadata = map[string]Metadata{
	ActorMismatch:                   {Category: "forbidden", HTTPStatus: 403, Retryable: false},
	BadRequest:                      {Category: "invalid_request", HTTPStatus: 400, Retryable: false},
	CallerContextInvalid:            {Category: "unauthenticated", HTTPStatus: 401, Retryable: false},
	CallerContextRequired:           {Category: "unauthenticated", HTTPStatus: 401, Retryable: false},
	CallerNotAllowed:                {Category: "forbidden", HTTPStatus: 403, Retryable: false},
	Conflict:                        {Category: "conflict", HTTPStatus: 409, Retryable: false},
	CredentialBusy:                  {Category: "unavailable", HTTPStatus: 503, Retryable: true},
	CredentialRateLimited:           {Category: "rate_limited", HTTPStatus: 429, Retryable: true},
	ExternalIdentityConflict:        {Category: "conflict", HTTPStatus: 409, Retryable: false},
	ExternalIdentityLastMethod:      {Category: "conflict", HTTPStatus: 409, Retryable: false},
	ExternalIdentityRestoreRequired: {Category: "conflict", HTTPStatus: 409, Retryable: false},
	Forbidden:                       {Category: "forbidden", HTTPStatus: 403, Retryable: false},
	IdentityDependencyUnavailable:   {Category: "unavailable", HTTPStatus: 503, Retryable: true},
	InactivePrincipal:               {Category: "forbidden", HTTPStatus: 403, Retryable: false},
	Internal:                        {Category: "internal", HTTPStatus: 500, Retryable: false},
	InternalError:                   {Category: "internal", HTTPStatus: 500, Retryable: false},
	InvalidArgument:                 {Category: "invalid_request", HTTPStatus: 400, Retryable: false},
	InvalidCurrentPassword:          {Category: "invalid_request", HTTPStatus: 400, Retryable: false},
	InvalidReference:                {Category: "invalid_request", HTTPStatus: 400, Retryable: false},
	InvalidRequest:                  {Category: "invalid_request", HTTPStatus: 400, Retryable: false},
	LastOrganizationAdmin:           {Category: "conflict", HTTPStatus: 409, Retryable: false},
	NotFound:                        {Category: "not_found", HTTPStatus: 404, Retryable: false},
	OidcAuthorizationFailed:         {Category: "invalid_request", HTTPStatus: 400, Retryable: false},
	OidcCompletedTokenUnavailable:   {Category: "not_found", HTTPStatus: 410, Retryable: false},
	OidcExchangeClaimInvalid:        {Category: "invalid_request", HTTPStatus: 400, Retryable: false},
	OidcExchangeFailed:              {Category: "internal", HTTPStatus: 500, Retryable: false},
	OidcExchangeInProgress:          {Category: "conflict", HTTPStatus: 409, Retryable: false},
	OidcIdentityFailed:              {Category: "internal", HTTPStatus: 500, Retryable: false},
	OidcMembershipRequired:          {Category: "forbidden", HTTPStatus: 403, Retryable: false},
	OidcPersistenceFailed:           {Category: "internal", HTTPStatus: 500, Retryable: false},
	OidcProviderChanged:             {Category: "conflict", HTTPStatus: 409, Retryable: false},
	OidcProviderClientIdImmutable:   {Category: "conflict", HTTPStatus: 409, Retryable: false},
	OidcProviderFailed:              {Category: "internal", HTTPStatus: 500, Retryable: false},
	OidcProviderIssuerImmutable:     {Category: "conflict", HTTPStatus: 409, Retryable: false},
	OidcProviderSecretFailed:        {Category: "internal", HTTPStatus: 500, Retryable: false},
	OidcSessionExpired:              {Category: "not_found", HTTPStatus: 410, Retryable: false},
	OidcSessionFailed:               {Category: "invalid_request", HTTPStatus: 400, Retryable: false},
	OidcTokenFailed:                 {Category: "internal", HTTPStatus: 500, Retryable: false},
	PreconditionFailed:              {Category: "precondition_failed", HTTPStatus: 412, Retryable: false},
	RateLimited:                     {Category: "rate_limited", HTTPStatus: 429, Retryable: true},
	ServiceUnauthenticated:          {Category: "unauthenticated", HTTPStatus: 401, Retryable: false},
	Unauthenticated:                 {Category: "unauthenticated", HTTPStatus: 401, Retryable: false},
	Unavailable:                     {Category: "unavailable", HTTPStatus: 503, Retryable: true},
	UnsupportedMediaType:            {Category: "invalid_request", HTTPStatus: 415, Retryable: false},
	VersionConflict:                 {Category: "conflict", HTTPStatus: 409, Retryable: false},
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
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '.' || c == '_' || c == ':' || c == '-') {
			return false
		}
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
