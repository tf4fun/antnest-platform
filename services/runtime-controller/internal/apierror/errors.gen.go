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
	AcpIncarnationConflict        = "acp_incarnation_conflict"
	AcpIncarnationUnverified      = "acp_incarnation_unverified"
	AcpMemberNotAllowed           = "acp_member_not_allowed"
	AcpRegistrationUnavailable    = "acp_registration_unavailable"
	AcpRegistryUnavailable        = "acp_registry_unavailable"
	AgentMutationInProgress       = "agent_mutation_in_progress"
	CallerNotAllowed              = "caller_not_allowed"
	DeadlineExceeded              = "deadline_exceeded"
	IdempotencyKeyRequired        = "idempotency_key_required"
	ImageNotAllowed               = "image_not_allowed"
	ImageNotFound                 = "image_not_found"
	Internal                      = "internal"
	InternalError                 = "internal_error"
	InvalidRequest                = "invalid_request"
	MethodNotAllowed              = "method_not_allowed"
	MutationLockLost              = "mutation_lock_lost"
	ObservationCursorExpired      = "observation_cursor_expired"
	OperationFailed               = "operation_failed"
	OperationNotFound             = "operation_not_found"
	PlatformUnavailable           = "platform_unavailable"
	PreparationNotFound           = "preparation_not_found"
	PreparedSkillSetInvalidated   = "prepared_skill_set_invalidated"
	RequestIdConflict             = "request_id_conflict"
	RequestTooLarge               = "request_too_large"
	RouteNotFound                 = "route_not_found"
	RuntimeCapacityExhausted      = "runtime_capacity_exhausted"
	RuntimeConnectionStale        = "runtime_connection_stale"
	RuntimeConnectionUnavailable  = "runtime_connection_unavailable"
	RuntimeDrift                  = "runtime_drift"
	RuntimeLifecycleConflict      = "runtime_lifecycle_conflict"
	RuntimeNotFound               = "runtime_not_found"
	RuntimeNotReady               = "runtime_not_ready"
	RuntimeRevisionConflict       = "runtime_revision_conflict"
	ServiceUnauthenticated        = "service_unauthenticated"
	SkillCleanupInProgress        = "skill_cleanup_in_progress"
	SkillPreflightUnavailable     = "skill_preflight_unavailable"
	SkillPreparationClosed        = "skill_preparation_closed"
	SkillPreparationUnavailable   = "skill_preparation_unavailable"
	StorageInUse                  = "storage_in_use"
	StorageNotFound               = "storage_not_found"
	StorageOwnershipConflict      = "storage_ownership_conflict"
	TunnelKeyRegistrationRejected = "tunnel_key_registration_rejected"
	TunnelRegistrationUnavailable = "tunnel_registration_unavailable"
	UnsupportedMediaType          = "unsupported_media_type"
)

type Metadata struct {
	Category   string
	HTTPStatus int
	Retryable  bool
}

var metadata = map[string]Metadata{
	AcpIncarnationConflict:        {Category: "conflict", HTTPStatus: 409, Retryable: false},
	AcpIncarnationUnverified:      {Category: "forbidden", HTTPStatus: 403, Retryable: false},
	AcpMemberNotAllowed:           {Category: "forbidden", HTTPStatus: 403, Retryable: false},
	AcpRegistrationUnavailable:    {Category: "unavailable", HTTPStatus: 503, Retryable: true},
	AcpRegistryUnavailable:        {Category: "unavailable", HTTPStatus: 503, Retryable: true},
	AgentMutationInProgress:       {Category: "conflict", HTTPStatus: 409, Retryable: true},
	CallerNotAllowed:              {Category: "forbidden", HTTPStatus: 403, Retryable: false},
	DeadlineExceeded:              {Category: "unavailable", HTTPStatus: 504, Retryable: true},
	IdempotencyKeyRequired:        {Category: "invalid_request", HTTPStatus: 400, Retryable: false},
	ImageNotAllowed:               {Category: "invalid_request", HTTPStatus: 422, Retryable: false},
	ImageNotFound:                 {Category: "not_found", HTTPStatus: 404, Retryable: false},
	Internal:                      {Category: "internal", HTTPStatus: 500, Retryable: false},
	InternalError:                 {Category: "internal", HTTPStatus: 500, Retryable: false},
	InvalidRequest:                {Category: "invalid_request", HTTPStatus: 400, Retryable: false},
	MethodNotAllowed:              {Category: "invalid_request", HTTPStatus: 405, Retryable: false},
	MutationLockLost:              {Category: "unavailable", HTTPStatus: 503, Retryable: true},
	ObservationCursorExpired:      {Category: "not_found", HTTPStatus: 410, Retryable: false},
	OperationFailed:               {Category: "internal", HTTPStatus: 500, Retryable: false},
	OperationNotFound:             {Category: "not_found", HTTPStatus: 404, Retryable: false},
	PlatformUnavailable:           {Category: "unavailable", HTTPStatus: 503, Retryable: true},
	PreparationNotFound:           {Category: "not_found", HTTPStatus: 404, Retryable: false},
	PreparedSkillSetInvalidated:   {Category: "conflict", HTTPStatus: 409, Retryable: false},
	RequestIdConflict:             {Category: "conflict", HTTPStatus: 409, Retryable: false},
	RequestTooLarge:               {Category: "invalid_request", HTTPStatus: 413, Retryable: false},
	RouteNotFound:                 {Category: "not_found", HTTPStatus: 404, Retryable: false},
	RuntimeCapacityExhausted:      {Category: "unavailable", HTTPStatus: 503, Retryable: true},
	RuntimeConnectionStale:        {Category: "conflict", HTTPStatus: 409, Retryable: false},
	RuntimeConnectionUnavailable:  {Category: "unavailable", HTTPStatus: 503, Retryable: true},
	RuntimeDrift:                  {Category: "conflict", HTTPStatus: 409, Retryable: false},
	RuntimeLifecycleConflict:      {Category: "conflict", HTTPStatus: 409, Retryable: false},
	RuntimeNotFound:               {Category: "not_found", HTTPStatus: 404, Retryable: false},
	RuntimeNotReady:               {Category: "internal", HTTPStatus: 500, Retryable: false},
	RuntimeRevisionConflict:       {Category: "conflict", HTTPStatus: 409, Retryable: false},
	ServiceUnauthenticated:        {Category: "unauthenticated", HTTPStatus: 401, Retryable: false},
	SkillCleanupInProgress:        {Category: "unavailable", HTTPStatus: 503, Retryable: true},
	SkillPreflightUnavailable:     {Category: "unavailable", HTTPStatus: 503, Retryable: true},
	SkillPreparationClosed:        {Category: "conflict", HTTPStatus: 409, Retryable: false},
	SkillPreparationUnavailable:   {Category: "unavailable", HTTPStatus: 503, Retryable: true},
	StorageInUse:                  {Category: "conflict", HTTPStatus: 409, Retryable: false},
	StorageNotFound:               {Category: "not_found", HTTPStatus: 404, Retryable: false},
	StorageOwnershipConflict:      {Category: "conflict", HTTPStatus: 409, Retryable: false},
	TunnelKeyRegistrationRejected: {Category: "conflict", HTTPStatus: 409, Retryable: false},
	TunnelRegistrationUnavailable: {Category: "unavailable", HTTPStatus: 503, Retryable: true},
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
