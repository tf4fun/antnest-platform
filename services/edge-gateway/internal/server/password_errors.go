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
	writeError(response, failure.StatusCode, failure.Code, failure.Message)
	return true
}
