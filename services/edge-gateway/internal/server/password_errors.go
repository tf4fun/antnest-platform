package server

import (
	"net/http"

	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/identity"
)

func writePasswordAdmissionError(response http.ResponseWriter, err error) bool {
	failure, ok := identity.PasswordAdmissionFailure(err)
	if !ok {
		return false
	}
	response.Header().Set("Retry-After", failure.RetryAfter)
	response.Header().Set("Cache-Control", "no-store")
	writeJSON(response, failure.StatusCode, struct {
		Code      string `json:"code"`
		Message   string `json:"message"`
		Retryable bool   `json:"retryable"`
	}{Code: failure.Code, Message: failure.Message, Retryable: true})
	return true
}
