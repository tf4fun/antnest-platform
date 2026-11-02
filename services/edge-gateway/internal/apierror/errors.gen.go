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
	InvalidRequest             = "invalid_request"
	Unauthenticated            = "unauthenticated"
	Forbidden                  = "forbidden"
	NotFound                   = "not_found"
	Internal                   = "internal"
	MethodNotAllowed           = "method_not_allowed"
	RequestTooLarge            = "request_too_large"
	PrincipalChanged           = "principal_changed"
	CsrfFailed                 = "csrf_failed"
	IdentityUnavailable        = "identity_unavailable"
	ConsoleUnavailable         = "console_unavailable"
	WorkspaceUnavailable       = "workspace_unavailable"
	AgentUnavailable           = "agent_unavailable"
	LoginMethodUnavailable     = "login_method_unavailable"
	LoginRateLimited           = "login_rate_limited"
	InvalidCurrentPassword     = "invalid_current_password"
	ExternalIdentityLastMethod = "external_identity_last_method"
	CredentialBusy             = "credential_busy"
	CredentialRateLimited      = "credential_rate_limited"
)

type Metadata struct {
	Category   string
	HTTPStatus int
	Retryable  bool
}

var metadata = map[string]Metadata{
	InvalidRequest:             {Category: "invalid_request", HTTPStatus: 400, Retryable: false},
	Unauthenticated:            {Category: "unauthenticated", HTTPStatus: 401, Retryable: false},
	Forbidden:                  {Category: "forbidden", HTTPStatus: 403, Retryable: false},
	NotFound:                   {Category: "not_found", HTTPStatus: 404, Retryable: false},
	Internal:                   {Category: "internal", HTTPStatus: 500, Retryable: false},
	MethodNotAllowed:           {Category: "invalid_request", HTTPStatus: 405, Retryable: false},
	RequestTooLarge:            {Category: "invalid_request", HTTPStatus: 413, Retryable: false},
	PrincipalChanged:           {Category: "conflict", HTTPStatus: 409, Retryable: false},
	CsrfFailed:                 {Category: "forbidden", HTTPStatus: 403, Retryable: false},
	IdentityUnavailable:        {Category: "unavailable", HTTPStatus: 503, Retryable: true},
	ConsoleUnavailable:         {Category: "unavailable", HTTPStatus: 503, Retryable: true},
	WorkspaceUnavailable:       {Category: "unavailable", HTTPStatus: 503, Retryable: true},
	AgentUnavailable:           {Category: "unavailable", HTTPStatus: 503, Retryable: true},
	LoginMethodUnavailable:     {Category: "invalid_request", HTTPStatus: 400, Retryable: false},
	LoginRateLimited:           {Category: "rate_limited", HTTPStatus: 429, Retryable: true},
	InvalidCurrentPassword:     {Category: "invalid_request", HTTPStatus: 400, Retryable: false},
	ExternalIdentityLastMethod: {Category: "conflict", HTTPStatus: 409, Retryable: false},
	CredentialBusy:             {Category: "unavailable", HTTPStatus: 503, Retryable: true},
	CredentialRateLimited:      {Category: "rate_limited", HTTPStatus: 429, Retryable: true},
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
