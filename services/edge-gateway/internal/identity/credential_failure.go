package identity

import (
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
)

// PasswordFailure is the validated public projection of password admission.
type PasswordFailure struct {
	StatusCode int
	Code       string
	Message    string
	RetryAfter string
}

// PasswordAdmissionFailure only accepts failures validated by the password RPC
// client. A RemoteError with the same code does not carry trusted retry metadata.
func PasswordAdmissionFailure(err error) (PasswordFailure, bool) {
	var failure *passwordAdmissionError
	if !errors.As(err, &failure) {
		return PasswordFailure{}, false
	}
	return failure.public, true
}

type passwordAdmissionError struct{ public PasswordFailure }

func (err *passwordAdmissionError) Error() string {
	return "identity password admission: " + err.public.Code
}

func passwordRPC(path string) bool {
	return path == "/rpc/identity/local-login" || path == "/rpc/identity/change-local-password"
}

func invalidPasswordFailure() error {
	// Decoder errors, upstream messages and header values can contain secrets.
	return errors.New("identity returned invalid password failure metadata")
}

func validPasswordSuccess(payload []byte) bool {
	var fields map[string]json.RawMessage
	if serviceauth.DecodeObject(payload, &fields) != nil {
		return false
	}
	// A 2xx response cannot both grant credentials and report a failure. Check
	// reserved failure fields before the success decoder can ignore them.
	for name := range fields {
		if strings.EqualFold(name, "code") || strings.EqualFold(name, "message") || strings.EqualFold(name, "retryable") || strings.EqualFold(name, "category") || strings.EqualFold(name, "request_id") {
			return false
		}
	}
	return true
}

var passwordFailureRequestID = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`)

var passwordFailureCategories = map[string]string{
	"credential_busy":          "unavailable",
	"credential_rate_limited":  "rate_limited",
	"invalid_current_password": "invalid_request",
	"invalid_argument":         "invalid_request",
	"bad_request":              "invalid_request",
	"unauthenticated":          "unauthenticated",
	"caller_context_invalid":   "unauthenticated",
	"caller_context_required":  "unauthenticated",
	"inactive_principal":       "forbidden",
	"forbidden":                "forbidden",
}

func decodePasswordFailure(status int, header http.Header, payload []byte) error {
	var wire struct {
		Code      string          `json:"code"`
		Message   string          `json:"message"`
		Retryable *bool           `json:"retryable"`
		Category  json.RawMessage `json:"category"`
		RequestID json.RawMessage `json:"request_id"`
		Details   json.RawMessage `json:"details"`
	}
	if serviceauth.DecodeObject(payload, &wire) != nil {
		return invalidPasswordFailure()
	}
	var category string
	hasMetadata := len(wire.Category) != 0 || len(wire.RequestID) != 0 || len(wire.Details) != 0
	if hasMetadata {
		var requestID string
		if len(wire.Category) == 0 || len(wire.RequestID) == 0 ||
			json.Unmarshal(wire.Category, &category) != nil ||
			json.Unmarshal(wire.RequestID, &requestID) != nil ||
			category == "" || !passwordFailureRequestID.MatchString(requestID) {
			return invalidPasswordFailure()
		}
		if len(wire.Details) != 0 {
			var details map[string]any
			if json.Unmarshal(wire.Details, &details) != nil || details == nil {
				return invalidPasswordFailure()
			}
		}
	}
	var expectedStatus int
	var expectedMessage string
	var expectedCategory string
	switch wire.Code {
	case "credential_busy":
		expectedStatus, expectedMessage, expectedCategory = http.StatusServiceUnavailable, "Password verification is busy", "unavailable"
	case "credential_rate_limited":
		expectedStatus, expectedMessage, expectedCategory = http.StatusTooManyRequests, "Too many password attempts", "rate_limited"
	default:
		// Invalid admission envelopes must never fall back to an old auth error.
		if status == http.StatusTooManyRequests || status == http.StatusServiceUnavailable {
			return invalidPasswordFailure()
		}
		switch wire.Code {
		case "invalid_current_password", "invalid_argument", "bad_request", "unauthenticated", "inactive_principal", "forbidden", "caller_context_invalid", "caller_context_required":
			if hasMetadata && category != passwordFailureCategories[wire.Code] {
				return invalidPasswordFailure()
			}
			return &RemoteError{StatusCode: status, Code: wire.Code}
		default:
			return invalidPasswordFailure()
		}
	}
	if status != expectedStatus || wire.Message != expectedMessage || wire.Retryable == nil || !*wire.Retryable {
		return invalidPasswordFailure()
	}
	if hasMetadata && category != expectedCategory {
		return invalidPasswordFailure()
	}
	var values []string
	for key, entries := range header {
		if strings.EqualFold(key, "Retry-After") {
			values = append(values, entries...)
		}
	}
	if len(values) != 1 {
		return invalidPasswordFailure()
	}
	seconds, err := strconv.Atoi(values[0])
	if err != nil || seconds < 1 || seconds > 900 || strconv.Itoa(seconds) != values[0] ||
		(wire.Code == "credential_busy" && seconds != 1) {
		return invalidPasswordFailure()
	}
	return &passwordAdmissionError{public: PasswordFailure{
		StatusCode: status, Code: wire.Code, Message: expectedMessage, RetryAfter: values[0],
	}}
}
