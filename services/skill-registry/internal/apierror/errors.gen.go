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
	ActorMismatch                 = "actor_mismatch"
	Busy                          = "busy"
	CallerContextInvalid          = "caller_context_invalid"
	CallerContextRequired         = "caller_context_required"
	CallerNotAllowed              = "caller_not_allowed"
	ContentChanged                = "content_changed"
	Forbidden                     = "forbidden"
	IdentityDependencyUnavailable = "identity_dependency_unavailable"
	Internal                      = "internal"
	InvalidPackage                = "invalid_package"
	InvalidRequest                = "invalid_request"
	LimitExceeded                 = "limit_exceeded"
	NameConflict                  = "name_conflict"
	NotFound                      = "not_found"
	OrganizationMismatch          = "organization_mismatch"
	RequestConflict               = "request_conflict"
	RevisionConflict              = "revision_conflict"
	ServiceUnauthenticated        = "service_unauthenticated"
	SourceInvalid                 = "source_invalid"
	SourceUnavailable             = "source_unavailable"
	TemporarilyUnavailable        = "temporarily_unavailable"
	UnsupportedMediaType          = "unsupported_media_type"
)

type Metadata struct {
	Category   string
	HTTPStatus int
	Retryable  bool
}

var metadata = map[string]Metadata{
	ActorMismatch:                 {Category: "forbidden", HTTPStatus: 403, Retryable: false},
	Busy:                          {Category: "rate_limited", HTTPStatus: 429, Retryable: true},
	CallerContextInvalid:          {Category: "unauthenticated", HTTPStatus: 401, Retryable: false},
	CallerContextRequired:         {Category: "unauthenticated", HTTPStatus: 401, Retryable: false},
	CallerNotAllowed:              {Category: "forbidden", HTTPStatus: 403, Retryable: false},
	ContentChanged:                {Category: "conflict", HTTPStatus: 409, Retryable: false},
	Forbidden:                     {Category: "forbidden", HTTPStatus: 403, Retryable: false},
	IdentityDependencyUnavailable: {Category: "unavailable", HTTPStatus: 503, Retryable: true},
	Internal:                      {Category: "internal", HTTPStatus: 500, Retryable: false},
	InvalidPackage:                {Category: "invalid_request", HTTPStatus: 400, Retryable: false},
	InvalidRequest:                {Category: "invalid_request", HTTPStatus: 400, Retryable: false},
	LimitExceeded:                 {Category: "invalid_request", HTTPStatus: 413, Retryable: false},
	NameConflict:                  {Category: "conflict", HTTPStatus: 409, Retryable: false},
	NotFound:                      {Category: "not_found", HTTPStatus: 404, Retryable: false},
	OrganizationMismatch:          {Category: "forbidden", HTTPStatus: 403, Retryable: false},
	RequestConflict:               {Category: "conflict", HTTPStatus: 409, Retryable: false},
	RevisionConflict:              {Category: "conflict", HTTPStatus: 409, Retryable: false},
	ServiceUnauthenticated:        {Category: "unauthenticated", HTTPStatus: 401, Retryable: false},
	SourceInvalid:                 {Category: "unavailable", HTTPStatus: 502, Retryable: true},
	SourceUnavailable:             {Category: "unavailable", HTTPStatus: 503, Retryable: true},
	TemporarilyUnavailable:        {Category: "unavailable", HTTPStatus: 503, Retryable: true},
	UnsupportedMediaType:          {Category: "invalid_request", HTTPStatus: 415, Retryable: false},
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
